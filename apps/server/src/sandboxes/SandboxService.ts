import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  ManagedSandbox,
  SandboxCreateInput,
  SandboxOperationError,
  type SandboxProvider,
  type SandboxConfigureInput,
  type SandboxIdInput,
  type SandboxListResult,
  type SandboxConnectResult,
} from "@t3tools/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SandboxProviders from "./SandboxProviders.ts";
import * as SandboxStore from "./SandboxStore.ts";

export class SandboxService extends Context.Service<
  SandboxService,
  {
    readonly configure: (
      input: SandboxConfigureInput,
    ) => Effect.Effect<{ provider: SandboxProvider; configured: boolean }, SandboxOperationError>;
    readonly list: () => Effect.Effect<SandboxListResult, SandboxOperationError>;
    readonly create: (
      input: SandboxCreateInput,
    ) => Effect.Effect<ManagedSandbox, SandboxOperationError>;
    readonly refresh: (
      input: SandboxIdInput,
    ) => Effect.Effect<ManagedSandbox, SandboxOperationError>;
    readonly stop: (input: SandboxIdInput) => Effect.Effect<ManagedSandbox, SandboxOperationError>;
    readonly resume: (
      input: SandboxIdInput,
    ) => Effect.Effect<ManagedSandbox, SandboxOperationError>;
    readonly remove: (
      input: SandboxIdInput,
    ) => Effect.Effect<ManagedSandbox, SandboxOperationError>;
    readonly connect: (
      input: SandboxIdInput,
    ) => Effect.Effect<SandboxConnectResult, SandboxOperationError>;
  }
