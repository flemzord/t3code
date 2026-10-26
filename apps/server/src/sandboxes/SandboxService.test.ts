import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";
import { SandboxOperationError } from "@t3tools/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BoatClient from "./BoatClient.ts";
import * as SandboxProviders from "./SandboxProviders.ts";
import * as SandboxStore from "./SandboxStore.ts";
import * as SandboxService from "./SandboxService.ts";

const encodeOperationError = Schema.encodeSync(SandboxOperationError);
const input = {
  provider: "boat" as const,
  requestId: "request-1",
  name: "Work",
  templateId: "clean-t3",
  machineType: "default" as const,
  ttlSeconds: 3600,
};
const setup = (
  initial: ReadonlyArray<SandboxStore.StoredSandbox> = [],
  overrides: Partial<BoatClient.BoatClient["Service"]> = {},
) => {
  let records = initial;
  let createCount = 0;
  let stopCount = 0;
  let failCreate = false;
  let stopCompleted = false;
  let deletionCompleted = false;
  let deleteCount = 0;
  let failSave = false;
  const secrets = new Map<string, Uint8Array>();
  const boat = BoatClient.BoatClient.of({
    creationReplayWindowMs: 23 * 60 * 60 * 1000,
    create: () =>
      Effect.gen(function* () {
        createCount++;
        assert.isTrue(records.some((record) => record.state === "provisioning"));
        if (failCreate) return yield* new SandboxOperationError({ category: "uncertain" });
        return { id: "bx_23456789", state: "ready", stop: null };
      }),
    observe: () =>
      Effect.succeed({
        id: "bx_23456789",
        state: stopCompleted ? "archived" : "ready",
        stop: stopCompleted
          ? { id: "stop_1", status: "completed" }
          : stopCount > 0
            ? { id: "stop_1", status: "pending" }
            : null,
      }),
    stop: () =>
      Effect.sync(() => {
        stopCount++;
      }),
    resume: () => Effect.void,
    remove: () =>
      Effect.sync(() => {
        deleteCount++;
        return "bdop_1";
      }),
    deletion: () => Effect.sync(() => deletionCompleted),
    connect: () =>
      Effect.succeed({ type: "pairing" as const, url: "https://sandbox.on.boat.dev/#pair=test" }),
    ...overrides,
  });
  const store = SandboxStore.SandboxStore.of({
    load: Effect.sync(() => records),
    save: (next) =>
      Effect.suspend(() =>
        failSave
          ? Effect.fail(new SandboxOperationError({ category: "storage" }))
          : Effect.sync(() => {
              records = next;
            }),
      ),
  });
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value);
      }),
    create: () => Effect.void,
    remove: (name) =>
      Effect.sync(() => {
        secrets.delete(name);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  });
  return {
    layer: SandboxService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SandboxProviders.SandboxProviders, { get: () => boat }),
          Layer.succeed(SandboxStore.SandboxStore, store),
          Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
    secret: (provider: string) => {
      const key = secrets.get(`${provider}-api-key`);
      return key ? new TextDecoder().decode(key) : null;
    },
    get records() {
      return records;
    },
    get createCount() {
      return createCount;
    },
    get deleteCount() {
      return deleteCount;
    },
    completeDeletion: () => {
      deletionCompleted = true;
    },
    failSave: () => {
      failSave = true;
    },
    get stopCount() {
      return stopCount;
    },
    failCreate: () => {
      failCreate = true;
    },
    completeStop: () => {
      stopCompleted = true;
    },
  };
};

