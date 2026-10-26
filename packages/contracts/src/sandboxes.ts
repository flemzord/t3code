import * as Schema from "effect/Schema";
import { DesktopSshEnvironmentTargetSchema } from "./ipc.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SandboxProvider = Schema.Literals(["boat", "namespace"]);
export type SandboxProvider = typeof SandboxProvider.Type;

export const SandboxMachineType = Schema.Literals(["small", "default", "large", "xlarge"]);
export type SandboxMachineType = typeof SandboxMachineType.Type;
export const SandboxState = Schema.Literals([
  "requested",
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "resuming",
  "deleting",
  "deleted",
  "unknown",
  "error",
]);
export type SandboxState = typeof SandboxState.Type;
export const SandboxErrorCategory = Schema.Literals([
  "not_configured",
  "invalid_input",
  "not_found",
  "authentication",
  "forbidden",
  "billing",
  "rate_limited",
  "conflict",
  "unavailable",
  "uncertain",
  "storage",
  "bootstrap",
  "connection",
]);
export type SandboxErrorCategory = typeof SandboxErrorCategory.Type;
export class SandboxOperationError extends Schema.TaggedError<SandboxOperationError>()(
  "SandboxOperationError",
  { category: SandboxErrorCategory },
) {
  override get message(): string {
    switch (this.category) {
      case "not_configured":
        return "Configure a sandbox provider API key first.";
      case "invalid_input":
        return "The sandbox request is invalid.";
      case "not_found":
        return "The managed sandbox was not found.";
      case "authentication":
        return "Sandbox provider authentication failed.";
      case "forbidden":
        return "The sandbox provider denied this operation.";
      case "billing":
        return "The sandbox provider requires billing attention.";
      case "rate_limited":
        return "The sandbox provider has reached a request or capacity limit.";
      case "conflict":
        return "The sandbox operation conflicts with its current state.";
      case "unavailable":
        return "The sandbox provider is unavailable. Refresh to reconcile the sandbox.";
      case "uncertain":
        return "The operation outcome is uncertain. Refresh before trying again.";
      case "storage":
        return "The sandbox state could not be saved or read.";
      case "bootstrap":
        return "The independent T3 service could not be prepared.";
      case "connection":
        return "The T3 service connection could not be verified.";
    }
  }
}
export const SandboxFailure = Schema.Struct({
  category: SandboxErrorCategory,
  message: Schema.String,
});
export const ManagedSandbox = Schema.Struct({
  provider: SandboxProvider,
  id: Schema.String,
  requestId: Schema.String,
  name: Schema.String,
  templateId: Schema.String,
  machineType: SandboxMachineType,
  ttlSeconds: Schema.Number,
  providerId: Schema.NullOr(Schema.String),
  state: SandboxState,
  connectionState: Schema.Literals(["unavailable", "unverified", "ready"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastError: Schema.NullOr(SandboxFailure),
});
export type ManagedSandbox = typeof ManagedSandbox.Type;
export const SandboxConfigureInput = Schema.Struct({
  provider: SandboxProvider,
  apiKey: Schema.String.check(Schema.isMaxLength(4096)),
});
export type SandboxConfigureInput = typeof SandboxConfigureInput.Type;
export const SandboxConfiguration = Schema.Struct({
  provider: SandboxProvider,
  configured: Schema.Boolean,
});
export const SandboxListResult = Schema.Struct({
  providers: Schema.Array(SandboxConfiguration),
  sandboxes: Schema.Array(ManagedSandbox),
});
export type SandboxListResult = typeof SandboxListResult.Type;
export const SandboxCreateInput = Schema.Struct({
  provider: SandboxProvider,
  requestId: TrimmedNonEmptyString.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
  ),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  templateId: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  machineType: SandboxMachineType,
  ttlSeconds: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 2592000 }),
  ).annotate({
    description:
      "Boat stop deadline in seconds. Namespace uses the fixed marker 10800 and retains its provider plan runtime/idle policy; this does not set a custom deadline.",
  }),
}).check(
  Schema.makeFilter(
    (input) =>
      input.provider !== "namespace" ||
      input.ttlSeconds === 10800 ||
      "Namespace duration is controlled by the provider plan; use 10800.",
  ),
);
export type SandboxCreateInput = typeof SandboxCreateInput.Type;
export const SandboxIdInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type SandboxIdInput = typeof SandboxIdInput.Type;
export const SandboxConnectResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pairing"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ssh"), target: DesktopSshEnvironmentTargetSchema }),
]);
export type SandboxConnectResult = typeof SandboxConnectResult.Type;
