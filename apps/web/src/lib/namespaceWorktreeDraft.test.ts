import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { completeNamespaceWorktreeDraft } from "./namespaceWorktreeDraft";

function setup() {
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  const store = useComposerDraftStore.getState();
  const draftId = DraftId.make("draft");
  const threadId = ThreadId.make("original-thread");
  const project = scopeProjectRef(EnvironmentId.make("source"), ProjectId.make("project"));
  store.setProjectDraftThreadId(project, draftId, {
    threadId,
    envMode: "worktree",
    branch: "main",
  });
  store.setPrompt(draftId, "first prompt");
  const remoteRef = scopeThreadRef(EnvironmentId.make("remote"), threadId);
  return {
    store,
    draftId,
    threadId,
    project,
    remoteRef,
    input: {
      draftId,
      threadId,
      remoteRef,
      promptAtSend: "first prompt",
      snapshot: {
        images: [],
        files: [],
        attachments: [],
        terminalContexts: [],
        previewAnnotations: [],
        reviewComments: [],
        threadContexts: [],
        messageText: "first prompt",
      },
    },
  };
}

it("finalizes an unchanged first-send draft without leaving the sent prompt in the remote composer", () => {
  const { store, draftId, remoteRef, input } = setup();
  expect(completeNamespaceWorktreeDraft(input)).toBe("promoted");
  expect(store.getDraftSession(draftId)).toBeNull();
  expect(store.getComposerDraft(remoteRef)?.prompt ?? "").toBe("");
});

it("keeps new text and attachments on the source with a new VM request identity", () => {
  const { store, draftId, threadId, remoteRef, project, input } = setup();
  const file = {
    type: "file" as const,
    id: "new-file",
    name: "new.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    file: new File(["x"], "new.txt"),
    uploadEnvironmentId: project.environmentId,
    uploadedAttachmentId: "new-source-upload",
  };
  store.setPrompt(draftId, "new input while Namespace prepares");
  store.addFiles(draftId, [file], { appendReference: false });
  const before = store.getComposerDraft(draftId);
  expect(completeNamespaceWorktreeDraft(input)).toBe("retained");
  expect(store.getComposerDraft(draftId)).toBe(before);
  expect(store.getComposerDraft(draftId)?.files).toEqual([file]);
  expect(store.getDraftSession(draftId)).toMatchObject({
    environmentId: project.environmentId,
    projectId: project.projectId,
    promotedTo: null,
  });
  expect(store.getDraftSession(draftId)?.threadId).not.toBe(threadId);
  expect(store.getComposerDraft(remoteRef)).toBeNull();
});

it("retains attachments added with unchanged text instead of promoting them to the remote machine", () => {
  const { store, draftId, remoteRef, input } = setup();
  const file = {
    type: "file" as const,
    id: "late-file",
    name: "late.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    file: new File(["x"], "late.txt"),
  };
  store.addFiles(draftId, [file], { appendReference: false });
  expect(completeNamespaceWorktreeDraft(input)).toBe("retained");
  expect(store.getComposerDraft(draftId)?.prompt).toBe("first prompt");
  expect(store.getComposerDraft(draftId)?.files).toEqual([file]);
  expect(store.getComposerDraft(remoteRef)).toBeNull();
});

it("does not mutate a replacement draft when an old send completes", () => {
  const { store, draftId, project, input } = setup();
  store.setDraftThreadContext(draftId, { projectRef: project });
  useComposerDraftStore.setState((state) => ({
    draftThreadsByThreadKey: {
      ...state.draftThreadsByThreadKey,
      [draftId]: {
        ...state.draftThreadsByThreadKey[draftId]!,
        threadId: ThreadId.make("replacement"),
      },
    },
  }));
  store.setPrompt(draftId, "replacement input");
  expect(completeNamespaceWorktreeDraft(input)).toBe("abandoned");
  expect(store.getComposerDraft(draftId)?.prompt).toBe("replacement input");
});