>()("t3/sandboxes/SandboxService") {}
interface Work {
  readonly id: string;
  readonly refresh: boolean;
  readonly action?: "resume" | "connect";
  readonly done?: Deferred.Deferred<ManagedSandbox, SandboxOperationError>;
  readonly connection?: Deferred.Deferred<SandboxConnectResult, SandboxOperationError>;
}
const publicRecord = ({
  keyFingerprint: _keyFingerprint,
  pendingAction: _pendingAction,
  resumeDispatched: _resumeDispatched,
  desiredState: _desiredState,
  deletionOperationId: _deletionOperationId,
  ...record
}: SandboxStore.StoredSandbox): ManagedSandbox => record;
const decodeCreateInput = Schema.decodeEffect(SandboxCreateInput);
const make = Effect.gen(function* () {
  const store = yield* SandboxStore.SandboxStore;
  const providers = yield* SandboxProviders.SandboxProviders;
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const queue = yield* Queue.unbounded<Work>();
  let records = [...(yield* store.load)];
  // An interrupted create can have reached Boat; startup must never replay it automatically.
  records = records.map((record) =>
    record.providerId === null && record.state === "provisioning"
      ? { ...record, state: "unknown" }
      : record,
  );
  yield* store.save(records);
  const get = (id: string) => {
    const record = records.find((record) => record.id === id);
    return record
      ? Effect.succeed(record)
      : Effect.fail(new SandboxOperationError({ category: "not_found" }));
  };
  const update = Effect.fn("SandboxService.persist")(function* (
    id: string,
    patch: Partial<SandboxStore.StoredSandbox>,
    requireRunningIntent = false,
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const record = yield* get(id);
        if (
          record.desiredState === "deleted" &&
          patch.desiredState !== undefined &&
          patch.desiredState !== "deleted"
        )
          return yield* new SandboxOperationError({ category: "conflict" });
        if (requireRunningIntent && record.desiredState !== "running")
          return yield* new SandboxOperationError({ category: "conflict" });
        const now = yield* DateTime.now;
        const next = { ...record, ...patch, updatedAt: DateTime.formatIso(now) };
        const all = records.map((record) => (record.id === id ? next : record));
        yield* store.save(all);
        records = all;
        return next;
      }),
    );
  });
  const configured = (provider: SandboxProvider) =>
    secrets.get(`${provider}-api-key`).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(() => new SandboxOperationError({ category: "storage" })),
    );
  const fingerprint = Effect.fn("SandboxService.fingerprint")(function* (key: Uint8Array) {
    const digest = yield* crypto
      .digest("SHA-256", key)
      .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
  const reconcile = Effect.fn("SandboxService.reconcile")(function* (
    id: string,
    explicitRefresh: boolean,
  ) {
    let record = yield* get(id);
    const boat = providers.get(record.provider);
    if (record.state === "deleted") return record;
    if (!record.providerId) {
      if (
        record.desiredState !== "running" &&
        (record.state === "requested" || record.state === "error")
      )
        return yield* update(id, { state: "deleted" });
      if (record.state !== "requested" && !explicitRefresh) return record;
      if (record.state !== "requested" && boat.recoverCreation) {
        const recovered = yield* boat.recoverCreation(record);
        if (recovered)
          record = yield* update(id, {
            providerId: recovered.id,
            state: "provisioning",
            lastError: null,
          });
      }
      const now = yield* Clock.currentTimeMillis;
      const createdAt = Date.parse(record.createdAt);
      if (
        !record.providerId &&
        record.state !== "requested" &&
        (!Number.isFinite(createdAt) ||
          now < createdAt ||
          now - createdAt >= boat.creationReplayWindowMs)
      ) {
        return yield* update(id, {
          state: "unknown",
          lastError: {
            category: "uncertain",
            message: new SandboxOperationError({ category: "uncertain" }).message,
          },
        });
      }
      if (!record.providerId) {
        yield* update(id, { state: "provisioning" });
        const remote = yield* boat.create(record);
        record = yield* update(id, {
          providerId: remote.id,
          state: "provisioning",
          lastError: null,
        });
      }
    }
    const providerId = record.providerId;
    if (!providerId) return yield* new SandboxOperationError({ category: "uncertain" });
    // Read intent again: stop/remove may have arrived while create was in flight.
    record = yield* get(id);
    if (record.desiredState === "deleted") {
      if (!record.deletionOperationId) {
        const operationId = yield* boat.remove(providerId);
        record = yield* update(id, {
          state: "deleting",
          connectionState: "unavailable",
          deletionOperationId: operationId,
        });
      }
      if (record.deletionOperationId && (yield* boat.deletion(record.deletionOperationId)))
        return yield* update(id, { state: "deleted", lastError: null });
      return record;
    }
    const remote = yield* boat.observe(providerId);
    if (record.pendingAction === "resume" && record.desiredState === "running") {
      if (remote.state === "ready" || remote.state === "idle" || remote.state === "running") {
        record = yield* update(id, { pendingAction: null, resumeDispatched: false });
      } else if (remote.state === "archived") {
        if (record.resumeDispatched) {
          return yield* update(id, {
            state: "unknown",
            connectionState: "unavailable",
            lastError: record.lastError ?? {
              category: "uncertain",
              message: new SandboxOperationError({ category: "uncertain" }).message,
            },
          });
        }
        yield* update(id, { state: "resuming", resumeDispatched: true }, true);
        yield* boat.resume(providerId, record.ttlSeconds);
        return yield* update(id, {
          state: "resuming",
          pendingAction: null,
          resumeDispatched: false,
          lastError: null,
        });
      } else {
        return yield* update(id, { state: "resuming", connectionState: "unavailable" });
      }
    }
    if (record.desiredState === "stopped") {
      if (remote.state === "archived" && (!remote.stop || remote.stop.status === "completed"))
        return yield* update(id, {
          state: "stopped",
          connectionState: "unavailable",
          lastError: null,
        });
      if (!remote.stop || remote.stop.status === "superseded") {
        yield* update(id, { state: "stopping", connectionState: "unavailable" });
        yield* boat.stop(providerId);
      }
      return yield* get(id);
    }
    const state =
      remote.state === "ready" || remote.state === "idle" || remote.state === "running"
        ? "running"
        : remote.state === "archived"
          ? "stopped"
          : remote.state === "archiving"
            ? "stopping"
            : remote.state === "error" || remote.state === "cancelled"
              ? "error"
              : "provisioning";
    return yield* update(id, {
      state,
      connectionState: state === "running" ? "unverified" : "unavailable",
      lastError: null,
    });
  });
  const process = Effect.fn("SandboxService.process")(function* (work: Work) {
    if (work.action === "connect" && work.connection) {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const record = yield* reconcile(work.id, true);
          if (record.state !== "running" || !record.providerId)
            return yield* new SandboxOperationError({ category: "conflict" });
          const connection = yield* providers.get(record.provider).connect(record.providerId);
          const current = yield* get(work.id);
          if (current.desiredState !== "running")
            return yield* new SandboxOperationError({ category: "conflict" });
          yield* update(work.id, { connectionState: "ready", lastError: null }, true);
          return connection;
        }).pipe(
          Effect.tapError((error) =>
            update(work.id, {
              connectionState: "unverified",
              lastError: { category: error.category, message: error.message },
            }),
          ),
        ),
      );
      yield* Deferred.done(work.connection, result);
      return;
    }
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        return publicRecord(yield* reconcile(work.id, work.refresh));
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const record = yield* get(work.id);
            const rejectedBeforeCreation =
              !record.providerId &&
              ["authentication", "forbidden", "billing", "invalid_input", "not_found"].includes(
                error.category,
              );
            yield* update(work.id, {
              state: rejectedBeforeCreation ? "error" : "unknown",
              connectionState: "unavailable",
              lastError: { category: error.category, message: error.message },
            });
          }),
        ),
      ),
    );
    if (work.done) yield* Deferred.done(work.done, result);
  });
  yield* Effect.forever(Queue.take(queue).pipe(Effect.flatMap(process))).pipe(Effect.forkIn(scope));
  for (const record of records) {
    if (
      record.state !== "deleted" &&
      (record.providerId || record.state === "requested" || record.desiredState !== "running")
    )
      yield* Queue.offer(queue, {
        id: record.id,
        refresh: false,
        ...(record.pendingAction === "resume" ? { action: "resume" as const } : {}),
      });
  }
  const configure = Effect.fn("SandboxService.configure")(function* (input: SandboxConfigureInput) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const name = `${input.provider}-api-key`;
        if (input.apiKey === "") {
          yield* secrets
            .remove(name)
            .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })));
          return { provider: input.provider, configured: false };
        }
        if (!input.apiKey.trim() || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))
          return yield* new SandboxOperationError({ category: "invalid_input" });
        const key = new TextEncoder().encode(input.apiKey);
        const keyFingerprint = yield* fingerprint(key);
        const active = records.filter(
          (record) => record.provider === input.provider && record.state !== "deleted",
        );
        if (active.some((record) => record.keyFingerprint !== keyFingerprint)) {
          const client = providers.get(input.provider);
          if (active.some((record) => record.providerId === null) || !client.validateCredential)
            return yield* new SandboxOperationError({ category: "conflict" });
          yield* client.validateCredential(
            input.apiKey,
            active.flatMap((record) => (record.providerId ? [record.providerId] : [])),
          );
          const next = records.map((record) =>
            record.provider === input.provider ? { ...record, keyFingerprint } : record,
          );
          yield* store.save(next);
          records = next;
        }
        yield* secrets
          .set(name, key)
          .pipe(Effect.mapError(() => new SandboxOperationError({ category: "storage" })));
        return { provider: input.provider, configured: true };
      }).pipe(Effect.uninterruptible),
    );
  });
  const list = Effect.fn("SandboxService.list")(function* () {
    return {
      providers: yield* Effect.forEach(["boat", "namespace"] as const, (provider) =>
        configured(provider).pipe(Effect.map((configured) => ({ provider, configured }))),
      ),
      sandboxes: records.map(publicRecord),
    };
  });
  const create = Effect.fn("SandboxService.create")(function* (input: SandboxCreateInput) {
    const validated = yield* decodeCreateInput(input).pipe(
      Effect.mapError(() => new SandboxOperationError({ category: "invalid_input" })),
    );
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (!(yield* configured(validated.provider)))
          return yield* new SandboxOperationError({ category: "not_configured" });
        const existing = records.find(
          (record) =>
            record.provider === validated.provider && record.requestId === validated.requestId,
        );
        if (existing) {
          if (
            existing.name !== validated.name ||
            existing.templateId !== validated.templateId ||
            existing.machineType !== validated.machineType ||
            existing.ttlSeconds !== validated.ttlSeconds
          )
            return yield* new SandboxOperationError({ category: "conflict" });
          return publicRecord(existing);
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const record: SandboxStore.StoredSandbox = {
          ...validated,
          id: `${validated.provider}:${validated.requestId}`,
          keyFingerprint: yield* secrets.get(`${validated.provider}-api-key`).pipe(
            Effect.mapError(() => new SandboxOperationError({ category: "storage" })),
            Effect.flatMap((key) =>
              Option.isSome(key)
                ? fingerprint(key.value)
                : Effect.fail(new SandboxOperationError({ category: "not_configured" })),
            ),
          ),
          providerId: null,
          state: "requested",
          connectionState: "unavailable",
          createdAt: now,
          updatedAt: now,
          desiredState: "running",
          deletionOperationId: null,
          lastError: null,
        };
        const next = [...records, record];
        yield* store.save(next);
        records = next;
        yield* Queue.offer(queue, { id: record.id, refresh: false });
        return publicRecord(record);
      }).pipe(Effect.uninterruptible),
    );
  });
  const refresh = Effect.fn("SandboxService.refresh")(function* ({ id }: SandboxIdInput) {
    yield* get(id);
    const done = yield* Deferred.make<ManagedSandbox, SandboxOperationError>();
    yield* Queue.offer(queue, { id, refresh: true, done });
    return yield* Deferred.await(done);
  });
  const intent = Effect.fn("SandboxService.intent")(function* (
    { id }: SandboxIdInput,
    desiredState: "stopped" | "deleted",
  ) {
    const record = yield* get(id);
    if (record.state === "deleted") {
      if (desiredState !== "deleted")
        return yield* new SandboxOperationError({ category: "conflict" });
      return record;
    }
    const next = yield* update(id, {
      desiredState,
      connectionState: "unavailable",
      pendingAction: null,
      resumeDispatched: false,
    });
    yield* Queue.offer(queue, { id, refresh: false });
    return publicRecord(next);
  }, Effect.uninterruptible);
  const stop = Effect.fn("SandboxService.stop")((input: SandboxIdInput) =>
    intent(input, "stopped"),
  );
  const remove = Effect.fn("SandboxService.remove")((input: SandboxIdInput) =>
    intent(input, "deleted"),
  );
  const resume = Effect.fn("SandboxService.resume")(function* ({ id }: SandboxIdInput) {
    const current = yield* get(id);
    if (current.desiredState === "deleted")
      return yield* new SandboxOperationError({ category: "conflict" });
    const record = yield* refresh({ id });
    if (record.state !== "stopped" || !record.providerId)
      return yield* new SandboxOperationError({ category: "conflict" });
    return yield* Effect.gen(function* () {
      yield* update(id, {
        state: "resuming",
        desiredState: "running",
        pendingAction: "resume",
        resumeDispatched: false,
        connectionState: "unavailable",
      });
      yield* Queue.offer(queue, { id, refresh: false, action: "resume" });
      return publicRecord(yield* get(id));
    }).pipe(Effect.uninterruptible);
  });
  const connect = Effect.fn("SandboxService.connect")(function* ({ id }: SandboxIdInput) {
    yield* get(id);
    const done = yield* Deferred.make<SandboxConnectResult, SandboxOperationError>();
    yield* Queue.offer(queue, { id, refresh: true, action: "connect", connection: done });
    return yield* Deferred.await(done);
  });
  return SandboxService.of({ configure, list, create, refresh, stop, resume, remove, connect });
});
export const layer = Layer.effect(SandboxService, make);
