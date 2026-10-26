import { expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { sendNamespaceWorktree } from "./namespaceWorktree";
import { createNamespaceWorktreeAttemptStore } from "./namespaceWorktreeAttempt";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { completeNamespaceWorktreeDraft } from "./namespaceWorktreeDraft";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  snapshot: vi.fn(),
  prepareAttachments: vi.fn(),
  upload: vi.fn(),
  release: vi.fn(),
  entries: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.run,
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../connection/onboarding", () => ({ connectSshEnvironment: "connect" }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: mocks.snapshot, subscribe: mocks.subscribe },
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: {
    presentationsAtom: "presentations",
    providersByEnvironmentAtom: "providers",
  },
}));
vi.mock("../state/namespaceWorktrees", () => ({
  namespaceWorktreeEnvironment: { prepare: "prepare" },
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { startTurn: "start" } }));
vi.mock("../providerInstances", () => ({
  deriveProviderInstanceEntries: mocks.entries,
  applyProviderInstanceSettings: (entries: unknown) => entries,
}));
vi.mock("../components/ChatView.logic", () => ({
  boundAttachmentIds: (attachments: ReadonlyArray<{ id: string }>) =>
    attachments.map((attachment) => attachment.id),
  withMessageContext: ({ text, context }: { text: string; context: unknown }) => ({
    text,
    context,
  }),
}));
vi.mock("../components/chat/chatViewSend", () => ({
  prepareTurnAttachments: mocks.prepareAttachments,
}));
vi.mock("../components/chat/composerAttachmentFiles", () => ({
  fileAttachmentCapabilityBlockReason: () => null,
}));
vi.mock("./attachmentUploadQueue", () => ({
  awaitAttachmentUploads: async () => {},
  releaseDraftAttachments: mocks.release,
  startAttachmentUpload: mocks.upload,
  retryAttachmentUpload: mocks.upload,
  readAttachmentUpload: () => undefined,
}));

function setup() {
  vi.clearAllMocks();
  mocks.subscribe.mockImplementation(() => mocks.unsubscribe);
  const source = EnvironmentId.make("source");
  const remote = EnvironmentId.make("remote");
  const projectId = ProjectId.make("project");
  const targetProjectId = ProjectId.make("remote-project");
  const instanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const model = { slug: "model", name: "Model", isCustom: false, capabilities: null };
  mocks.entries.mockReturnValue([
    {
      instanceId,
      driverKind: driver,
      enabled: true,
      installed: true,
      isAvailable: true,
      status: "ready",
      snapshot: { auth: { status: "authenticated" } },
    },
  ]);
  mocks.snapshot.mockReturnValue({
    presentation: {
      connection: { phase: "connected" },
      serverConfig: {
        settings: {},
        environment: { capabilities: { attachmentUploads: true, inlineMessageContext: true } },
      },
    },
    providers: [{ instanceId, models: [model] }],
  });
  const prepared = {
    connection: { type: "ssh", target: { alias: "new-vm" } },
    targetProjectId,
    workspaceStrategy: {
      type: "existing_worktree",
      worktreePath: "/workspace/worktree",
      branch: "feature",
    },
  };
  mocks.run.mockImplementation(async (_registry, command) => ({
    _tag: "Success",
    value: command === "prepare" ? prepared : command === "connect" ? remote : { sequence: 1 },
  }));
  mocks.prepareAttachments.mockResolvedValue([{ type: "file", id: "remote-upload" }]);
  const attachment = {
    type: "file" as const,
    id: "file",
    name: "file.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    file: new File(["x"], "file.txt"),
    uploadedAttachmentId: "source-upload",
    uploadEnvironmentId: source,
  };
  const input: Parameters<typeof sendNamespaceWorktree>[0] = {
    sourceEnvironmentId: source,
    preparation: { projectId, requestId: "stable-request", baseRef: "main" },
    threadId: ThreadId.make("thread"),
    title: "First prompt",
    text: "Do the work",
    promptAtSend: "Do the work",
    selection: { instanceId, model: "model" },
    driver,
    runtimeMode: "full-access",
    interactionMode: "default",
    snapshot: {
      images: [],
      files: [attachment],
      attachments: [attachment],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      messageText: "Do the work",
    },
    buildContext: () => undefined,
  };
  const persisted = new Map<string, string>();
  const storage = {
    getItem: (key: string) => persisted.get(key) ?? null,
    setItem: (key: string, value: string) => {
      persisted.set(key, value);
    },
  };
  const attempts = createNamespaceWorktreeAttemptStore(storage);
  const send = (request: Parameters<typeof sendNamespaceWorktree>[0]) =>
    sendNamespaceWorktree(request, attempts);
  return { input, source, remote, targetProjectId, attachment, send, storage };
}

