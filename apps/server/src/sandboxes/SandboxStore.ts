import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ManagedSandbox, SandboxOperationError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";

export const StoredSandbox = Schema.Struct({
  ...ManagedSandbox.fields,
  keyFingerprint: Schema.String,
  pendingAction: Schema.optionalKey(Schema.NullOr(Schema.Literal("resume"))),
  resumeDispatched: Schema.optionalKey(Schema.Boolean),
  desiredState: Schema.Literals(["running", "stopped", "deleted"]),
  deletionOperationId: Schema.NullOr(Schema.String),
});
export type StoredSandbox = typeof StoredSandbox.Type;
const StateFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), sandboxes: Schema.Array(StoredSandbox) }),
);
const encodeStateFile = Schema.encodeEffect(StateFile);
export class SandboxStore extends Context.Service<
  SandboxStore,
  {
    readonly load: Effect.Effect<ReadonlyArray<StoredSandbox>, SandboxOperationError>;
    readonly save: (
      records: ReadonlyArray<StoredSandbox>,
    ) => Effect.Effect<void, SandboxOperationError>;
  }
>()("t3/sandboxes/SandboxStore") {}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "sandboxes.json");
  const load = fs.readFileString(filePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StateFile)),
    Effect.map((file) => file.sandboxes),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed([])
          : Effect.fail(new SandboxOperationError({ category: "storage" })),
    }),
    Effect.mapError(() => new SandboxOperationError({ category: "storage" })),
  );
  const save = Effect.fn("SandboxStore.save")(
    function* (sandboxes: ReadonlyArray<StoredSandbox>) {
      const contents = yield* encodeStateFile({ version: 1, sandboxes });
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
    Effect.mapError(() => new SandboxOperationError({ category: "storage" })),
  );
  return SandboxStore.of({ load, save });
});
export const layer = Layer.effect(SandboxStore, make);
