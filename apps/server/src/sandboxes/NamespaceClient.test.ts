import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as NamespaceClient from "./NamespaceClient.ts";
import { namespaceBootstrapScript, namespaceVerificationScript } from "./namespaceBootstrap.ts";

const id = "dbx1234";
const name = "t3-request-1";
const claims = { tenant_id: "tenant-1", actor_id: "actor-1" };
const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const input = {
  provider: "namespace" as const,
  requestId: "request-1",
  name: "Work",
  templateId: "builtin:default",
  machineType: "small" as const,
  ttlSeconds: 7200,
};
const decodeCreatedImage = Schema.decodeUnknownEffect(
  Schema.Struct({
    name: Schema.String,
    imageRef: Schema.String,
    instanceShape: Schema.Struct({ virtualCpu: Schema.Number }),
  }),
);
const setup = (
  options: {
    status?: number;
    missing?: boolean;
    running?: boolean;
    malformed?: boolean;
    cliMissing?: boolean;
    cliFailure?: string;
    mismatch?: boolean;
    labels?: ReadonlyArray<{ name: string; value: string }>;
    sshIdentity?: string;
    responseId?: string;
    responseIds?: readonly string[];
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${home}/.config/ns`, { recursive: true });
    const localClaims = options.mismatch ? { ...claims, actor_id: "someone-else" } : claims;
    yield* fs.writeFileString(
      `${home}/.config/ns/token.json`,
      JSON.stringify({
        session_token: `header.${Buffer.from(JSON.stringify(localClaims)).toString("base64url")}.signature`,
      }),
    );
    const requests: Array<{
      method: string;
      body: unknown;
      headers: HttpClientRequest.HttpClientRequest["headers"];
    }> = [];
    const processes: ProcessRunner.ProcessRunInput[] = [];
    const tokenFiles: string[] = [];
    const http = HttpClient.make((request) => {
      const method = request.url.split("/").at(-1)!;
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null;
      requests.push({ method, body, headers: request.headers });
      const status = options.status ?? (options.missing && method === "Fetch" ? 404 : 200);
      const response =
        status >= 400
          ? { code: status === 404 ? "not_found" : "unauthenticated", message: token }
          : options.malformed
            ? {}
            : {
                devbox: {
                  id: options.responseIds?.[requests.length - 1] ?? options.responseId ?? id,
                  name,
                  labels: options.labels ?? [],
                },
                ...(options.running === false ? {} : { instanceId: "instance-1" }),
              };
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(response, { status })),
      );
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: (process) =>
        Effect.gen(function* () {
          processes.push(process);
          if (options.cliMissing)
            return yield* new ProcessRunner.ProcessSpawnError({
              command: "devbox",
              argumentCount: 1,
              cause: new Error(token),
            });
          const file = process.env?.NSC_TOKEN_FILE;
          if (file) {
            tokenFiles.push(file);
            assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(file).pipe(Effect.orDie)), {
              bearer_token: token,
            });
            assert.strictEqual((yield* fs.stat(file).pipe(Effect.orDie)).mode & 0o777, 0o600);
          } else {
            for (const filename of tokenFiles)
              assert.isFalse(yield* fs.exists(filename).pipe(Effect.orDie));
          }
          return {
            stdout:
              process.command === "ssh" || process.args[0] === "exec"
                ? JSON.stringify({
                    environmentId:
                      process.command === "ssh"
                        ? (options.sshIdentity ?? "environment-1")
                        : "environment-1",
                    owner: id,
                  })
                : "",
            stderr: options.cliFailure === process.args[0] ? token : "",
            code: ChildProcessSpawner.ExitCode(options.cliFailure === process.args[0] ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const secrets = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedSome(new TextEncoder().encode(token)),
      set: () => Effect.void,
      create: () => Effect.void,
      remove: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    });
    const layer = NamespaceClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets),
          Layer.succeed(ProcessRunner.ProcessRunner, runner),
          NodeServices.layer,
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.HomeDirectory, home),
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.succeed(HostProcess.Environment, {}),
        ),
      ),
    );
    return { layer, requests, processes, tokenFiles, fs };
  }).pipe(Effect.provide(NodeServices.layer));

describe("NamespaceClient", () => {
  it.effect(
    "validates every known resource with a candidate credential without rotating the saved key",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({ responseIds: [id, "dbx5678"] });
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          yield* client.validateCredential!("candidate-key", [id, "dbx5678"]);
          assert.lengthOf(fixture.requests, 2);
          for (const [index, request] of fixture.requests.entries()) {
            assert.strictEqual(request.method, "Fetch");
            assert.strictEqual(request.headers.authorization, "Bearer candidate-key");
            assert.deepStrictEqual(request.body, {
              idOrName: index === 0 ? id : "dbx5678",
              returnActivatedInstance: true,
            });
          }
          yield* client.observe(id);
          assert.strictEqual(fixture.requests[2]!.headers.authorization, `Bearer ${token}`);
        }).pipe(Effect.provide(fixture.layer));
        const different = yield* setup({ responseId: "other-resource" });
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          const result = yield* Effect.result(client.validateCredential!("candidate-key", [id]));
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure.category, "forbidden");
        }).pipe(Effect.provide(different.layer));
      }),
  );
  it.effect(
    "recovers an acknowledged request only through its deterministic name and ownership labels",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({
          labels: [
            { name: "t3-request-id", value: input.requestId },
            { name: "t3-provider", value: "namespace" },
          ],
        });
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          assert.deepStrictEqual(yield* client.recoverCreation!(input), { id, state: "running" });
          assert.deepStrictEqual(
            fixture.requests.map((request) => request.method),
            ["Fetch"],
          );
          assert.deepStrictEqual(fixture.requests[0]!.body, {
            idOrName: name,
            returnActivatedInstance: true,
          });
        }).pipe(Effect.provide(fixture.layer));
        for (const options of [
          {},
          {
            labels: [
              { name: "t3-request-id", value: "different-request" },
              { name: "t3-provider", value: "namespace" },
            ],
          },
        ]) {
          const foreign = yield* setup(options);
          yield* Effect.gen(function* () {
            const client = yield* NamespaceClient.NamespaceClient;
            const result = yield* Effect.result(client.recoverCreation!(input));
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure") assert.strictEqual(result.failure.category, "conflict");
            assert.deepStrictEqual(
              foreign.requests.map((request) => request.method),
              ["Fetch"],
            );
          }).pipe(Effect.provide(foreign.layer));
        }
        const absent = yield* setup({ missing: true });
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          assert.isNull(yield* client.recoverCreation!(input));
          assert.deepStrictEqual(
            absent.requests.map((request) => request.method),
            ["Fetch"],
          );
        }).pipe(Effect.provide(absent.layer));
      }),
  );
  it.effect("resumes through readiness activation without invoking the CLI", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* Effect.gen(function* () {
        const client = yield* NamespaceClient.NamespaceClient;
        yield* client.resume(id, 7200);
        assert.deepStrictEqual(
          fixture.requests.map((request) => request.method),
          ["Activate"],
        );
        assert.deepStrictEqual(fixture.requests[0]!.body, { idOrName: id, waitForReadiness: true });
        assert.lengthOf(fixture.processes, 0);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
  it.effect("rejects an SSH alias that resolves to a different environment", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ sshIdentity: "other-environment" });
      yield* Effect.gen(function* () {
        const client = yield* NamespaceClient.NamespaceClient;
        const result = yield* Effect.result(client.connect(id));
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.category, "connection");
        for (const filename of fixture.tokenFiles)
          assert.isFalse(yield* fixture.fs.exists(filename));
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
  it.effect(
    "creates a clean persistent image with explicit shape and stable request identity",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup();
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          assert.strictEqual(client.creationReplayWindowMs, 0);
          assert.deepStrictEqual(yield* client.create(input), { id, state: "running" });
          const request = fixture.requests[0]!;
          assert.strictEqual(request.method, "Create");
          assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
          assert.deepStrictEqual(request.body, {
            name,
            imageName: "builtin:default",
            instanceShape: {
              virtualCpu: 4,
              memoryMegabytes: 8192,
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
          });
          assert.lengthOf(fixture.processes, 0);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
  it.effect(
    "observes stopped state without activation and confirms deletion only after absence",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({ running: false });
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          assert.deepStrictEqual(yield* client.observe(id), { id, state: "archived" });
          yield* client.stop(id);
          assert.strictEqual(yield* client.remove(id), id);
          assert.isFalse(yield* client.deletion(id));
          assert.deepStrictEqual(
            fixture.requests.map((request) => request.method),
            ["Fetch", "Fetch", "Stop", "Fetch", "Expire", "Fetch"],
          );
          assert.deepStrictEqual(fixture.requests[2]?.body, { name });
          assert.deepStrictEqual(fixture.requests[4]?.body, { name });
        }).pipe(Effect.provide(fixture.layer));
        const absent = yield* setup({ missing: true });
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          assert.isTrue(yield* client.deletion(id));
        }).pipe(Effect.provide(absent.layer));
      }),
  );
  it.effect(
    "bounds provider names, uses exact image refs and rejects unsupported durations before I/O",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup();
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          yield* client.create({
            ...input,
            requestId: "A_".repeat(64),
            templateId: "registry.example/base@sha256:abc",
            machineType: "xlarge",
          });
          const body = yield* decodeCreatedImage(fixture.requests[0]!.body);
          assert.match(body.name, /^t3-[a-z0-9-]{1,60}$/);
          assert.strictEqual(body.imageRef, "registry.example/base@sha256:abc");
          assert.strictEqual(body.instanceShape.virtualCpu, 32);
          assert.strictEqual(
            (yield* Effect.result(client.create({ ...input, ttlSeconds: 10801 })))._tag,
            "Failure",
          );
          assert.lengthOf(fixture.requests, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
  it.effect.each([{ status: 401 }, { malformed: true }])(
    "fails closed and redacts remote errors: %j",
    (options) =>
      Effect.gen(function* () {
        const fixture = yield* setup(options);
        yield* Effect.gen(function* () {
          const client = yield* NamespaceClient.NamespaceClient;
          const result = yield* Effect.result(client.observe(id));
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.notInclude(JSON.stringify(result.failure), token);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
  it.effect("removes temporary credentials before verifying the persistent SSH route", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* Effect.gen(function* () {
        const client = yield* NamespaceClient.NamespaceClient;
        assert.deepStrictEqual(yield* client.connect(id), {
          type: "ssh",
          target: {
            alias: `${name}.devbox.namespace`,
            hostname: `${name}.devbox.namespace`,
            username: null,
            port: null,
          },
        });
        assert.deepStrictEqual(
          fixture.processes.map((process) => [process.command, process.args[0]]),
          [
            ["devbox", "auth"],
            ["devbox", "exec"],
            ["devbox", "configure-ssh"],
            ["ssh", "-o"],
          ],
        );
        for (const process of fixture.processes) {
          assert.notInclude(JSON.stringify(process.args), token);
          assert.notInclude(process.stdin ?? "", token);
        }
        for (const filename of fixture.tokenFiles)
          assert.isFalse(yield* fixture.fs.exists(filename));
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
  it.effect.each([
    { cliMissing: true },
    { cliFailure: "exec" },
    { cliFailure: "configure-ssh" },
    { mismatch: true },
  ])("refuses unavailable or mismatched CLI routes: %j", (options) =>
    Effect.gen(function* () {
      const fixture = yield* setup(options);
      yield* Effect.gen(function* () {
        const client = yield* NamespaceClient.NamespaceClient;
        const result = yield* Effect.result(client.connect(id));
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.notInclude(JSON.stringify(result.failure), token);
        assert.isFalse(fixture.processes.some((process) => process.command === "ssh"));
        for (const filename of fixture.tokenFiles)
          assert.isFalse(yield* fixture.fs.exists(filename));
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});

it.live(
  "bootstrap refuses existing default T3 state and foreign owners before privileged changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const bin = `${home}/bin`;
      yield* fs.makeDirectory(bin);
      for (const [name, script] of Object.entries({
        id: '#!/bin/sh\nif [ "$1" = "-un" ]; then printf fixture; else printf 1000; fi\n',
        getent: '#!/bin/sh\nprintf "fixture:x:1000:1000::%s:/bin/sh\\n" "$HOME"\n',
        flock: "#!/bin/sh\nexit 0\n",
        sudo: '#!/bin/sh\ntouch "$HOME/unexpected-privileged-action"\nexit 1\n',
      })) {
        yield* fs.writeFileString(`${bin}/${name}`, script, { mode: 0o700 });
      }
      const runner = yield* ProcessRunner.ProcessRunner;
      yield* fs.makeDirectory(`${home}/.t3`);
      yield* fs.writeFileString(`${home}/.t3/retain`, "existing-data");
      const run = () =>
        runner.run({
          command: "sh",
          args: ["-s"],
          stdin: namespaceBootstrapScript(id),
          env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
        });
      assert.strictEqual((yield* run()).code, 42);
      assert.strictEqual(yield* fs.readFileString(`${home}/.t3/retain`), "existing-data");
      assert.isFalse(yield* fs.exists(`${home}/unexpected-privileged-action`));
      yield* fs.writeFileString(`${home}/.t3-namespace-owner`, "foreign-owner");
      assert.strictEqual((yield* run()).code, 41);
      assert.strictEqual(yield* fs.readFileString(`${home}/.t3-namespace-owner`), "foreign-owner");
      assert.isFalse(yield* fs.exists(`${home}/unexpected-privileged-action`));
    }).pipe(Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))),
);

it.live("SSH verification refuses a runtime that is not the systemd service process", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${home}/bin`);
    yield* fs.makeDirectory(`${home}/.t3/userdata`, { recursive: true });
    yield* fs.writeFileString(`${home}/.t3-namespace-owner`, id);
    yield* fs.writeFileString(`${home}/bin/systemctl`, "#!/bin/sh\nprintf 1\n", { mode: 0o700 });
    yield* fs.writeFileString(
      `${home}/.t3/userdata/server-runtime.json`,
      JSON.stringify({ pid: process.pid, origin: "http://127.0.0.1:3773" }),
    );
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({
      command: "sh",
      args: ["-s"],
      stdin: namespaceVerificationScript(id),
      env: {
        HOME: home,
        PATH: `${home}/bin:${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
      },
    });
    assert.strictEqual(result.code, 45);
    assert.strictEqual(result.stdout, "");
  }).pipe(Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))),
);