it("launches the first prompt only on the returned SSH environment and prepared remote project", async () => {
  const { input, remote, targetProjectId, attachment, send } = setup();
  const buildContext = vi.fn(() => undefined);
  const ref = await send({ ...input, buildContext });
  expect(ref.threadRef).toEqual({ environmentId: remote, threadId: input.threadId });
  expect(mocks.run.mock.calls.map((call) => call[1])).toEqual(["prepare", "connect", "start"]);
  const launch = mocks.run.mock.calls[2]![2];
  expect(launch).toMatchObject({
    environmentId: remote,
    input: {
      threadId: input.threadId,
      commandId: CommandId.make("stable-request-launch"),
      modelSelection: input.selection,
      message: {
        messageId: MessageId.make(input.threadId),
        text: "Do the work",
        attachments: [{ id: "remote-upload" }],
      },
      bootstrap: {
        createThread: {
          projectId: targetProjectId,
          worktreePath: "/workspace/worktree",
          branch: "feature",
        },
      },
    },
  });
  expect(launch.input.bootstrap).not.toHaveProperty("prepareWorktree");
  expect(mocks.upload).toHaveBeenCalledWith({
    environmentId: remote,
    image: expect.objectContaining({ id: "stable-request-file", file: attachment.file }),
  });
  expect(mocks.upload.mock.calls[0]![0].image).not.toHaveProperty("uploadedAttachmentId");
  expect(buildContext).toHaveBeenCalledWith(["file"]);
  expect(attachment.uploadedAttachmentId).toBe("source-upload");
});

it("leaves the snapshot intact and does not upload or launch after a preparation failure", async () => {
  const { input, attachment, send } = setup();
  mocks.run.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("capacity") });
  await expect(send(input)).rejects.toThrow("capacity");
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(input.snapshot.messageText).toBe("Do the work");
  expect(input.snapshot.attachments).toEqual([attachment]);
});

it("does not upload or launch when the selected provider is unavailable in the image", async () => {
  const { input, send } = setup();
  mocks.entries.mockReturnValue([]);
  await expect(send(input)).rejects.toThrow("provider");
  expect(mocks.run.mock.calls.map((call) => call[1])).toEqual(["prepare", "connect"]);
  expect(mocks.upload).not.toHaveBeenCalled();
});

it("retries a lost launch reply with the same VM, thread, command and message identities", async () => {
  const { input, send } = setup();
  mocks.run.mockImplementationOnce(async () => ({
    _tag: "Success",
    value: {
      connection: { type: "ssh", target: {} },
      targetProjectId: ProjectId.make("remote-project"),
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: "/workspace/worktree",
        branch: "feature",
      },
    },
  }));
  mocks.run.mockImplementationOnce(async () => ({
    _tag: "Success",
    value: EnvironmentId.make("remote"),
  }));
  mocks.run.mockImplementationOnce(async () => ({
    _tag: "Failure",
    cause: Cause.fail(new Error("reply lost")),
  }));
  await expect(send(input)).rejects.toBeDefined();
  const first = mocks.run.mock.calls[2]![2];
  await send(input);
  const second = mocks.run.mock.calls[3]![2];
  expect(second.environmentId).toBe(first.environmentId);
  expect(second.input.commandId).toBe(first.input.commandId);
  expect(second.input.message).toEqual(first.input.message);
  expect(second.input.threadId).toBe(first.input.threadId);
  expect(second).toEqual(first);
});

it("cleans up safely when subscribing synchronously publishes the ready environment", async () => {
  const { input, send } = setup();
  mocks.subscribe.mockImplementation((_atom, callback) => {
    callback(mocks.snapshot());
    return mocks.unsubscribe;
  });
  await expect(send(input)).resolves.toMatchObject({
    threadRef: { environmentId: EnvironmentId.make("remote") },
  });
  expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
});

