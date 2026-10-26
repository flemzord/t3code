import * as NodeServices from "@effect/platform-node/NodeServices";
// Real repository fixtures need Node's path handling before building their Effect layer.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  SandboxOperationError,
  type ManagedSandbox,
  type SandboxCreateInput,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { describe } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxService from "./SandboxService.ts";
import * as NamespaceWorktreeService from "./NamespaceWorktreeService.ts";
import type { WorkspaceInput } from "./namespaceWorkspace.ts";

const projectId = ProjectId.make("local-project");
const input = { projectId, requestId: "draft:one", baseRef: "HEAD" };
const policy = { image: "ubuntu", machineType: "small" as const };
const connection = {
  type: "ssh" as const,
  target: { alias: "test.namespace", hostname: "test.namespace", username: null, port: null },
};

const harness = Effect.fn("test.namespaceWorktree.harness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-namespace-worktree-test-" });
  const runner = yield* ProcessRunner.ProcessRunner;
  const git = Effect.fn("test.namespaceWorktree.git")(function* (args: readonly string[]) {
    const result = yield* runner.run({ command: "git", args, cwd: root });
    assert.strictEqual(result.code, 0, result.stderr);
    return result.stdout.trim();
  });
  yield* git(["init", "--initial-branch=main"]);
  yield* git(["config", "user.email", "test@example.com"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["remote", "add", "origin", "git@example.invalid:example/project.git"]);
  yield* fs.makeDirectory(`${root}/app`);
  yield* fs.writeFileString(`${root}/app/file.txt`, "initial");
  yield* git(["add", "app/file.txt"]);
  yield* git(["commit", "-m", "initial"]);
  const commitSha = yield* git(["rev-parse", "HEAD"]);
  const creates: SandboxCreateInput[] = [];
  const prepared: WorkspaceInput[] = [];
  const inventory: ManagedSandbox[] = [];
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const requests = yield* Queue.unbounded<WorkspaceInput>();
  let block = false;
  let fail = false;
  let effectiveSettings: ServerSettingsValue = {
    ...DEFAULT_SERVER_SETTINGS,
    namespaceWorktrees: policy,
  };
  const layer = () =>
    NamespaceWorktreeService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(root, `${root}/state`),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            fetchWorktreeBaseCommit: () => Effect.succeed(null),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.sync(() => effectiveSettings),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "App",
                workspaceRoot: `${root}/app`,
                scripts: [],
                defaultModelSelection: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              }),
          }),
          Layer.mock(SandboxService.SandboxService)({
            create: (request) =>
              Effect.sync(() => {
                creates.push(request);
                const sandbox: ManagedSandbox = {
                  ...request,
                  id: `namespace:${request.requestId}`,
                  providerId: "provider-id",
                  state: "running" as const,
                  connectionState: "unverified" as const,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  lastError: null,
                };
                inventory.push(sandbox);
                return sandbox;
              }),
            connect: () => Effect.succeed(connection),
            list: () => Effect.succeed({ providers: [], sandboxes: inventory }),
          }),
          Layer.succeed(NamespaceWorktreeService.NamespaceWorkspaceTransport, {
            prepare: (request) =>
              Effect.gen(function* () {
                prepared.push(request);
                yield* Queue.offer(requests, request);
                yield* Deferred.succeed(entered, undefined);
                if (block) yield* Deferred.await(release);
                if (fail) return yield* new SandboxOperationError({ category: "bootstrap" });
                const contents = yield* runner.run({
                  command: "git",
                  args: ["bundle", "list-heads", request.bundlePath],
                });
                assert.strictEqual(contents.code, 0);
                assert.include(contents.stdout, request.commitSha);
                assert.strictEqual(request.projectSubdirectory, "app");
                const file = yield* runner.run({
                  command: "git",
                  args: [
                    "--git-dir",
                    NodePath.join(NodePath.dirname(request.bundlePath), "snapshot.git"),
                    "show",
                    `${request.commitSha}:app/file.txt`,
                  ],
                });
                assert.strictEqual(file.code, 0);
                assert.strictEqual(file.stdout, "initial");
                return {
                  projectId: ProjectId.make("remote-project"),
                  worktreePath: "/work/tree/app",
                  workspaceRoot: "/work/repo/app",
                  branch: request.branch,
                };
              }).pipe(Effect.mapError(() => new SandboxOperationError({ category: "bootstrap" }))),
          }),
        ),
      ),
    );
  return {
    root,
    git,
    commitSha,
    creates,
    prepared,
    layer,
    entered,
    release,
    requests,
    updateSettings: (patch: Partial<ServerSettingsValue>) => {
      effectiveSettings = { ...effectiveSettings, ...patch };
    },
    block: () => {
      block = true;
    },
    fail: (value: boolean) => {
      fail = value;
    },
  };
});

const runtime = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

