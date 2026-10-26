import {
  ManagedSandbox,
  OrchestratorMcpFailure,
  SandboxConnectResult,
  SandboxCreateInput,
  SandboxIdInput,
  SandboxListResult,
  NamespaceWorktreePrepareInput,
  NamespaceWorktreePrepareResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SandboxService from "../../../sandboxes/SandboxService.ts";
import * as NamespaceWorktreeService from "../../../sandboxes/NamespaceWorktreeService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    SandboxService.SandboxService,
    NamespaceWorktreeService.NamespaceWorktreeService,
  ],
};

export const SandboxToolkit = Toolkit.make(
  Tool.make("t3_namespace_worktree_prepare", {
    ...shared,
    description:
      "Prepare a fresh billed Namespace VM for a new worktree using the source project's Namespace policy. Reuse requestId across retries. Transfers committed Git history, including unpushed commits, but not uncommitted files. Returns the SSH destination and prepared project/worktree; it does not launch an agent. Connect using a Namespace-capable Desktop client, then start the thread on that environment with existing_worktree. Agent credentials must already be available in the selected image or template.",
    parameters: NamespaceWorktreePrepareInput,
    success: NamespaceWorktreePrepareResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_sandbox_list", {
    ...shared,
    description:
      "List cloud machines managed by this environment. Requires a full-access caller. Configure the provider privately in Connections settings.",
    parameters: Tool.EmptyParams,
    success: SandboxListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_sandbox_create", {
    ...shared,
    description:
      "Create a billed cloud machine from a clean saved snapshot. Persist and reuse requestId on retries. Templates must exclude T3 identities and sessions. Provider authentication may already be present in the image. Creation does not move existing threads. Namespace templateId is an image name, OCI reference, or blueprint:<id>; blueprints keep their own machine shape; ttlSeconds must be 10800 and does not configure its provider plan duration. Namespace Connect requires Desktop and its local controller with devbox CLI login.",
    parameters: SandboxCreateInput,
    success: ManagedSandbox,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_sandbox_refresh", {
    ...shared,
    description:
      "Reconcile the state of a managed cloud machine. An accepted stop or deletion is not its completion.",
    parameters: SandboxIdInput,
    success: ManagedSandbox,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_sandbox_stop", {
    ...shared,
    description:
      "Stop a managed cloud machine, ending its running processes and saving its disk. This can interrupt agents. It does not delete thread history; stopped disk retention is controlled by its provider.",
    parameters: SandboxIdInput,
    success: ManagedSandbox,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_sandbox_resume", {
    ...shared,
    description:
      "Resume a stopped managed cloud machine with its existing disk and T3 identity. Processes restart; their previous in-memory execution is not restored.",
    parameters: SandboxIdInput,
    success: ManagedSandbox,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_sandbox_remove", {
    ...shared,
    description:
      "Permanently delete a managed cloud machine and its files and thread history. Use only on explicit user instruction after preserving the required work. Refresh to confirm completion.",
    parameters: SandboxIdInput,
    success: ManagedSandbox,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_sandbox_connect", {
    ...shared,
    description:
      "Prepare and verify the independent T3 service on a running cloud machine, then mint a short-lived pairing URL. Treat the returned URL as a credential. Existing paired clients can reuse their route after resume.",
    parameters: SandboxIdInput,
    success: SandboxConnectResult,
  }).annotate(Tool.Destructive, true),
);