it("replays accepted A exactly after a lost reply and retains edited B with a fresh source identity", async () => {
  const { input, source, send } = setup();
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  const store = useComposerDraftStore.getState();
  const draftId = DraftId.make("draft-retry");
  store.setProjectDraftThreadId(scopeProjectRef(source, input.preparation.projectId), draftId, {
    threadId: input.threadId,
    envMode: "worktree",
  });
  store.setPrompt(draftId, input.promptAtSend);
  store.addFiles(draftId, [...input.snapshot.files], { appendReference: false });
  const normalRun = mocks.run.getMockImplementation()!;
  mocks.run.mockImplementation(async (...args) =>
    args[1] === "start"
      ? { _tag: "Failure", cause: new Error("accepted A, reply lost") }
      : normalRun(...args),
  );
  await expect(send(input)).rejects.toThrow("reply lost");
  const firstLaunch = mocks.run.mock.calls.find((call) => call[1] === "start")![2];
  const newFile = {
    ...input.snapshot.files[0]!,
    id: "B-file",
    name: "B.txt",
    file: new File(["B"], "B.txt"),
  };
  store.setPrompt(draftId, "edited B");
  store.addFiles(draftId, [newFile], { appendReference: false });
  const draftB = store.getComposerDraft(draftId);
  mocks.run.mockImplementation(normalRun);
  const result = await send({
    ...input,
    text: "edited B",
    promptAtSend: "edited B",
    title: "B",
    selection: { ...input.selection, model: "B-model" },
    runtimeMode: "approval-required",
    snapshot: {
      ...input.snapshot,
      messageText: "edited B",
      files: [newFile],
      attachments: [newFile],
    },
  });
  const launches = mocks.run.mock.calls
    .filter((call) => call[1] === "start")
    .map((call) => call[2]);
  expect(launches).toEqual([firstLaunch, firstLaunch]);
  expect(launches[1].input.message.text).toBe("Do the work");
  expect(launches[1].input.modelSelection).toEqual(input.selection);
  expect(result.promptAtSend).toBe(input.promptAtSend);
  expect(
    completeNamespaceWorktreeDraft({
      draftId,
      threadId: input.threadId,
      remoteRef: result.threadRef,
      promptAtSend: result.promptAtSend,
      snapshot: result.snapshot,
    }),
  ).toBe("retained");
  expect(store.getComposerDraft(draftId)).toBe(draftB);
  expect(store.getComposerDraft(draftId)?.prompt).toBe("edited B");
  expect(store.getComposerDraft(draftId)?.files).toContainEqual(newFile);
  expect(store.getDraftSession(draftId)?.threadId).not.toBe(input.threadId);
  expect(store.getDraftSession(draftId)?.environmentId).toBe(source);
});

it("blocks replay after reload before any request and leaves edited input untouched", async () => {
  const { input, send, storage } = setup();
  mocks.run.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("reply lost") });
  await expect(send(input)).rejects.toThrow("reply lost");
  mocks.run.mockClear();
  const edited = { ...input, promptAtSend: "B", text: "B" };
  await expect(
    sendNamespaceWorktree(edited, createNamespaceWorktreeAttemptStore(storage)),
  ).rejects.toThrow("replay is blocked");
  expect(mocks.run).not.toHaveBeenCalled();
  expect(edited.text).toBe("B");
  expect(edited.snapshot.files[0]?.file).toBe(input.snapshot.files[0]?.file);
});

it("does not report a pending normal draft when storage is unavailable but blocks Namespace before requests", async () => {
  const { input } = setup();
  const attempts = createNamespaceWorktreeAttemptStore({
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
  });
  expect(attempts.has(input.threadId)).toBe(false);
  await expect(sendNamespaceWorktree(input, attempts)).rejects.toThrow("storage unavailable");
  expect(mocks.run).not.toHaveBeenCalled();
});

it("detects a pending attempt independently of the current policy, including after reload", async () => {
  const { input, send, storage } = setup();
  mocks.run.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("reply lost") });
  await expect(send(input)).rejects.toThrow("reply lost");
  const reloaded = createNamespaceWorktreeAttemptStore(storage);
  expect(reloaded.has(input.threadId)).toBe(true);
  expect(reloaded.has(ThreadId.make("different-draft"))).toBe(false);
  expect(() => reloaded.capture({ ...input, text: "B" })).toThrow("replay is blocked");
});