describe("SandboxService", () => {
  it.effect("persists intent before creating and deduplicates caller request IDs", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
      yield* service.create(input);
      yield* service.refresh({ id: `boat:${input.requestId}` });
      yield* service.create(input);
      assert.strictEqual(fixture.createCount, 1);
      assert.strictEqual((yield* service.list()).sandboxes.length, 1);
      const conflict = yield* Effect.result(service.create({ ...input, ttlSeconds: 7200 }));
      assert.strictEqual(conflict._tag, "Failure");
      assert.notInclude(JSON.stringify(yield* service.list()), "boat_test_secret");
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it.effect("never recreates an uncertain request after the provider idempotency window", () => {
    const fixture = setup();
    fixture.failCreate();
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
      yield* service.create(input);
      yield* Effect.result(service.refresh({ id: `boat:${input.requestId}` }));
      const before = fixture.createCount;
      yield* TestClock.adjust("25 hours");
      yield* Effect.result(service.refresh({ id: `boat:${input.requestId}` }));
      assert.strictEqual(fixture.createCount, before);
      assert.strictEqual(fixture.records[0]?.state, "unknown");
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it.effect("retains stop intent until Boat confirms completion", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
      yield* service.create(input);
      yield* service.refresh({ id: `boat:${input.requestId}` });
      yield* service.stop({ id: `boat:${input.requestId}` });
      assert.strictEqual(
        (yield* service.refresh({ id: `boat:${input.requestId}` })).state,
        "stopping",
      );
      fixture.completeStop();
      assert.strictEqual(
        (yield* service.refresh({ id: `boat:${input.requestId}` })).state,
        "stopped",
      );
      assert.strictEqual(fixture.stopCount, 1);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it.effect("recovers uncertain state after restart without launching another sandbox", () => {
    const record: SandboxStore.StoredSandbox = {
      ...input,
      id: `boat:${input.requestId}`,
      providerId: null,
      state: "provisioning",
      connectionState: "unavailable",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      lastError: null,
      desiredState: "running",
      deletionOperationId: null,
      keyFingerprint: "old",
    };
    const fixture = setup([record]);
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      assert.strictEqual((yield* service.list()).sandboxes[0]?.state, "unknown");
      assert.strictEqual(fixture.createCount, 0);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it.effect(
    "removes provider credentials and permits only the same account key on active records",
    () => {
      const fixture = setup();
      return Effect.gen(function* () {
        const service = yield* SandboxService.SandboxService;
        yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
        yield* service.create(input);
        yield* service.refresh({ id: "boat:request-1" });
        yield* service.configure({ provider: "boat", apiKey: "" });
        assert.isFalse(
          (yield* service.list()).providers.find((entry) => entry.provider === "boat")!.configured,
        );
        const wrongAccount = yield* Effect.result(
          service.configure({ provider: "boat", apiKey: "boat_different_account" }),
        );
        assert.strictEqual(wrongAccount._tag, "Failure");
        yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
        assert.isTrue(
          (yield* service.list()).providers.find((entry) => entry.provider === "boat")!.configured,
        );
        assert.notInclude(JSON.stringify(yield* service.list()), "keyFingerprint");
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    },
  );
  it.effect("retains deletion tombstones until provider confirmation", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
      yield* service.create(input);
      yield* service.refresh({ id: "boat:request-1" });
      yield* service.remove({ id: "boat:request-1" });
      assert.strictEqual((yield* service.refresh({ id: "boat:request-1" })).state, "deleting");
      assert.strictEqual((yield* service.list()).sandboxes.length, 1);
      fixture.completeDeletion();
      assert.strictEqual((yield* service.refresh({ id: "boat:request-1" })).state, "deleted");
      assert.strictEqual(fixture.deleteCount, 1);
      yield* service.create(input);
      assert.strictEqual(fixture.createCount, 1);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it.effect("honors cancellation received before create returns its provider ID", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const fixture = setup([], {
        create: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(proceed);
            return { id: "bx_23456789", state: "ready" };
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* SandboxService.SandboxService;
        yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
        yield* service.create(input);
        yield* Deferred.await(started);
        yield* service.stop({ id: "boat:request-1" });
        yield* Deferred.succeed(proceed, undefined);
        assert.strictEqual((yield* service.refresh({ id: "boat:request-1" })).state, "stopping");
        assert.strictEqual(fixture.stopCount, 1);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    }),
  );
  it.effect("does not call the provider when durable intent cannot be saved", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
      fixture.failSave();
      assert.strictEqual((yield* Effect.result(service.create(input)))._tag, "Failure");
      assert.strictEqual(fixture.createCount, 0);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it.effect(
    "retains an uncertain resume without repeating it until stop reconciles the provider",
    () => {
      let resumeCount = 0;
      const fixture = setup([], {
        resume: () =>
          Effect.suspend(() => {
            resumeCount++;
            return Effect.fail(new SandboxOperationError({ category: "unavailable" }));
          }),
      });
      return Effect.gen(function* () {
        const service = yield* SandboxService.SandboxService;
        yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
        yield* service.create(input);
        yield* service.refresh({ id: "boat:request-1" });
        fixture.completeStop();
        yield* service.refresh({ id: "boat:request-1" });
        yield* service.resume({ id: "boat:request-1" });
        assert.strictEqual((yield* service.refresh({ id: "boat:request-1" })).state, "unknown");
        yield* service.refresh({ id: "boat:request-1" });
        assert.strictEqual(resumeCount, 1);
        assert.strictEqual(fixture.records[0]!.pendingAction, "resume");
        assert.strictEqual(fixture.records[0]!.lastError?.category, "unavailable");
        yield* service.stop({ id: "boat:request-1" });
        assert.strictEqual((yield* service.refresh({ id: "boat:request-1" })).state, "stopped");
        assert.strictEqual(fixture.createCount, 1);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    },
  );
  it.effect("isolates request IDs and configuration across providers", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
      yield* service.configure({ provider: "namespace", apiKey: "ns_test_secret" });
      assert.strictEqual((yield* service.create(input)).id, "boat:request-1");
      assert.strictEqual(
        (yield* service.create({ ...input, provider: "namespace", ttlSeconds: 10800 })).id,
        "namespace:request-1",
      );
      yield* service.refresh({ id: "namespace:request-1" });
      assert.strictEqual((yield* service.list()).sandboxes.length, 2);
      assert.strictEqual(fixture.createCount, 2);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it.effect("never replays an uncertain provider creation without an idempotency guarantee", () => {
    let calls = 0;
    const fixture = setup([], {
      creationReplayWindowMs: 0,
      create: () =>
        Effect.suspend(() => {
          calls++;
          return Effect.fail(new SandboxOperationError({ category: "uncertain" }));
        }),
    });
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
      yield* service.create(input);
      yield* service.refresh({ id: "boat:request-1" });
      yield* service.refresh({ id: "boat:request-1" });
      assert.strictEqual(calls, 1);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it.effect("keeps provisioning work alive when its RPC caller disconnects", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      let interrupted = false;
      const fixture = setup([], {
        connect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(proceed);
            yield* Deferred.succeed(completed, undefined);
            return { type: "pairing" as const, url: "https://sandbox.on.boat.dev/pair#token=test" };
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const service = yield* SandboxService.SandboxService;
        yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
        yield* service.create(input);
        const caller = yield* service.connect({ id: "boat:request-1" }).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(proceed, undefined);
        yield* Deferred.await(completed);
        assert.isFalse(interrupted);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    }),
  );
  it.effect(
    "permits removing a definitively rejected creation before configuring a corrected key",
    () => {
      const fixture = setup([], {
        create: () => Effect.fail(new SandboxOperationError({ category: "authentication" })),
      });
      return Effect.gen(function* () {
        const service = yield* SandboxService.SandboxService;
        yield* service.configure({ provider: "boat", apiKey: "boat_invalid_secret" });
        yield* service.create(input);
        yield* Effect.result(service.refresh({ id: "boat:request-1" }));
        assert.strictEqual((yield* service.list()).sandboxes[0]?.state, "error");
        yield* service.remove({ id: "boat:request-1" });
        assert.strictEqual((yield* service.refresh({ id: "boat:request-1" })).state, "deleted");
        yield* service.configure({ provider: "boat", apiKey: "boat_corrected_secret" });
        assert.strictEqual(fixture.deleteCount, 0);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    },
  );
  it.effect(
    "recovers an ambiguous Namespace creation by ownership lookup without replaying create",
    () => {
      const fixture = setup([], {
        creationReplayWindowMs: 0,
        recoverCreation: () => Effect.succeed({ id: "namespace-owned", state: "ready" }),
      });
      fixture.failCreate();
      return Effect.gen(function* () {
        const service = yield* SandboxService.SandboxService;
        yield* service.configure({ provider: "namespace", apiKey: "namespace-test" });
        yield* service.create({ ...input, provider: "namespace", ttlSeconds: 10800 });
        const record = yield* service.refresh({ id: "namespace:request-1" });
        assert.strictEqual(record.providerId, "namespace-owned");
        assert.strictEqual(record.state, "running");
        assert.strictEqual(fixture.createCount, 1);
        yield* service.refresh({ id: "namespace:request-1" });
        assert.strictEqual(fixture.createCount, 1);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    },
  );

  it.effect(
    "rotates an expired key only after validating access to the existing provider resources",
    () => {
      const validations: Array<{ apiKey: string; ids: ReadonlyArray<string> }> = [];
      const fixture = setup([], {
        validateCredential: (apiKey, ids) =>
          Effect.sync(() => {
            validations.push({ apiKey, ids });
          }),
      });
      return Effect.gen(function* () {
        const service = yield* SandboxService.SandboxService;
        yield* service.configure({ provider: "boat", apiKey: "boat_old_secret" });
        yield* service.create(input);
        yield* service.refresh({ id: "boat:request-1" });
        const previousFingerprint = fixture.records[0]!.keyFingerprint;
        yield* service.configure({ provider: "boat", apiKey: "boat_rotated_secret" });
        assert.deepStrictEqual(validations, [
          { apiKey: "boat_rotated_secret", ids: ["bx_23456789"] },
        ]);
        assert.strictEqual(fixture.secret("boat"), "boat_rotated_secret");
        assert.notStrictEqual(fixture.records[0]!.keyFingerprint, previousFingerprint);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    },
  );
  it.effect(
    "preserves the current secret and fingerprints when a replacement cannot access managed resources",
    () => {
      const fixture = setup([], {
        validateCredential: () => Effect.fail(new SandboxOperationError({ category: "forbidden" })),
      });
      return Effect.gen(function* () {
        const service = yield* SandboxService.SandboxService;
        yield* service.configure({ provider: "boat", apiKey: "boat_old_secret" });
        yield* service.create(input);
        yield* service.refresh({ id: "boat:request-1" });
        const previousFingerprint = fixture.records[0]!.keyFingerprint;
        assert.strictEqual(
          (yield* Effect.result(
            service.configure({ provider: "boat", apiKey: "boat_inaccessible_secret" }),
          ))._tag,
          "Failure",
        );
        assert.strictEqual(fixture.secret("boat"), "boat_old_secret");
        assert.strictEqual(fixture.records[0]!.keyFingerprint, previousFingerprint);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    },
  );
  it.effect(
    "keeps deletion terminal when stop and resume arrive while the worker is occupied",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const fixture = setup([], {
          connect: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(proceed);
              return {
                type: "pairing" as const,
                url: "https://sandbox.on.boat.dev/pair#token=test",
              };
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* SandboxService.SandboxService;
          yield* service.configure({ provider: "boat", apiKey: "boat_test_secret" });
          yield* service.create(input);
          const connection = yield* Effect.result(service.connect({ id: "boat:request-1" })).pipe(
            Effect.forkScoped,
          );
          yield* Deferred.await(started);
          yield* service.remove({ id: "boat:request-1" });
          assert.strictEqual(
            (yield* Effect.result(service.stop({ id: "boat:request-1" })))._tag,
            "Failure",
          );
          const resume = yield* Effect.result(service.resume({ id: "boat:request-1" })).pipe(
            Effect.forkScoped,
          );
          yield* Deferred.succeed(proceed, undefined);
          yield* Fiber.join(connection);
          assert.strictEqual((yield* Fiber.join(resume))._tag, "Failure");
          yield* service.refresh({ id: "boat:request-1" });
          assert.strictEqual(fixture.records[0]!.desiredState, "deleted");
          assert.strictEqual(fixture.deleteCount, 1);
        }).pipe(Effect.provide(fixture.layer), Effect.scoped);
      }),
  );
  it.effect("resumes a persisted queued action after restart and clears its durable marker", () => {
    let resumeCount = 0;
    const record: SandboxStore.StoredSandbox = {
      ...input,
      id: "boat:request-1",
      providerId: "bx_23456789",
      state: "resuming",
      desiredState: "running",
      pendingAction: "resume",
      connectionState: "unavailable",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
      deletionOperationId: null,
      keyFingerprint: "old",
    };
    const fixture = setup([record], {
      observe: () =>
        Effect.sync(() => ({ id: "bx_23456789", state: resumeCount ? "ready" : "archived" })),
      resume: () =>
        Effect.sync(() => {
          resumeCount++;
        }),
    });
    return Effect.gen(function* () {
      const service = yield* SandboxService.SandboxService;
      assert.strictEqual((yield* service.refresh({ id: "boat:request-1" })).state, "running");
      assert.strictEqual(resumeCount, 1);
      assert.notStrictEqual(fixture.records[0]!.pendingAction, "resume");
      assert.notInclude(JSON.stringify(yield* service.list()), "pendingAction");
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
  it("serializes only a safe category for credential-bearing provider failures", () => {
    const error = new SandboxOperationError({ category: "authentication" });
    assert.deepStrictEqual(encodeOperationError(error), {
      _tag: "SandboxOperationError",
      category: "authentication",
    });
    assert.notInclude(error.message, "boat_");
  });
});
