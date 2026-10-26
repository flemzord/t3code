import type {
  ModelSelection,
  ProviderDriverKind,
  ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";
import type { ProviderInstanceEntry } from "../providerInstances";

export function namespaceWorktreeRequestId(threadId: ThreadId): string {
  return `worktree-${Array.from(threadId, (character) => character.charCodeAt(0).toString(16).padStart(4, "0")).join("")}`;
}

export function namespaceWorktreeBlockReason(input: {
  desktopLocalController: boolean;
  supported: boolean;
  multipleModels: boolean;
  sourceContext: boolean;
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
}): string | null {
  if (!input.desktopLocalController || !input.supported)
    return "Namespace worktrees require T3 Desktop's local controller. No local worktree was created.";
  if (input.multipleModels)
    return "Namespace worktrees do not yet support sending to multiple models.";
  if (input.sourceContext)
    return "Remove machine-bound terminal, preview, review and thread context before sending to a Namespace worktree.";
  if (input.attachments.some((attachment) => attachment.file === null))
    return "Reattach files whose bytes are no longer available before sending to a Namespace worktree.";
  return null;
}

export function validateNamespaceWorktreeModel(input: {
  selection: ModelSelection;
  driver: ProviderDriverKind;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  models: ReadonlyArray<ServerProviderModel>;
}): void {
  const entry = input.entries.find(
    (candidate) => candidate.instanceId === input.selection.instanceId,
  );
  if (
    !entry ||
    entry.driverKind !== input.driver ||
    !entry.enabled ||
    !entry.installed ||
    !entry.isAvailable ||
    entry.status === "error" ||
    entry.status === "disabled" ||
    entry.snapshot.auth.status === "unauthenticated"
  )
    throw new Error(
      "The selected provider is unavailable in the Namespace image. Your draft has been kept.",
    );
  const model = input.models.find((candidate) => candidate.slug === input.selection.model);
  if (!model)
    throw new Error(
      "The selected model is unavailable in the Namespace image. Your draft has been kept.",
    );
  for (const option of input.selection.options ?? []) {
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === option.id,
    );
    if (
      !descriptor ||
      (descriptor.type === "boolean"
        ? typeof option.value !== "boolean"
        : !descriptor.options.some((candidate) => candidate.id === option.value))
    )
      throw new Error(
        `The Namespace image does not support the selected model option '${option.id}'. Your draft has been kept.`,
      );
  }
}

export function namespaceWorktreeAttachments(
  requestId: string,
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment> {
  return attachments.map((attachment) => {
    if (attachment.file === null)
      throw new Error(`Reattach '${attachment.name}' before sending to Namespace.`);
    if (attachment.type === "image") return { ...attachment, id: `${requestId}-${attachment.id}` };
    const {
      uploadedAttachmentId: _uploaded,
      uploadEnvironmentId: _environment,
      ...local
    } = attachment;
    return { ...local, id: `${requestId}-${attachment.id}` };
  });
}
