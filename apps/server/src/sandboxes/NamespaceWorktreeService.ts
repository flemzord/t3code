import {
  ProjectId,
  type SandboxCreateInput,
  SandboxOperationError,
  NamespaceWorktreeError,
  NamespaceWorktreePreparation,
  NamespaceWorktreePrepareInput,
  type NamespaceWorktreePreparationInput,
  type NamespaceWorktreePrepareResult,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxService from "./SandboxService.ts";
import type { WorkspaceInput, WorkspaceResult } from "./namespaceWorkspace.ts";

export class NamespaceWorkspaceTransport extends Context.Service<
  NamespaceWorkspaceTransport,
  {
    readonly prepare: (
      input: WorkspaceInput,
    ) => Effect.Effect<WorkspaceResult, SandboxOperationError>;
  }
>()("t3/sandboxes/NamespaceWorktreeService/NamespaceWorkspaceTransport") {}

const StoredPreparation = Schema.Struct({
  ...NamespaceWorktreePreparation.fields,
  baseRef: Schema.String,
  requestedBranch: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.Boolean,
  branch: Schema.String,
  repositoryRoot: Schema.String,
  remoteUrl: Schema.optionalKey(Schema.String),
  projectSubdirectory: Schema.String,
  projectTitle: Schema.String,
  remoteProjectId: ProjectId,
  creationAccepted: Schema.Boolean,
  createInput: Schema.Struct({
    requestId: Schema.String,
    name: Schema.String,
    templateId: Schema.String,
    machineType: Schema.Literals(["small", "default", "large", "xlarge"]),
  }),
});
type StoredPreparation = typeof StoredPreparation.Type;
const State = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), operations: Schema.Array(StoredPreparation) }),
);
const encodeState = Schema.encodeEffect(State);
const decodePreparation = Schema.decodeUnknownEffect(NamespaceWorktreePreparation);
const decodePrepareInput = Schema.decodeUnknownEffect(NamespaceWorktreePrepareInput);
const encodeRequestKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([ProjectId, Schema.String])),
);

interface Work {
  readonly input: NamespaceWorktreePrepareInput;
  readonly done: Deferred.Deferred<NamespaceWorktreePrepareResult, NamespaceWorktreeError>;
}

