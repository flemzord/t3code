import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import { describe } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BoatClient from "./BoatClient.ts";

const sandboxId = "bx_23456789";
const origin = "https://swift-otter-9021-3773.on.boat.dev";
const setup = (
  options: {
    status?: number;
    returnedId?: string;
    identity?: string;
    authenticated?: boolean;
    wsStatus?: string;
    truncated?: boolean;
    deletionCompleted?: boolean;
  } = {},
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const commands: string[] = [];
  const http = HttpClient.make((request) => {
    requests.push(request);
    let response: unknown = {};
    const body =
      request.body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(request.body.body)) as { command?: string })
        : {};
    if (request.url.includes("/commands")) {
      const command = body.command ?? "";
      commands.push(command);
      response = {
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdoutTruncated: options.truncated ?? false,
        stdout: command.includes("systemctl")
          ? JSON.stringify({ environmentId: "fresh-identity" })
          : command.includes("write-out")
            ? (options.wsStatus ?? "401")
            : "",
      };
    } else if (request.url.endsWith("/.well-known/t3/environment"))
      response = { environmentId: options.identity ?? "fresh-identity" };
    else if (request.url.endsWith("/api/auth/session"))
      response = { authenticated: options.authenticated ?? false };
    else if (request.url.endsWith("/host")) response = { ok: true, url: origin };
    else if (request.url.includes("/files?"))
      response = {
        ok: true,
        encoding: "utf8",
        content: JSON.stringify({ pairUrl: `${origin}/pair#token=fresh-pair-secret` }),
      };
    else if (request.url.includes("/deletion-operations/"))
      response = {
        ok: true,
        operation: { id: "bdop_1", status: options.deletionCompleted ? "completed" : "pending" },
      };
    else if (request.method === "DELETE")
      response = { ok: true, operation: { id: "bdop_1", status: "pending" } };
    else
      response = {
        ok: true,
        sandbox: { id: options.returnedId ?? sandboxId, state: "provisioning" },
      };
    const status = options.status ?? (request.method === "DELETE" ? 202 : 200);
    if (status >= 400)
      response = {
        ok: false,
        message: "boat_secret_should_never_escape",
        error: { details: { token: "provider-secret" } },
      };
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response, { status })));
  });
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedSome(new TextEncoder().encode("boat_secret_key")),
    set: () => Effect.void,
    create: () => Effect.void,
    remove: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  });
  return {
    requests,
    commands,
    layer: BoatClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets),
        ),
      ),
    ),
  };
};

describe("BoatClient", () => {
  it.effect("uses the documented saved-template body and stable idempotency header", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatClient.BoatClient;
      yield* boat.create({
        provider: "boat",
        requestId: "request-1",
        name: "Work",
        templateId: "clean-t3",
        machineType: "small",
        ttlSeconds: 7200,
      });
      const request = fixture.requests[0]!;
      assert.strictEqual(request.url, "https://boat.dev/api/v1/sandboxes");
      assert.strictEqual(request.headers["idempotency-key"], "t3-request-1");
      assert.strictEqual(request.headers.authorization, "Bearer boat_secret_key");
      assert.deepStrictEqual(
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null,
        {
          from: "clean-t3",
          name: "Work",
          type: "small",
          ttlSeconds: 7200,
          noEnv: true,
          snapshots: true,
          monitoring: false,
        },
      );
    }).pipe(Effect.provide(fixture.layer));
  });
  it.effect(
    "validates a replacement credential through read-only resource access without replacing the saved key",
    () => {
      const fixture = setup();
      return Effect.gen(function* () {
        const boat = yield* BoatClient.BoatClient;
        yield* boat.validateCredential!("boat_candidate_secret", [sandboxId, sandboxId]);
        assert.deepStrictEqual(
          fixture.requests.map((request) => [
            request.method,
            request.url,
            request.headers.authorization,
          ]),
          [
            [
              "GET",
              `https://boat.dev/api/v1/sandboxes/${sandboxId}`,
              "Bearer boat_candidate_secret",
            ],
            [
              "GET",
              `https://boat.dev/api/v1/sandboxes/${sandboxId}`,
              "Bearer boat_candidate_secret",
            ],
          ],
        );
        yield* boat.observe(sandboxId);
        assert.strictEqual(fixture.requests[2]!.headers.authorization, "Bearer boat_secret_key");
      }).pipe(Effect.provide(fixture.layer));
    },
  );
  it.effect(
    "rejects a replacement credential whose resource response has the wrong identity",
    () => {
      const fixture = setup({ returnedId: "bx_wrongid1" });
      return Effect.gen(function* () {
        const boat = yield* BoatClient.BoatClient;
        const result = yield* Effect.result(
          boat.validateCredential!("boat_candidate_secret", [sandboxId]),
        );
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(fixture.layer));
    },
  );
  it.effect("keeps accepted deletion pending until its operation completes", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatClient.BoatClient;
      assert.strictEqual(yield* boat.remove(sandboxId), "bdop_1");
      assert.isFalse(yield* boat.deletion("bdop_1"));
      assert.strictEqual(fixture.requests[0]?.headers["x-ascii-confirm-delete"], sandboxId);
      assert.strictEqual(
        fixture.requests[1]?.url,
        "https://boat.dev/api/v1/deletion-operations/bdop_1",
      );
    }).pipe(Effect.provide(fixture.layer));
  });
  it.effect("redacts provider bodies and request credentials from categorized failures", () => {
    const fixture = setup({ status: 401 });
    return Effect.gen(function* () {
      const boat = yield* BoatClient.BoatClient;
      const result = yield* Effect.result(boat.observe(sandboxId));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.strictEqual(result.failure.category, "authentication");
      assert.notInclude(JSON.stringify(result.failure), "boat_secret");
      assert.notInclude(JSON.stringify(result.failure), "provider-secret");
    }).pipe(Effect.provide(fixture.layer));
  });
  it.effect(
    "verifies identity and auth before retrieving a fresh pairing file and deleting it",
    () => {
      const fixture = setup();
      return Effect.gen(function* () {
        const boat = yield* BoatClient.BoatClient;
        assert.deepStrictEqual(yield* boat.connect(sandboxId), {
          type: "pairing",
          url: `${origin}/pair#token=fresh-pair-secret`,
        });
        assert.isTrue(fixture.commands.some((command) => command.includes("flock -x 9")));
        assert.isTrue(
          fixture.commands.some((command) => command.includes("orchestrationProtocol=2")),
        );
        const pairCommand = fixture.commands.find((command) =>
          command.includes("auth pairing create"),
        );
        assert.include(pairCommand, "--ttl 5m --json >");
        assert.include(pairCommand, "T3CODE_HOME=");
        assert.deepStrictEqual(
          fixture.requests
            .filter((request) => request.url.includes("/files?"))
            .map((request) => request.method),
          ["GET", "DELETE"],
        );
        assert.isFalse(fixture.commands.some((command) => command.includes("fresh-pair-secret")));
      }).pipe(Effect.provide(fixture.layer));
    },
  );
  it.effect.each([
    { identity: "wrong-identity" },
    { authenticated: true },
    { wsStatus: "426" },
    { truncated: true },
  ])("refuses pairing when route proof fails: %j", (options) => {
    const fixture = setup(options);
    return Effect.gen(function* () {
      const boat = yield* BoatClient.BoatClient;
      assert.strictEqual((yield* Effect.result(boat.connect(sandboxId)))._tag, "Failure");
      assert.isFalse(fixture.commands.some((command) => command.includes("auth pairing create")));
    }).pipe(Effect.provide(fixture.layer));
  });
});
