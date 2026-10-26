import { SandboxCreateInput, SandboxOperationError, type ManagedSandbox } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const parseSandboxCreateInput = Schema.decodeUnknownOption(SandboxCreateInput);
const parseSandboxOperationError = Schema.decodeUnknownOption(SandboxOperationError);

export function parseSandboxCreateDraft({
  ttlHours,
  ...input
}: Omit<SandboxCreateInput, "ttlSeconds"> & { readonly ttlHours: string }) {
  return parseSandboxCreateInput({
    ...input,
    name: input.name.trim(),
    templateId: input.templateId.trim(),
    ttlSeconds: input.provider === "namespace" ? 10800 : Number(ttlHours) * 3600,
  });
}

export function sandboxOperationErrorMessage(error: unknown): string {
  const decoded = parseSandboxOperationError(error);
  return Option.isSome(decoded)
    ? decoded.value.message
    : "The sandbox request failed. Refresh to reconcile the machine before retrying. If this server is older, update it to use managed sandboxes.";
}

export function sandboxCreateWasRejected(error: unknown): boolean {
  const decoded = parseSandboxOperationError(error);
  return Option.isSome(decoded) && decoded.value.category === "invalid_input";
}

export function unconfirmedSandboxCreate(
  attempt: SandboxCreateInput | null,
  sandboxes: ReadonlyArray<ManagedSandbox> | null,
): SandboxCreateInput | null {
  return attempt !== null &&
    !sandboxes?.some(
      (sandbox) => sandbox.provider === attempt.provider && sandbox.requestId === attempt.requestId,
    )
    ? attempt
    : null;
}