describe("NamespaceWorktreeService", () => {
  it.live("finishes and persists preparation after its caller disconnects", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.block();
      yield* Effect.gen(function* () {
        const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
        const caller = yield* service.prepare(input).pipe(Effect.forkChild);
        yield* Deferred.await(h.entered);
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(h.release, undefined);
        const result = yield* service.prepare(input);
        assert.strictEqual((yield* service.getPreparation(input))?.status, "ready");
        assert.strictEqual(result.commitSha, h.commitSha);
        assert.strictEqual(h.prepared.length, 1);
        assert.strictEqual(h.creates.length, 1);
      }).pipe(Effect.provide(h.layer()));
    }).pipe(Effect.scoped, Effect.provide(runtime)),
  );

  it.live("automatically resumes incomplete preparation on the existing VM after restart", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.block();
      yield* Effect.gen(function* () {
        const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
        const caller = yield* service.prepare(input).pipe(Effect.forkChild);
        yield* Queue.take(h.requests);
        assert.strictEqual((yield* service.getPreparation(input))?.status, "preparing");
        yield* Fiber.interrupt(caller);
      }).pipe(Effect.provide(h.layer()));
      yield* h.git(["commit", "--allow-empty", "-m", "after restart"]);
      h.updateSettings({ namespaceWorktrees: null });
      yield* Effect.gen(function* () {
        const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
        const resumed = yield* Queue.take(h.requests);
        assert.strictEqual(resumed.commitSha, h.commitSha);
        yield* Deferred.succeed(h.release, undefined);
        const result = yield* service.prepare(input);
        assert.strictEqual((yield* service.getPreparation(input))?.status, "ready");
        assert.strictEqual(result.commitSha, h.commitSha);
        assert.strictEqual(h.prepared.length, 2);
        assert.strictEqual(h.creates.length, 1);
      }).pipe(Effect.provide(h.layer()));
    }).pipe(Effect.scoped, Effect.provide(runtime)),
  );

  it.live.each(["submodule", "lfs"] as const)(
    "rejects unsupported %s content before billing",
    (kind) =>
      Effect.gen(function* () {
        const h = yield* harness();
        const fs = yield* FileSystem.FileSystem;
        if (kind === "submodule") {
          yield* h.git([
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${h.commitSha},dependency`,
          ]);
        } else {
          yield* fs.writeFileString(
            `${h.root}/.gitattributes`,
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
          );
          yield* h.git(["add", ".gitattributes"]);
        }
        yield* h.git(["commit", "-m", kind]);
        yield* Effect.gen(function* () {
          const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
          const result = yield* Effect.result(service.prepare(input));
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure.stage, "source");
          assert.strictEqual(h.creates.length, 0);
        }).pipe(Effect.provide(h.layer()));
      }).pipe(Effect.scoped, Effect.provide(runtime)),
  );
  it.live("resolves the source before creating a paid VM", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
        const result = yield* Effect.result(service.prepare({ ...input, baseRef: "missing-ref" }));
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.stage, "source");
        assert.strictEqual(h.creates.length, 0);
      }).pipe(Effect.provide(h.layer()));
    }).pipe(Effect.scoped, Effect.provide(runtime)),
  );

  it.live("deduplicates concurrent preparation and returns the same VM", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.block();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${h.root}/app/file.txt`, "dirty content stays local");
      yield* Effect.gen(function* () {
        const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
        const first = yield* service.prepare(input).pipe(
          Effect.tapError(() => Deferred.succeed(h.entered, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(h.entered);
        const second = yield* service.prepare(input).pipe(Effect.forkChild);
        yield* Deferred.succeed(h.release, undefined);
        const a = yield* Fiber.join(first);
        assert.deepStrictEqual(yield* Fiber.join(second), a);
        assert.strictEqual(h.creates.length, 1);
        assert.strictEqual(h.prepared.length, 1);
        assert.strictEqual(h.prepared[0]?.remoteUrl, "git@example.invalid:example/project.git");
        assert.strictEqual(a.commitSha, h.commitSha);
        assert.strictEqual(a.workspaceStrategy.type, "existing_worktree");
        const independent = yield* service.prepare({ ...input, requestId: "draft:two" });
        assert.notStrictEqual(independent.sandboxId, a.sandboxId);
        assert.strictEqual(h.creates.length, 2);
      }).pipe(Effect.provide(h.layer()));
    }).pipe(Effect.scoped, Effect.provide(runtime)),
  );

  it.live("freezes source and creation parameters across failure and restart", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.fail(true);
      yield* Effect.gen(function* () {
        const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
        assert.strictEqual((yield* Effect.result(service.prepare(input)))._tag, "Failure");
        assert.strictEqual((yield* service.getPreparation(input))?.status, "failed");
      }).pipe(Effect.provide(h.layer()));
      yield* h.git(["commit", "--allow-empty", "-m", "next"]);
      h.fail(false);
      h.updateSettings({ namespaceWorktrees: { ...policy, image: "new-image" } });
      yield* Effect.gen(function* () {
        const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
        const result = yield* service.prepare(input);
        assert.strictEqual(result.commitSha, h.commitSha);
        assert.strictEqual(h.creates.length, 1);
        assert.strictEqual(h.prepared[1]?.commitSha, h.commitSha);
        assert.strictEqual(
          (yield* Effect.result(service.prepare({ ...input, baseRef: "main" })))._tag,
          "Failure",
        );
        assert.strictEqual(h.creates.length, 1);
      }).pipe(Effect.provide(h.layer()));
    }).pipe(Effect.scoped, Effect.provide(runtime)),
  );

  it.live("requires an enabled project policy and respects the project override", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.updateSettings({ namespaceWorktrees: null });
      yield* Effect.gen(function* () {
        const service = yield* NamespaceWorktreeService.NamespaceWorktreeService;
        const disabled = yield* Effect.result(service.prepare(input));
        assert.strictEqual(disabled._tag, "Failure");
        if (disabled._tag === "Failure")
          assert.strictEqual(disabled.failure.category, "not_configured");
        assert.strictEqual(h.creates.length, 0);
        h.updateSettings({
          projectSettingsOverrides: { [projectId]: { namespaceWorktrees: policy } },
        });
        const prepared = yield* service.prepare(input);
        assert.strictEqual(prepared.commitSha, h.commitSha);
        assert.strictEqual(h.creates.length, 1);
      }).pipe(Effect.provide(h.layer()));
    }).pipe(Effect.scoped, Effect.provide(runtime)),
  );
});
