import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import type { NamespaceWorktreeSendInput } from "./namespaceWorktree";

export function createNamespaceWorktreeAttemptStore(storage: Pick<Storage, "getItem" | "setItem">) {
  const attempts = new Map<
    ThreadId,
    {
      input: NamespaceWorktreeSendInput;
      launch: { environmentId: EnvironmentId; input: StartThreadTurnInput } | null;
    }
  >();
  return {
    has(threadId: ThreadId) {
      if (attempts.has(threadId)) return true;
      try {
        return storage.getItem(`t3:namespace-first-send:v1:${threadId}`) !== null;
      } catch {
        return false;
      }
    },
    capture(input: NamespaceWorktreeSendInput) {
      const previous = attempts.get(input.threadId);
      if (previous) return previous;
      const key = `t3:namespace-first-send:v1:${input.threadId}`;
      if (storage.getItem(key) !== null)
        throw new Error(
          "A previous Namespace send may already be running. Its original message is unavailable after reload, so replay is blocked. Your current draft is unchanged. Check the remote thread before starting a new draft.",
        );
      const images = input.snapshot.images.map((image) => Object.freeze({ ...image }));
      const files = input.snapshot.files.map((file) => Object.freeze({ ...file }));
      const snapshot = Object.freeze({
        ...structuredClone({ ...input.snapshot, images: [], files: [], attachments: [] }),
        images,
        files,
        attachments: [...images, ...files],
      });
      const context = structuredClone(
        input.buildContext(snapshot.attachments.map((attachment) => attachment.id)),
      );
      const captured = Object.freeze({
        ...input,
        preparation: Object.freeze({ ...input.preparation }),
        selection: structuredClone(input.selection),
        snapshot,
        buildContext: (ids: ReadonlyArray<string>) =>
          remapComposerContextAttachments(
            context,
            snapshot.attachments,
            ids.map((id) => ({ id })),
          ),
      });
      // Persist before any request: a reload without the original File objects must block replay.
      storage.setItem(key, "pending");
      const attempt = { input: captured, launch: null };
      attempts.set(input.threadId, attempt);
      return attempt;
    },
    release(threadId: ThreadId) {
      // Keep the durable marker across crashes between acknowledgement and draft persistence.
      attempts.delete(threadId);
    },
  };
}

let browserAttempts: ReturnType<typeof createNamespaceWorktreeAttemptStore> | undefined;
export function namespaceWorktreeAttemptStore() {
  browserAttempts ??= createNamespaceWorktreeAttemptStore({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  });
  return browserAttempts;
}