function transferableRemote(value: string): string | undefined {
  if (/^[\w.-]+@[\w.-]+:[^\s\0]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol === "https:" && url.username)
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export class NamespaceWorktreeService extends Context.Service<
  NamespaceWorktreeService,
  {
    readonly prepare: (
      input: NamespaceWorktreePrepareInput,
    ) => Effect.Effect<NamespaceWorktreePrepareResult, NamespaceWorktreeError>;
    readonly getPreparation: (
      input: NamespaceWorktreePreparationInput,
    ) => Effect.Effect<NamespaceWorktreePreparation | null, NamespaceWorktreeError>;
  }
>()("t3/sandboxes/NamespaceWorktreeService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sandboxes = yield* SandboxService.SandboxService;
  const transport = yield* NamespaceWorkspaceTransport;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const queue = yield* Queue.unbounded<Work>();
  const queued = new Map<string, Work>();
  const queueLock = yield* Semaphore.make(1);
  const operationsLock = yield* KeyedLock.make<string>();
  const stateLock = yield* Semaphore.make(1);
  const filePath = path.join(config.stateDir, "namespace-worktrees.json");
  let operations = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(State)),
    Effect.map((state) => state.operations),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed([])
          : Effect.fail(
              new NamespaceWorktreeError({ category: "storage", stage: "storage", cause }),
            ),
    }),
    Effect.mapError(
      (cause) => new NamespaceWorktreeError({ category: "storage", stage: "storage", cause }),
    ),
  );
  const persist = Effect.fn("NamespaceWorktreeService.persist")(function* (
    record: StoredPreparation,
  ) {
    return yield* stateLock.withPermit(
      Effect.gen(function* () {
        const next = [
          ...operations.filter((entry) => entry.sandboxId !== record.sandboxId),
          record,
        ];
        const contents = yield* encodeState({ version: 1, operations: next });
        yield* writeFileStringAtomically({ filePath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        operations = next;
        return record;
      }).pipe(
        Effect.mapError(
          (cause) => new NamespaceWorktreeError({ category: "storage", stage: "storage", cause }),
        ),
        Effect.uninterruptible,
      ),
    );
  });
  const git = Effect.fn("NamespaceWorktreeService.git")(function* (
    cwd: string,
    args: readonly string[],
  ) {
    const result = yield* runner
      .run({ command: "git", args, cwd, timeout: "5 minutes", maxOutputBytes: 16384 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new NamespaceWorktreeError({ category: "invalid_input", stage: "source", cause }),
        ),
      );
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.stdoutInvalidUtf8
    )
      return yield* new NamespaceWorktreeError({ category: "invalid_input", stage: "source" });
    return result.stdout.trim();
  });
  const getPreparation = Effect.fn("NamespaceWorktreeService.getPreparation")(function* (
    input: NamespaceWorktreePreparationInput,
  ) {
    const record = operations.find(
      (entry) => entry.projectId === input.projectId && entry.requestId === input.requestId,
    );
    return record
      ? yield* decodePreparation(record).pipe(
          Effect.mapError(
            (cause) => new NamespaceWorktreeError({ category: "storage", stage: "storage", cause }),
          ),
        )
      : null;
  });
  const runPreparation = Effect.fn("NamespaceWorktreeService.runPreparation")(function* (
    request: NamespaceWorktreePrepareInput,
  ) {
    const input = yield* decodePrepareInput(request).pipe(
      Effect.mapError(
        (cause) =>
          new NamespaceWorktreeError({ category: "invalid_input", stage: "source", cause }),
      ),
    );
    return yield* operationsLock.withLock(
      encodeRequestKey([input.projectId, input.requestId]),
      Effect.gen(function* () {
        let record = operations.find(
          (entry) => entry.projectId === input.projectId && entry.requestId === input.requestId,
        );
        if (record) {
          if (
            record.baseRef !== input.baseRef ||
            record.requestedBranch !== (input.branch ?? null) ||
            record.startFromOrigin !== (input.startFromOrigin ?? false)
          )
            return yield* new NamespaceWorktreeError({ category: "conflict", stage: "source" });
          if (record.result) return record.result;
        } else {
          const project = yield* projects
            .getById(input.projectId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new NamespaceWorktreeError({ category: "not_found", stage: "source", cause }),
              ),
            );
          if (Option.isNone(project))
            return yield* new NamespaceWorktreeError({ category: "not_found", stage: "source" });
          const serverSettings = yield* settings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new NamespaceWorktreeError({ category: "storage", stage: "policy", cause }),
            ),
          );
          const policy = resolveProjectSettings(serverSettings, input.projectId).settings
            .namespaceWorktrees;
          if (!policy)
            return yield* new NamespaceWorktreeError({
              category: "not_configured",
              stage: "policy",
            });
          if (
            /^[\s-]|[\r\n\0]/.test(input.baseRef) ||
            (input.branch && /^-|[\r\n\0]/.test(input.branch))
          )
            return yield* new NamespaceWorktreeError({
              category: "invalid_input",
              stage: "source",
            });
          const workspaceRoot = yield* fs
            .realPath(project.value.workspaceRoot)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new NamespaceWorktreeError({ category: "invalid_input", stage: "source", cause }),
              ),
            );
          const repositoryRoot = yield* git(workspaceRoot, ["rev-parse", "--show-toplevel"]);
          const origin = yield* git(repositoryRoot, ["remote", "get-url", "origin"]).pipe(
            Effect.option,
          );
          const remoteUrl = Option.isSome(origin) ? transferableRemote(origin.value) : undefined;
          const projectSubdirectory = path
            .relative(repositoryRoot, workspaceRoot)
            .split(path.sep)
            .join("/");
          if (
            projectSubdirectory === ".." ||
            projectSubdirectory.startsWith("../") ||
            path.isAbsolute(projectSubdirectory)
          )
            return yield* new NamespaceWorktreeError({
              category: "invalid_input",
              stage: "source",
            });
          const remoteBase = input.startFromOrigin
            ? yield* gitWorkflow
                .fetchWorktreeBaseCommit({ cwd: repositoryRoot, refName: input.baseRef })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new NamespaceWorktreeError({
                        category: "unavailable",
                        stage: "source",
                        cause,
                      }),
                  ),
                )
            : null;
          const commitSha = yield* git(repositoryRoot, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${remoteBase?.commitSha ?? input.baseRef}^{commit}`,
          ]);
          if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha))
            return yield* new NamespaceWorktreeError({
              category: "invalid_input",
              stage: "source",
            });
          const modes = yield* runner
            .run({
              command: "git",
              cwd: repositoryRoot,
              args: ["ls-tree", "-r", "--format=%(objectmode)", commitSha],
              maxOutputBytes: 8 * 1024 * 1024,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new NamespaceWorktreeError({
                    category: "invalid_input",
                    stage: "source",
                    cause,
                  }),
              ),
            );
          const lfs = yield* runner
            .run({
              command: "git",
              cwd: repositoryRoot,
              args: [
                "grep",
                "-I",
                "-l",
                "-E",
                "filter[[:space:]]*=[[:space:]]*lfs",
                commitSha,
                "--",
                ":(glob)**/.gitattributes",
              ],
              maxOutputBytes: 16384,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new NamespaceWorktreeError({
                    category: "invalid_input",
                    stage: "source",
                    cause,
                  }),
              ),
            );
          // Git bundles carry neither submodule repositories nor Git LFS objects.
          if (
            modes.code !== 0 ||
            modes.timedOut ||
            modes.stdoutTruncated ||
            modes.stdout.split("\n").includes("160000") ||
            lfs.code !== 1 ||
            lfs.timedOut
          )
            return yield* new NamespaceWorktreeError({
              category: "invalid_input",
              stage: "source",
            });
          if (
            projectSubdirectory &&
            (yield* git(repositoryRoot, [
              "cat-file",
              "-t",
              `${commitSha}:${projectSubdirectory}`,
            ])) !== "tree"
          )
            return yield* new NamespaceWorktreeError({
              category: "invalid_input",
              stage: "source",
            });
          const digest = yield* crypto
            .digest(
              "SHA-256",
              new TextEncoder().encode(encodeRequestKey([input.projectId, input.requestId])),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new NamespaceWorktreeError({ category: "storage", stage: "storage", cause }),
              ),
            );
          const id = `nsw-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          const branch = input.branch ?? `t3/${id}`;
          yield* git(repositoryRoot, ["check-ref-format", "--branch", branch]);
          record = yield* persist({
            projectId: input.projectId,
            requestId: input.requestId,
            baseRef: input.baseRef,
            requestedBranch: input.branch ?? null,
            startFromOrigin: input.startFromOrigin ?? false,
            sandboxId: `namespace:${id}`,
            commitSha,
            branch,
            repositoryRoot,
            ...(remoteUrl ? { remoteUrl } : {}),
            projectSubdirectory,
            projectTitle: project.value.title,
            remoteProjectId: ProjectId.make(id),
            createInput: {
              requestId: id,
              name: "Worktree",
              templateId: policy.image,
              machineType: policy.machineType,
            },
            status: "pending",
            lastError: null,
            result: null,
            creationAccepted: false,
          });
        }
        let current = record;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs
              .makeTempDirectoryScoped({ prefix: "t3-namespace-bundle-" })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new NamespaceWorktreeError({ category: "storage", stage: "source", cause }),
                ),
              );
            const snapshot = path.join(directory, "snapshot.git");
            const bundlePath = path.join(directory, "source.bundle");
            yield* git(directory, ["init", "--bare", snapshot]);
            yield* git(snapshot, [
              "fetch",
              "--no-tags",
              "--",
              current.repositoryRoot,
              `${current.commitSha}:refs/heads/t3-source`,
            ]);
            yield* git(snapshot, ["bundle", "create", bundlePath, "refs/heads/t3-source"]);
            if (!current.creationAccepted) {
              const createInput: SandboxCreateInput = {
                ...current.createInput,
                provider: "namespace",
                ttlSeconds: 10800,
              };
              const sandbox = yield* sandboxes.create(createInput).pipe(
                Effect.mapError(
                  (cause) =>
                    new NamespaceWorktreeError({
                      category: cause.category,
                      stage: "provision",
                      cause,
                    }),
                ),
              );
              current = yield* persist({
                ...current,
                sandboxId: sandbox.id,
                status: "provisioning",
                lastError: null,
                creationAccepted: true,
              });
            }
            const connection = yield* sandboxes.connect({ id: current.sandboxId }).pipe(
              Effect.retry({
                times: 30,
                schedule: Schedule.spaced("2 seconds"),
                while: (error) => error.category === "conflict" || error.category === "unavailable",
              }),
              Effect.mapError(
                (cause) =>
                  new NamespaceWorktreeError({
                    category: cause.category,
                    stage: "provision",
                    cause,
                  }),
              ),
            );
            if (connection.type !== "ssh")
              return yield* new NamespaceWorktreeError({
                category: "connection",
                stage: "provision",
              });
            const inventory = yield* sandboxes.list().pipe(
              Effect.mapError(
                (cause) =>
                  new NamespaceWorktreeError({
                    category: cause.category,
                    stage: "provision",
                    cause,
                  }),
              ),
            );
            const sandbox = inventory.sandboxes.find((entry) => entry.id === current.sandboxId);
            if (!sandbox?.providerId)
              return yield* new NamespaceWorktreeError({
                category: "uncertain",
                stage: "provision",
              });
            current = yield* persist({ ...current, status: "preparing", lastError: null });
            const workspace = yield* transport
              .prepare({
                providerId: sandbox.providerId,
                bundlePath,
                commitSha: current.commitSha,
                projectSubdirectory: current.projectSubdirectory,
                branch: current.branch,
                requestId: current.createInput.requestId,
                projectTitle: current.projectTitle,
                remoteProjectId: current.remoteProjectId,
                ...(current.remoteUrl ? { remoteUrl: current.remoteUrl } : {}),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new NamespaceWorktreeError({
                      category: cause.category,
                      stage: "workspace",
                      cause,
                    }),
                ),
              );
            const result: NamespaceWorktreePrepareResult = {
              sandboxId: current.sandboxId,
              commitSha: current.commitSha,
              connection,
              targetProjectId: ProjectId.make(workspace.projectId),
              workspaceRoot: workspace.workspaceRoot,
              workspaceStrategy: {
                type: "existing_worktree",
                worktreePath: workspace.worktreePath,
                branch: workspace.branch,
              },
            };
            yield* persist({ ...current, status: "ready", lastError: null, result });
            return result;
          }),
        ).pipe(
          Effect.tapError((error) =>
            persist({ ...current, status: "failed", lastError: error.category }),
          ),
        );
      }),
    );
  });

  const enqueue = Effect.fn("NamespaceWorktreeService.enqueue")(function* (
    input: NamespaceWorktreePrepareInput,
  ) {
    return yield* queueLock.withPermit(
      Effect.gen(function* () {
        const key = encodeRequestKey([input.projectId, input.requestId]);
        const existing = queued.get(key);
        if (existing) {
          if (
            existing.input.baseRef !== input.baseRef ||
            (existing.input.branch ?? null) !== (input.branch ?? null) ||
            (existing.input.startFromOrigin ?? false) !== (input.startFromOrigin ?? false)
          )
            return yield* new NamespaceWorktreeError({ category: "conflict", stage: "source" });
          return existing.done;
        }
        const done = yield* Deferred.make<NamespaceWorktreePrepareResult, NamespaceWorktreeError>();
        const work = { input, done };
        queued.set(key, work);
        yield* Queue.offer(queue, work);
        return done;
      }).pipe(Effect.uninterruptible),
    );
  });
  const process = Effect.fn("NamespaceWorktreeService.process")(function* (work: Work) {
    const result = yield* Effect.exit(runPreparation(work.input));
    queued.delete(encodeRequestKey([work.input.projectId, work.input.requestId]));
    yield* Deferred.done(work.done, result);
  });
  yield* Effect.forever(Queue.take(queue).pipe(Effect.flatMap(process))).pipe(Effect.forkIn(scope));
  for (const record of operations) {
    if (
      record.status === "pending" ||
      record.status === "provisioning" ||
      record.status === "preparing"
    ) {
      yield* enqueue({
        projectId: record.projectId,
        requestId: record.requestId,
        baseRef: record.baseRef,
        ...(record.requestedBranch === null ? {} : { branch: record.requestedBranch }),
        startFromOrigin: record.startFromOrigin,
      });
    }
  }
  const prepare = Effect.fn("NamespaceWorktreeService.prepare")(function* (
    request: NamespaceWorktreePrepareInput,
  ) {
    const input = yield* decodePrepareInput(request).pipe(
      Effect.mapError(
        (cause) =>
          new NamespaceWorktreeError({ category: "invalid_input", stage: "source", cause }),
      ),
    );
    return yield* Deferred.await(yield* enqueue(input));
  });
  return NamespaceWorktreeService.of({ prepare, getPreparation });
});
export const layer = Layer.effect(NamespaceWorktreeService, make);
