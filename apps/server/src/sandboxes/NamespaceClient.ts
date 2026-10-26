import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  SandboxOperationError,
  type SandboxCreateInput,
  type SandboxErrorCategory,
} from "@t3tools/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { SandboxProviderClient } from "./SandboxProvider.ts";
import { namespaceBootstrapScript, namespaceVerificationScript } from "./namespaceBootstrap.ts";

const endpoint =
  "https://private-api.iad.namespaceapis.com/namespace.private.devbox.v1beta.DevBoxService";
const Devbox = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  labels: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  ),
});
const DevboxResponse = Schema.Struct({
  devbox: Devbox,
  instanceId: Schema.optionalKey(Schema.String),
});
const Descriptor = Schema.Struct({
  environmentId: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
});
const TokenFile = Schema.Struct({
  bearer_token: Schema.optionalKey(Schema.String),
  session_token: Schema.optionalKey(Schema.String),
});
const TokenClaims = Schema.Struct({
  tenant_id: Schema.NonEmptyString,
  actor_id: Schema.NonEmptyString,
});
const machineCpu = { small: 4, default: 8, large: 16, xlarge: 32 };
const isOperationError = Schema.is(SandboxOperationError);
const decodeDescriptor = Schema.decodeEffect(Schema.fromJsonString(Descriptor));
const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));
const decodeTokenClaims = Schema.decodeEffect(Schema.fromJsonString(TokenClaims));
const encodeTokenFile = Schema.encodeSync(Schema.fromJsonString(TokenFile));

export class NamespaceClient extends Context.Service<
  NamespaceClient,
  SandboxProviderClient & {
    readonly validateCredential: (
      apiKey: string,
      ids: readonly string[],
    ) => Effect.Effect<void, SandboxOperationError>;
  }
>()("t3/sandboxes/NamespaceClient") {}

