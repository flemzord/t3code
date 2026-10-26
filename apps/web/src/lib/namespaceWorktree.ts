import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { namespaceWorktreeAttemptStore } from "./namespaceWorktreeAttempt";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type NamespaceWorktreePrepareInput,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Atom } from "effect/reactivity";
import { connectSshEnvironment } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { namespaceWorktreeEnvironment } from "../state/namespaceWorktrees";
import { threadEnvironment } from "../state/threads";
import { applyProviderInstanceSettings, deriveProviderInstanceEntries } from "../providerInstances";
import {
  boundAttachmentIds,
  withMessageContext,
  type ComposerSendSnapshot,
} from "../components/ChatView.logic";
import { prepareTurnAttachments } from "../components/chat/chatViewSend";
import { fileAttachmentCapabilityBlockReason } from "../components/chat/composerAttachmentFiles";
import {
  awaitAttachmentUploads,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
  readAttachmentUpload,
} from "./attachmentUploadQueue";
import {
  namespaceWorktreeAttachments,
  validateNamespaceWorktreeModel,
} from "./namespaceWorktree.logic";

const OPTIONS = { label: "Prepare Namespace worktree", reportFailure: false } as const;

function unwrap<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

function waitForNamespaceEnvironment(environmentId: EnvironmentId) {
  const atom = Atom.make((get) => ({
    presentation: get(environmentPresentations.presentationsAtom).get(environmentId),
    providers: get(environmentPresentations.providersByEnvironmentAtom).get(environmentId),
  }));
  return new Promise<{
    config: Omit<ServerConfig, "providers">;
    providers: ReadonlyArray<ServerProvider>;
  }>((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      unsubscribe();
      reject(
        new Error(
          "The Namespace environment is not ready. Retry to reconnect; your draft has been kept.",
        ),
      );
    }, 30_000);
    const check = (snapshot: Atom.Type<typeof atom>) => {
      if (
        snapshot.presentation?.connection.phase !== "connected" ||
        !snapshot.presentation.serverConfig ||
        !snapshot.providers
      )
        return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve({ config: snapshot.presentation.serverConfig, providers: snapshot.providers });
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    if (settled) unsubscribe();
    else check(appAtomRegistry.get(atom));
  });
}

export interface NamespaceWorktreeSendInput {
  sourceEnvironmentId: EnvironmentId;
  preparation: NamespaceWorktreePrepareInput;
  threadId: ThreadId;
  title: string;
  text: string;
  selection: ModelSelection;
  driver: ProviderDriverKind;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  snapshot: ComposerSendSnapshot;
  promptAtSend: string;
  buildContext: (
    attachmentIds: ReadonlyArray<string>,
  ) => import("@t3tools/contracts").OrchestrationMessageContext | undefined;
}

export async function sendNamespaceWorktree(
  request: NamespaceWorktreeSendInput,
  attempts = namespaceWorktreeAttemptStore(),
) {
  const attempt = attempts.capture(request);
  const input = attempt.input;
  if (attempt.launch) {
    unwrap(
      await runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, attempt.launch, {
        label: "Retry Namespace thread",
        reportFailure: false,
      }),
    );
    releaseDraftAttachments(
      namespaceWorktreeAttachments(input.preparation.requestId, input.snapshot.attachments),
    );
    return {
      threadRef: scopeThreadRef(attempt.launch.environmentId, input.threadId),
      promptAtSend: input.promptAtSend,
      snapshot: input.snapshot,
    };
  }

  const prepared = unwrap(
    await runAtomCommand(
      appAtomRegistry,
      namespaceWorktreeEnvironment.prepare,
      {
        environmentId: input.sourceEnvironmentId,
        input: input.preparation,
      },
      OPTIONS,
    ),
  );
  const environmentId = unwrap(
    await runAtomCommand(
      appAtomRegistry,
      connectSshEnvironment,
      {
        target: prepared.connection.target,
      },
      OPTIONS,
    ),
  );
  const { config, providers } = await waitForNamespaceEnvironment(environmentId);
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    config.settings,
    prepared.targetProjectId,
  );
  const models =
    providers.find((provider) => provider.instanceId === input.selection.instanceId)?.models ?? [];
  validateNamespaceWorktreeModel({
    selection: input.selection,
    driver: input.driver,
    entries,
    models,
  });
  const attachments = namespaceWorktreeAttachments(
    input.preparation.requestId,
    input.snapshot.attachments,
  );
  const usesUploads = config.environment.capabilities.attachmentUploads === true;
  const blockReason = fileAttachmentCapabilityBlockReason({
    files: attachments.filter((attachment) => attachment.type === "file"),
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: usesUploads,
    maxFileAttachmentBytes: config.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  });
  if (blockReason) throw new Error(blockReason);
  if (usesUploads) {
    for (const attachment of attachments) {
      const upload =
        readAttachmentUpload(attachment.id)?.status === "failed"
          ? retryAttachmentUpload
          : startAttachmentUpload;
      upload({ environmentId, image: attachment });
    }
    await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
  }
  const turnAttachments = await prepareTurnAttachments({
    environmentId,
    attachments,
    usesAttachmentUploads: usesUploads,
  });
  const launch: { environmentId: EnvironmentId; input: StartThreadTurnInput } = {
    environmentId,
    input: {
      commandId: CommandId.make(`${input.preparation.requestId}-launch`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(input.threadId),
        role: "user",
        ...withMessageContext({
          text: input.text,
          context: input.buildContext(boundAttachmentIds(turnAttachments, attachments)),
          supportsInlineMessageContext:
            config.environment.capabilities.inlineMessageContext === true,
        }),
        attachments: turnAttachments,
      },
      modelSelection: input.selection,
      titleSeed: input.title,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      bootstrap: {
        createThread: {
          projectId: prepared.targetProjectId,
          title: input.title,
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: prepared.workspaceStrategy.branch,
          worktreePath: prepared.workspaceStrategy.worktreePath,
          createdAt: new Date().toISOString(),
        },
      },
    },
  };
  attempt.launch = launch;
  unwrap(
    await runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, launch, {
      label: "Start Namespace thread",
      reportFailure: false,
    }),
  );

  if (usesUploads) releaseDraftAttachments(attachments);
  return {
    threadRef: scopeThreadRef(environmentId, input.threadId),
    promptAtSend: input.promptAtSend,
    snapshot: input.snapshot,
  };
}
