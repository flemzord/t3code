import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  SandboxOperationError,
  type SandboxCreateInput,
  type SandboxErrorCategory,
} from "@t3tools/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { bootstrapScript, pairingScript } from "./bootstrap.ts";

import { ProviderObservation, type SandboxProviderClient } from "./SandboxProvider.ts";
const isOperationError = Schema.is(SandboxOperationError);
const SandboxEnvelope = Schema.Struct({ ok: Schema.Literal(true), sandbox: ProviderObservation });
const CommandResult = Schema.Struct({
  ok: Schema.Literal(true),
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  timedOut: Schema.Boolean,
  stdoutTruncated: Schema.optionalKey(Schema.Boolean),
});
const HostResult = Schema.Struct({ ok: Schema.Literal(true), url: Schema.String });
const DeletionResult = Schema.Struct({
  ok: Schema.Literal(true),
  operation: Schema.Struct({ id: Schema.String, status: Schema.String }),
});
const Descriptor = Schema.Struct({ environmentId: Schema.String });
export class BoatClient extends Context.Service<BoatClient, SandboxProviderClient>()(
  "t3/sandboxes/BoatClient",
) {}
const decodeDescriptor = Schema.decodeEffect(Schema.fromJsonString(Descriptor));
const decodePairing = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ pairUrl: Schema.String })),
);
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
const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const request = Effect.fn("BoatClient.request")(function* <A, I>(
    method: "GET" | "POST" | "DELETE",
    route: string,
    schema: Schema.Codec<A, I>,
    body?: unknown,
    headers?: Record<string, string>,
    credentialOverride?: string,
  ) {
    const key =
      credentialOverride === undefined
        ? yield* secrets
            .get("boat-api-key")
            .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })))
        : Option.some(new TextEncoder().encode(credentialOverride));
    if (Option.isNone(key)) return yield* new SandboxOperationError({ category: "not_configured" });
    let req = HttpClientRequest.make(method)(`https://boat.dev/api/v1${route}`).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${new TextDecoder().decode(key.value)}`,
        ...headers,
      }),
    );
    if (body !== undefined)
      req = yield* HttpClientRequest.bodyJson(req, body).pipe(
        Effect.mapError(() => new SandboxOperationError({ category: "invalid_input" })),
      );
    return yield* http.execute(req).pipe(
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
  const create = Effect.fn("BoatClient.create")(function* (input: SandboxCreateInput) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.templateId))
      return yield* new SandboxOperationError({ category: "invalid_input" });
    const result = yield* request(
      "POST",
      "/sandboxes",
      SandboxEnvelope,
      {
        from: input.templateId,
        name: input.name,
        type: input.machineType,
        ttlSeconds: input.ttlSeconds,
        noEnv: true,
        snapshots: true,
        monitoring: false,
      },
      { "Idempotency-Key": `t3-${input.requestId}` },
    );
    return result.sandbox;
  });
  const observe = Effect.fn("BoatClient.observe")(function* (id: string) {
    return (yield* request("GET", `/sandboxes/${encodeURIComponent(id)}`, SandboxEnvelope)).sandbox;
  });
  const validateCredential = Effect.fn("BoatClient.validateCredential")(function* (
    apiKey: string,
    ids: ReadonlyArray<string>,
  ) {
    for (const id of ids) {
      const result = yield* request(
        "GET",
        `/sandboxes/${encodeURIComponent(id)}`,
        SandboxEnvelope,
        undefined,
        undefined,
        apiKey,
      );
      if (result.sandbox.id !== id)
        return yield* new SandboxOperationError({ category: "forbidden" });
    }
  });
  const stop = Effect.fn("BoatClient.stop")(function* (id: string) {
    yield* request(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/stop`,
      Schema.Struct({ ok: Schema.Literal(true) }),
      {
        force: false,
      },
    );
  });
  const resume = Effect.fn("BoatClient.resume")(function* (id: string, ttlSeconds: number) {
    yield* request(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/resume`,
      Schema.Struct({ ok: Schema.Literal(true) }),
      {
        ttlSeconds,
        noEnv: true,
      },
    );
  });
  const remove = Effect.fn("BoatClient.remove")(function* (id: string) {
    return (yield* request(
      "DELETE",
      `/sandboxes/${encodeURIComponent(id)}`,
      DeletionResult,
      undefined,
      { "X-Ascii-Confirm-Delete": id },
    )).operation.id;
  });
  const deletion = Effect.fn("BoatClient.deletion")(function* (id: string) {
    return (
      (yield* request("GET", `/deletion-operations/${encodeURIComponent(id)}`, DeletionResult))
        .operation.status === "completed"
    );
  });
  const command = Effect.fn("BoatClient.command")(function* (id: string, script: string) {
    const result = yield* request(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/commands`,
      CommandResult,
      { command: script, timeoutSeconds: 600 },
    );
    if (result.exitCode !== 0 || result.timedOut || result.stdoutTruncated)
      return yield* new SandboxOperationError({ category: "bootstrap" });
    return result.stdout;
  });
  const publicJson = Effect.fn("BoatClient.verifyRoute")(function* <A, I>(
    url: string,
    schema: Schema.Codec<A, I>,
  ) {
    return yield* http.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.scoped,
      Effect.timeout("15 seconds"),
      Effect.mapError(() => new SandboxOperationError({ category: "connection" })),
    );
  });
  const connect = Effect.fn("BoatClient.connect")(function* (id: string) {
    if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(id))
      return yield* new SandboxOperationError({ category: "invalid_input" });
    const local = yield* command(id, bootstrapScript(id));
    const identity = yield* decodeDescriptor(local.trim()).pipe(
      Effect.mapError(() => new SandboxOperationError({ category: "bootstrap" })),
    );
    const hosted = yield* request("POST", `/sandboxes/${encodeURIComponent(id)}/host`, HostResult, {
      port: 3773,
      public: true,
      localhost: true,
    });
    const origin = yield* Effect.try({
      try: () => new URL(hosted.url),
      catch: () => new SandboxOperationError({ category: "connection" }),
    });
    if (
      origin.protocol !== "https:" ||
      !/^[-a-z0-9]+\.on\.boat\.dev$/.test(origin.hostname) ||
      origin.port !== "" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    )
      return yield* new SandboxOperationError({ category: "connection" });
    const external = yield* publicJson(`${origin.origin}/.well-known/t3/environment`, Descriptor);
    const auth = yield* publicJson(
      `${origin.origin}/api/auth/session`,
      Schema.Struct({ authenticated: Schema.Boolean }),
    );
    if (external.environmentId !== identity.environmentId || auth.authenticated)
      return yield* new SandboxOperationError({ category: "connection" });
    const wsStatus = yield* command(
      id,
      `curl --silent --max-time 15 --output /dev/null --write-out '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' '${origin.origin}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}'`,
    );
    if (wsStatus !== "401" && wsStatus !== "403")
      return yield* new SandboxOperationError({ category: "connection" });
    const filename = `/home/user/.t3-boat/${id}/pairing.json`;
    yield* command(id, pairingScript(id, origin.origin, filename));
    const fileRoute = `/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(filename)}`;
    const file = yield* request(
      "GET",
      fileRoute,
      Schema.Struct({
        ok: Schema.Literal(true),
        content: Schema.String,
        encoding: Schema.Literal("utf8"),
      }),
    ).pipe(Effect.ensuring(request("DELETE", fileRoute, Schema.Unknown).pipe(Effect.ignore)));
    const pairing = yield* decodePairing(file.content).pipe(
      Effect.mapError(() => new SandboxOperationError({ category: "connection" })),
    );
    const pairUrl = yield* Effect.try({
      try: () => new URL(pairing.pairUrl),
      catch: () => new SandboxOperationError({ category: "connection" }),
    });
    if (
      pairUrl.origin !== origin.origin ||
      pairUrl.pathname !== "/pair" ||
      !new URLSearchParams(pairUrl.hash.slice(1)).get("token") ||
      pairUrl.search ||
      pairUrl.username ||
      pairUrl.password
    )
      return yield* new SandboxOperationError({ category: "connection" });
    return { type: "pairing" as const, url: pairUrl.toString() };
  });
  return BoatClient.of({
    creationReplayWindowMs: 23 * 60 * 60 * 1000,
    validateCredential,
    create,
    observe,
    stop,
    resume,
    remove,
    deletion,
    connect,
  });
});
export const layer = Layer.effect(BoatClient, make);
