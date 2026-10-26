import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as SandboxStore from "./SandboxStore.ts";

const record: SandboxStore.StoredSandbox = {
  provider: "boat",
  id: "boat:request-1",
  requestId: "request-1",
  name: "Work",
  templateId: "clean-t3",
  machineType: "small",
  ttlSeconds: 3600,
  providerId: null,
  state: "unknown",
  desiredState: "running",
  connectionState: "unavailable",
  deletionOperationId: null,
  keyFingerprint: "fingerprint",
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("SandboxStore", () => {
  it.effect("recovers durable managed records from a new store instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandboxes-" });
      const layer = SandboxStore.layer.pipe(
        Layer.provide(ServerConfig.layerTest(directory, directory)),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const store = yield* SandboxStore.SandboxStore;
        assert.deepStrictEqual(yield* store.load, []);
        yield* store.save([record]);
      }).pipe(Effect.provide(layer));
      yield* Effect.gen(function* () {
        const store = yield* SandboxStore.SandboxStore;
        assert.deepStrictEqual(yield* store.load, [record]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails closed on corrupt durable state instead of forgetting managed machines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandboxes-" });
      const configLayer = ServerConfig.layerTest(directory, directory).pipe(
        Layer.provide(NodeServices.layer),
      );
      const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(`${config.stateDir}/sandboxes.json`, "{broken");
      const layer = SandboxStore.layer.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const store = yield* SandboxStore.SandboxStore;
        const result = yield* Effect.result(store.load);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.category, "storage");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
