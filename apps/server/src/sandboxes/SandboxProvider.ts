import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  SandboxCreateInput,
  SandboxConnectResult,
  SandboxOperationError,
} from "@t3tools/contracts";

export const ProviderObservation = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  stop: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ id: Schema.String, status: Schema.String })),
  ),
});
export type ProviderObservation = typeof ProviderObservation.Type;
export interface SandboxProviderClient {
  readonly creationReplayWindowMs: number;
  readonly validateCredential?: (
    apiKey: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SandboxOperationError>;
  readonly create: (
    input: SandboxCreateInput,
  ) => Effect.Effect<ProviderObservation, SandboxOperationError>;
  readonly recoverCreation?: (
    input: SandboxCreateInput,
  ) => Effect.Effect<ProviderObservation | null, SandboxOperationError>;
  readonly observe: (id: string) => Effect.Effect<ProviderObservation, SandboxOperationError>;
  readonly stop: (id: string) => Effect.Effect<void, SandboxOperationError>;
  readonly resume: (id: string, ttlSeconds: number) => Effect.Effect<void, SandboxOperationError>;
  readonly remove: (id: string) => Effect.Effect<string, SandboxOperationError>;
  readonly deletion: (id: string) => Effect.Effect<boolean, SandboxOperationError>;
  readonly connect: (id: string) => Effect.Effect<SandboxConnectResult, SandboxOperationError>;
}