const categoryForStatus = (status: number): SandboxErrorCategory => {
  switch (status) {
    case 400:
      return "invalid_input";
    case 401:
      return "authentication";
    case 402:
      return "billing";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    default:
      return "uncertain";
  }
};
const validDuration = (seconds: number) =>
  Number.isInteger(seconds) && seconds > 0 && seconds <= 10800;
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const observation = (response: typeof DevboxResponse.Type) => ({
  id: response.devbox.id,
  state: response.instanceId ? "running" : "archived",
});

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const credential = Effect.fn("NamespaceClient.credential")(function* () {
    const key = yield* secrets
      .get("namespace-api-key")
      .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })));
    if (Option.isNone(key)) return yield* new SandboxOperationError({ category: "not_configured" });
    const token = new TextDecoder().decode(key.value);
    if (!token.trim() || /[\r\n]/.test(token))
      return yield* new SandboxOperationError({ category: "authentication" });
    return token;
  });
  const request = Effect.fn("NamespaceClient.request")(function* <A, I>(
    method: string,
    body: unknown,
    schema: Schema.Codec<A, I>,
    candidateToken?: string,
  ) {
    const token = candidateToken ?? (yield* credential());
    if (!token.trim() || token.length > 4096 || /[\r\n]/.test(token))
      return yield* new SandboxOperationError({ category: "authentication" });
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(`${endpoint}/${method}`).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${token}` }),
      ),
      body,
    ).pipe(Effect.mapError(() => new SandboxOperationError({ category: "invalid_input" })));
    return yield* http.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? HttpClientResponse.schemaBodyJson(schema)(response).pipe(
              Effect.mapError(() => new SandboxOperationError({ category: "uncertain" })),
            )
          : Effect.fail(
              new SandboxOperationError({ category: categoryForStatus(response.status) }),
            ),
      ),
      Effect.scoped,
      Effect.timeout("11 minutes"),
      Effect.mapError((error) =>
        isOperationError(error) ? error : new SandboxOperationError({ category: "uncertain" }),
      ),
    );
  });
  const fetch = Effect.fn("NamespaceClient.fetch")(function* (id: string, candidateToken?: string) {
    if (!validId(id)) return yield* new SandboxOperationError({ category: "invalid_input" });
    return yield* request(
      "Fetch",
      { idOrName: id, returnActivatedInstance: true },
      DevboxResponse,
      candidateToken,
    );
  });
  const validateCredential = Effect.fn("NamespaceClient.validateCredential")(function* (
    apiKey: string,
    ids: readonly string[],
  ) {
    if (!apiKey.trim() || apiKey.length > 4096 || /[\r\n]/.test(apiKey))
      return yield* new SandboxOperationError({ category: "authentication" });
    for (const id of ids) {
      const response = yield* fetch(id, apiKey);
      if (response.devbox.id !== id)
        return yield* new SandboxOperationError({ category: "forbidden" });
    }
  });
  const providerName = Effect.fn("NamespaceClient.providerName")(function* (requestId: string) {
    if (/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(requestId)) return `t3-${requestId}`;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(requestId))
      .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })));
    return `t3-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 60)}`;
  });
  const create = Effect.fn("NamespaceClient.create")(function* (input: SandboxCreateInput) {
    if (
      !validDuration(input.ttlSeconds) ||
      !input.templateId.trim() ||
      input.templateId.startsWith("blueprint:")
    )
      return yield* new SandboxOperationError({ category: "invalid_input" });
    const name = yield* providerName(input.requestId);
    const vCpu = machineCpu[input.machineType];
    const image = input.templateId;
    return observation(
      yield* request(
        "Create",
        {
          name,
          ...(image.startsWith("builtin:") || !/[/@:]/.test(image)
            ? { imageName: image }
            : { imageRef: image }),
          instanceShape: {
            virtualCpu: vCpu,
            memoryMegabytes: vCpu * 2048,
            machineArch: "amd64",
            os: "linux",
          },
          site: "iad",
          versionControl: {},
          accessMode: "USER_PRIVATE",
          activate: true,
          labels: [
            { name: "t3-request-id", value: input.requestId },
            { name: "t3-provider", value: "namespace" },
          ],
        },
        DevboxResponse,
      ),
    );
  });
  const recoverCreation = Effect.fn("NamespaceClient.recoverCreation")(function* (
    input: SandboxCreateInput,
  ) {
    const name = yield* providerName(input.requestId);
    const response = yield* fetch(name).pipe(
      Effect.catchTags({
        SandboxOperationError: (error) =>
          error.category === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (!response) return null;
    if (
      response.devbox.name !== name ||
      !response.devbox.labels?.some(
        (label) => label.name === "t3-request-id" && label.value === input.requestId,
      ) ||
      !response.devbox.labels?.some(
        (label) => label.name === "t3-provider" && label.value === "namespace",
      )
    )
      return yield* new SandboxOperationError({ category: "conflict" });
    return observation(response);
  });
  const observe = Effect.fn("NamespaceClient.observe")(function* (id: string) {
    return observation(yield* fetch(id));
  });
  const stop = Effect.fn("NamespaceClient.stop")(function* (id: string) {
    const current = yield* fetch(id);
    yield* request("Stop", { name: current.devbox.name }, DevboxResponse);
  });
  const resume = Effect.fn("NamespaceClient.resume")(function* (id: string, ttlSeconds: number) {
    if (!validDuration(ttlSeconds))
      return yield* new SandboxOperationError({ category: "invalid_input" });
    if (!validId(id)) return yield* new SandboxOperationError({ category: "invalid_input" });
    yield* request("Activate", { idOrName: id, waitForReadiness: true }, DevboxResponse);
  });
  const remove = Effect.fn("NamespaceClient.remove")(function* (id: string) {
    const current = yield* fetch(id).pipe(
      Effect.catchTags({
        SandboxOperationError: (error) =>
          error.category === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (current) yield* request("Expire", { name: current.devbox.name }, Schema.Unknown);
    return id;
  });
  const deletion = Effect.fn("NamespaceClient.deletion")(function* (id: string) {
    return yield* fetch(id).pipe(
      Effect.as(false),
      Effect.catchTags({
        SandboxOperationError: (error) =>
          error.category === "not_found" ? Effect.succeed(true) : Effect.fail(error),
      }),
    );
  });
  const run = Effect.fn("NamespaceClient.run")(function* (
    command: string,
    args: readonly string[],
    tokenFile: string,
    category: SandboxErrorCategory,
    stdin?: string,
  ) {
    const result = yield* runner
      .run({
        command,
        args,
        stdin,
        env: { NSC_TOKEN_FILE: tokenFile, NSC_DEBUG: "" },
        maxOutputBytes: 16384,
        timeout: "11 minutes",
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new SandboxOperationError({
              category: error._tag === "ProcessSpawnError" ? "unavailable" : category,
            }),
        ),
      );
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.stdoutInvalidUtf8
    )
      return yield* new SandboxOperationError({ category });
    return result.stdout;
  });
  const claims = Effect.fn("NamespaceClient.claims")(function* (token: string) {
    return yield* Effect.try(() =>
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ).pipe(
      Effect.flatMap(decodeTokenClaims),
      Effect.mapError(() => new SandboxOperationError({ category: "unavailable" })),
    );
  });
  const connect = Effect.fn("NamespaceClient.connect")(function* (id: string) {
    const current = yield* fetch(id);
    if (!/^t3-[a-z0-9-]{1,60}$/.test(current.devbox.name) || environment.NSC_TOKEN_FILE)
      return yield* new SandboxOperationError({ category: "unavailable" });
    const token = yield* credential();
    const configDir =
      platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : platform === "win32"
          ? (environment.APPDATA ?? path.join(home, "AppData", "Roaming"))
          : (environment.XDG_CONFIG_HOME ?? path.join(home, ".config"));
    const local = yield* fs.readFileString(path.join(configDir, "ns", "token.json")).pipe(
      Effect.flatMap(decodeTokenFile),
      Effect.mapError(() => new SandboxOperationError({ category: "unavailable" })),
    );
    const expected = yield* claims(token);
    const actual = yield* claims(local.session_token ?? local.bearer_token ?? "");
    if (actual.tenant_id !== expected.tenant_id || actual.actor_id !== expected.actor_id)
      return yield* new SandboxOperationError({ category: "unavailable" });
    yield* run("devbox", ["auth", "check-login", "--duration", "5m"], "", "unavailable");
    const descriptor = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-namespace-" })
          .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })));
        const filename = path.join(directory, "token.json");
        yield* fs
          .chmod(directory, 0o700)
          .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })));
        yield* fs
          .writeFileString(filename, encodeTokenFile({ bearer_token: token }), {
            flag: "wx",
            mode: 0o600,
          })
          .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })));
        const output = yield* run(
          "devbox",
          ["exec", current.devbox.name, "--", "sh", "-c", namespaceBootstrapScript(id)],
          filename,
          "bootstrap",
        );
        const descriptor = yield* decodeDescriptor(output.trim()).pipe(
          Effect.mapError(() => new SandboxOperationError({ category: "bootstrap" })),
        );
        if (descriptor.owner !== id)
          return yield* new SandboxOperationError({ category: "bootstrap" });
        yield* run("devbox", ["configure-ssh", current.devbox.name], filename, "connection");
        return descriptor;
      }),
    );
    const alias = `${current.devbox.name}.devbox.namespace`;
    const output = yield* run(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", alias, "sh", "-s"],
      "",
      "connection",
      namespaceVerificationScript(id),
    );
    const remote = yield* decodeDescriptor(output.trim()).pipe(
      Effect.mapError(() => new SandboxOperationError({ category: "connection" })),
    );
    if (remote.owner !== id || remote.environmentId !== descriptor.environmentId)
      return yield* new SandboxOperationError({ category: "connection" });
    return { type: "ssh" as const, target: { alias, hostname: alias, username: null, port: null } };
  });
  return NamespaceClient.of({
    creationReplayWindowMs: 0,
    validateCredential,
    recoverCreation,
    create,
    observe,
    stop,
    resume,
    remove,
    deletion,
    connect,
  });
});
export const layer = Layer.effect(NamespaceClient, make);
