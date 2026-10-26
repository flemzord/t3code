import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type Project, type ServerSettings as Settings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { assertLocalWorktreeAllowed } from "./localWorktreePolicy.ts";

it.effect(
  "uses the nearest canonical project policy and preserves an explicit local override",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
      const root = `${directory}/repo`;
      const nested = `${root}/nested`;
      yield* fs.makeDirectory(`${nested}/src`, { recursive: true });
      yield* fs.makeDirectory(`${root}/sibling`);
      yield* fs.makeDirectory(`${directory}/repo-other`);
      yield* fs.symlink(root, `${directory}/alias`);
      const parentId = ProjectId.make("parent");
      const nestedId = ProjectId.make("nested");
      const project = (id: ProjectId, workspaceRoot: string): Project => ({
        id,
        workspaceRoot,
        title: id,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      });
      const layer = Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          snapshot: Effect.succeed({
            updatedAt: "2026-01-01T00:00:00.000Z",
            projects: [project(parentId, root), project(nestedId, `${directory}/alias/nested`)],
          }),
        }),
        ServerSettings.layerTest({
          projectSettingsOverrides: {
            [parentId]: { namespaceWorktrees: null },
            [nestedId]: { namespaceWorktrees: { image: "template", machineType: "small" } },
          },
        }),
      );
      yield* Effect.gen(function* () {
        for (const cwd of [`${nested}/src`, `${directory}/alias/nested/src`, `${nested}/src/..`]) {
          const result = yield* Effect.result(assertLocalWorktreeAllowed(cwd));
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "GitCommandError");
        }
        yield* assertLocalWorktreeAllowed(`${root}/sibling`);
        yield* assertLocalWorktreeAllowed(`${directory}/repo-other`);
      }).pipe(Effect.provide(layer));
      yield* assertLocalWorktreeAllowed(`${root}/sibling`).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              snapshot: Effect.succeed({
                updatedAt: "2026-01-01T00:00:00.000Z",
                projects: [project(parentId, root)],
              }),
            }),
            ServerSettings.layerTest({
              namespaceWorktrees: { image: "template", machineType: "small" },
              projectSettingsOverrides: { [parentId]: { namespaceWorktrees: null } },
            }),
          ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

it.effect("rejects an unregistered source under the environment Namespace policy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const result = yield* Effect.result(assertLocalWorktreeAllowed(cwd));
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "GitCommandError");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        runtime,
        Layer.mock(ProjectService.ProjectService)({
          snapshot: Effect.succeed({ updatedAt: "2026-01-01T00:00:00.000Z", projects: [] }),
        }),
        ServerSettings.layerTest({
          namespaceWorktrees: { image: "template", machineType: "small" },
        }),
      ),
    ),
  ),
);

const runtime = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live("maps sibling worktrees to nested source policies and rejects conflicting identities", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
    const root = `${directory}/repo`;
    const sibling = `${directory}/sibling`;
    const other = `${directory}/other`;
    yield* fs.makeDirectory(`${root}/nested/src`, { recursive: true });
    yield* fs.writeFileString(`${root}/nested/src/file`, "tracked");
    const git = (args: readonly string[]) =>
      runner
        .run({ command: "git", args, cwd: root })
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => assert.strictEqual(result.code, 0, result.stderr)),
          ),
        );
    yield* git(["init", "-b", "main"]);
    yield* git(["add", "."]);
    yield* git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    yield* git(["worktree", "add", "-b", "sibling", sibling]);
    yield* git(["worktree", "add", "-b", "other", other]);
    const parentId = ProjectId.make("source");
    const nestedId = ProjectId.make("nested");
    const directId = ProjectId.make("direct");
    const otherId = ProjectId.make("other");
    const project = (id: ProjectId, workspaceRoot: string): Project => ({
      id,
      workspaceRoot,
      title: id,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });
    const sourceProjects = [project(parentId, root), project(nestedId, `${root}/nested`)];
    const namespaceWorktrees = { image: "template", machineType: "small" } as const;
    const check = (
      cwd: string,
      projects: readonly Project[],
      settings: Partial<Settings>,
      blocked: boolean,
      metadataFailure = false,
    ) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(assertLocalWorktreeAllowed(cwd));
        assert.strictEqual(result._tag, blocked ? "Failure" : "Success");
        if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "GitCommandError");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              snapshot: Effect.succeed({ projects, updatedAt: "2026-01-01T00:00:00.000Z" }),
            }),
            ServerSettings.layerTest(settings),
            Layer.succeed(
              ProcessRunner.ProcessRunner,
              metadataFailure
                ? {
                    run: () =>
                      Effect.succeed({
                        code: ChildProcessSpawner.ExitCode(128),
                        stdout: "",
                        stderr: "invalid metadata",
                        timedOut: false,
                        stdoutTruncated: false,
                        stderrTruncated: false,
                        stdoutInvalidUtf8: false,
                        stderrInvalidUtf8: false,
                      }),
                  }
                : runner,
            ),
          ),
        ),
      );
    const enabledParent = {
      projectSettingsOverrides: {
        [parentId]: { namespaceWorktrees },
        [nestedId]: { namespaceWorktrees: null },
      },
    };
    yield* check(sibling, sourceProjects, enabledParent, true);
    yield* check(`${sibling}/nested/src`, sourceProjects, enabledParent, false);
    yield* check(`${sibling}/nested/src`, sourceProjects, enabledParent, true, true);
    yield* check(sibling, sourceProjects, {}, false, true);
    const unrelated = `${directory}/unrelated`;
    yield* fs.makeDirectory(unrelated);
    yield* fs.writeFileString(`${unrelated}/.git`, "invalid metadata");
    yield* check(
      `${sibling}/nested/src`,
      [...sourceProjects, project(otherId, unrelated)],
      {
        projectSettingsOverrides: {
          ...enabledParent.projectSettingsOverrides,
          [otherId]: { namespaceWorktrees },
        },
      },
      false,
    );
    const enabledNested = {
      projectSettingsOverrides: {
        [parentId]: { namespaceWorktrees: null },
        [nestedId]: { namespaceWorktrees },
      },
    };
    yield* check(sibling, sourceProjects, enabledNested, false);
    yield* check(`${sibling}/nested/src`, sourceProjects, enabledNested, true);
    yield* check(
      `${sibling}/nested/src`,
      [...sourceProjects, project(directId, sibling)],
      {
        projectSettingsOverrides: {
          ...enabledNested.projectSettingsOverrides,
          [directId]: { namespaceWorktrees: null },
        },
      },
      false,
    );
    yield* check(
      sibling,
      [project(parentId, root), project(otherId, other)],
      {
        projectSettingsOverrides: {
          [parentId]: { namespaceWorktrees },
          [otherId]: { namespaceWorktrees: null },
        },
      },
      true,
    );
  }).pipe(Effect.scoped, Effect.provide(runtime)),
);
