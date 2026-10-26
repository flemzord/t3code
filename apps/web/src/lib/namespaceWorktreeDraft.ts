import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  type DraftId,
  finalizePromotedDraftThreadByRef,
  restoreFailedDraftThread,
  useComposerDraftStore,
} from "../composerDraftStore";
import type { ComposerSendSnapshot } from "../components/ChatView.logic";
import { newThreadId } from "./utils";

export function completeNamespaceWorktreeDraft(input: {
  draftId: DraftId;
  threadId: ThreadId;
  remoteRef: ScopedThreadRef;
  promptAtSend: string;
  snapshot: ComposerSendSnapshot;
}): "promoted" | "retained" | "abandoned" {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(input.draftId);
  if (!session || session.threadId !== input.threadId || session.promotedTo) return "abandoned";
  const current = store.getComposerDraft(input.draftId);
  const unchanged =
    current !== null &&
    current.prompt === input.promptAtSend &&
    current.images.length === input.snapshot.images.length &&
    current.files.length === input.snapshot.files.length &&
    current.images.every(
      (image, index) =>
        image.id === input.snapshot.images[index]?.id &&
        image.file === input.snapshot.images[index]?.file,
    ) &&
    current.files.every(
      (file, index) =>
        file.id === input.snapshot.files[index]?.id &&
        file.file === input.snapshot.files[index]?.file,
    ) &&
    current.terminalContexts.length === 0 &&
    current.previewAnnotations.length === 0 &&
    current.reviewComments.length === 0 &&
    current.threadContexts.length === 0;
  if (!unchanged) {
    // New input belongs to the source machine and needs a fresh VM identity on its next send.
    restoreFailedDraftThread(input.draftId, session, newThreadId());
    return "retained";
  }
  store.clearComposerContent(input.draftId);
  store.markDraftThreadPromoting(input.draftId, input.remoteRef);
  finalizePromotedDraftThreadByRef(input.remoteRef);
  return "promoted";
}
