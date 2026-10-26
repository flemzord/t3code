import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Settings imports this module, so these wire schemas must not depend on IPC or sandbox modules.
const ErrorCategory = Schema.Literals([
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

export const NamespaceWorktreeSettings = Schema.Struct({
  image: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  machineType: Schema.Literals(["small", "default", "large", "xlarge"]),
});
export type NamespaceWorktreeSettings = typeof NamespaceWorktreeSettings.Type;

export const NamespaceWorktreePreparationInput = Schema.Struct({
  projectId: ProjectId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type NamespaceWorktreePreparationInput = typeof NamespaceWorktreePreparationInput.Type;

export const NamespaceWorktreePrepareInput = Schema.Struct({
  ...NamespaceWorktreePreparationInput.fields,
  baseRef: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  branch: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  startFromOrigin: Schema.optionalKey(Schema.Boolean),
});
export type NamespaceWorktreePrepareInput = typeof NamespaceWorktreePrepareInput.Type;

export const NamespaceWorktreePrepareResult = Schema.Struct({
  sandboxId: Schema.String,
  commitSha: Schema.String,
  connection: Schema.Struct({
    type: Schema.Literal("ssh"),
    target: Schema.Struct({
      alias: Schema.String,
      hostname: Schema.String,
      username: Schema.NullOr(Schema.String),
      port: Schema.NullOr(Schema.Number),
    }),
  }),
  targetProjectId: ProjectId,
  workspaceRoot: Schema.String,
  workspaceStrategy: Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: Schema.String,
    branch: Schema.String,
  }),
});
export type NamespaceWorktreePrepareResult = typeof NamespaceWorktreePrepareResult.Type;

export const NamespaceWorktreePreparation = Schema.Struct({
  ...NamespaceWorktreePreparationInput.fields,
  sandboxId: Schema.String,
  commitSha: Schema.String,
  status: Schema.Literals(["pending", "provisioning", "preparing", "ready", "failed"]),
  lastError: Schema.NullOr(ErrorCategory),
  result: Schema.NullOr(NamespaceWorktreePrepareResult),
});
export type NamespaceWorktreePreparation = typeof NamespaceWorktreePreparation.Type;

export class NamespaceWorktreeError extends Schema.TaggedError<NamespaceWorktreeError>()(
  "NamespaceWorktreeError",
  {
    category: ErrorCategory,
    stage: Schema.Literals(["policy", "source", "storage", "provision", "workspace"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Namespace worktree preparation failed at ${this.stage} (${this.category}).`;
  }
}
