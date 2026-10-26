import { OrchestratorMcpFailure, type SandboxOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SandboxService from "../../../sandboxes/SandboxService.ts";
import * as NamespaceWorktreeService from "../../../sandboxes/NamespaceWorktreeService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SandboxToolkit } from "./tools.ts";

const failure = (error: SandboxOperationError) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(SandboxToolkit, {
  t3_namespace_worktree_prepare: McpToolAccess.writesEnvironment((input) =>
    NamespaceWorktreeService.NamespaceWorktreeService.pipe(
      Effect.flatMap((service) => service.prepare(input)),
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: error.message,
          }),
      ),
    ),
  ),
  t3_sandbox_list: McpToolAccess.writesEnvironment(() =>
    SandboxService.SandboxService.pipe(
      Effect.flatMap((service) => service.list()),
      Effect.mapError(failure),
    ),
  ),
  t3_sandbox_create: McpToolAccess.writesEnvironment((input) =>
    SandboxService.SandboxService.pipe(
      Effect.flatMap((service) => service.create(input)),
      Effect.mapError(failure),
    ),
  ),
  t3_sandbox_refresh: McpToolAccess.writesEnvironment((input) =>
    SandboxService.SandboxService.pipe(
      Effect.flatMap((service) => service.refresh(input)),
      Effect.mapError(failure),
    ),
  ),
  t3_sandbox_stop: McpToolAccess.writesEnvironment((input) =>
    SandboxService.SandboxService.pipe(
      Effect.flatMap((service) => service.stop(input)),
      Effect.mapError(failure),
    ),
  ),
  t3_sandbox_resume: McpToolAccess.writesEnvironment((input) =>
    SandboxService.SandboxService.pipe(
      Effect.flatMap((service) => service.resume(input)),
      Effect.mapError(failure),
    ),
  ),
  t3_sandbox_remove: McpToolAccess.writesEnvironment((input) =>
    SandboxService.SandboxService.pipe(
      Effect.flatMap((service) => service.remove(input)),
      Effect.mapError(failure),
    ),
  ),
  t3_sandbox_connect: McpToolAccess.writesEnvironment((input) =>
    SandboxService.SandboxService.pipe(
      Effect.flatMap((service) => service.connect(input)),
      Effect.mapError(failure),
    ),
  ),
});
