import { GitCommandError, type ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

const requiredMessage =
  "This project requires a Namespace VM for new worktrees. Send the first message from a Namespace-capable desktop client.";

export const assertLocalWorktreeAllowed = Effect.fn("localWorktreePolicy.assertAllowed")(function* (
  cwd: string,
) {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const settings = yield* serverSettings.getSettings;
    const snapshot = yield* projects.snapshot;
    const source = yield* fs.realPath(cwd);
    const contains = (root: string, target: string) => {
      const relative = path.relative(root, target);
      return (
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    };
    const roots: { id: ProjectId; root: string; enabled: boolean }[] = [];
    for (const project of snapshot.projects) {
      if (project.deletedAt !== null) continue;
      const root = yield* fs.realPath(project.workspaceRoot).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(path.resolve(project.workspaceRoot))
              : Effect.fail(error),
        }),
      );
      roots.push({
        id: project.id,
        root,
        enabled: resolveProjectSettings(settings, project.id).settings.namespaceWorktrees !== null,
      });
    }
    const choose = (matches: readonly { length: number; enabled: boolean }[]) => {
      const length = Math.max(...matches.map((match) => match.length));
      const nearest = matches.filter((match) => match.length === length);
      return {
        enabled: nearest.some((match) => match.enabled),
        ambiguous:
          nearest.some((match) => match.enabled) && nearest.some((match) => !match.enabled),
      };
    };
    const direct = roots
      .filter((entry) => contains(entry.root, source))
      .map((entry) => ({ length: entry.root.length, enabled: entry.enabled }));
    if (direct.length > 0) {
      if (choose(direct).enabled) return yield* Effect.fail(requiredMessage);
      return;
    }
    if (settings.namespaceWorktrees === null && !roots.some((entry) => entry.enabled)) return;

    // Worktree .git files identify shared storage even when Git cannot read the repository.
    const repositoryAnchor = Effect.fn("localWorktreePolicy.repositoryAnchor")(function* (
      directory: string,
    ) {
      let topLevel = directory;
      while (!(yield* fs.exists(path.join(topLevel, ".git")))) {
        const parent = path.dirname(topLevel);
        if (parent === topLevel) return null;
        topLevel = parent;
      }
      const marker = path.join(topLevel, ".git");
      const stat = yield* fs.stat(marker);
      let gitDir = marker;
      if (stat.type !== "Directory") {
        const value = (yield* fs.readFileString(marker)).trim();
        if (!value.startsWith("gitdir: "))
          return yield* Effect.fail("Invalid Git worktree metadata.");
        gitDir = path.resolve(topLevel, value.slice(8));
      }
      const commonFile = path.join(gitDir, "commondir");
      const commonDir = yield* fs.realPath(
        (yield* fs.exists(commonFile))
          ? path.resolve(gitDir, (yield* fs.readFileString(commonFile)).trim())
          : gitDir,
      );
      return { topLevel, commonDir };
    });
    const sourceAnchor = yield* repositoryAnchor(source);
    if (!sourceAnchor) {
      if (settings.namespaceWorktrees !== null) return yield* Effect.fail(requiredMessage);
      return;
    }
    const matches: { length: number; enabled: boolean; root: string; topLevel: string }[] = [];
    const sourceRelative = path.relative(sourceAnchor.topLevel, source);
    for (const entry of roots) {
      const metadata = yield* Effect.result(repositoryAnchor(entry.root));
      if (metadata._tag === "Failure") {
        if (entry.enabled && contains(path.dirname(sourceAnchor.commonDir), entry.root))
          return yield* Effect.fail(metadata.failure);
        continue;
      }
      const anchor = metadata.success;
      if (!anchor || anchor.commonDir !== sourceAnchor.commonDir) continue;
      const projectRelative = path.relative(anchor.topLevel, entry.root);
      if (!contains(projectRelative || ".", sourceRelative || ".")) continue;
      matches.push({
        length: projectRelative.length,
        enabled: entry.enabled,
        root: entry.root,
        topLevel: anchor.topLevel,
      });
    }
    if (matches.length === 0) {
      if (settings.namespaceWorktrees !== null) return yield* Effect.fail(requiredMessage);
      return;
    }
    const policy = choose(matches);
    if (policy.ambiguous)
      return yield* Effect.fail("Conflicting Namespace policies match this Git worktree.");
    if (policy.enabled) return yield* Effect.fail(requiredMessage);

    // Confirm mapped overrides only when this shared repository also has a Namespace policy.
    if (matches.some((match) => match.enabled)) {
      const runner = yield* ProcessRunner.ProcessRunner;
      for (const entry of [{ root: source, topLevel: sourceAnchor.topLevel }, ...matches]) {
        const result = yield* runner.run({
          command: "git",
          args: ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
          cwd: entry.root,
          timeout: "10 seconds",
          maxOutputBytes: 16384,
        });
        if (
          result.code !== 0 ||
          result.timedOut ||
          result.stdoutTruncated ||
          result.stdoutInvalidUtf8
        )
          return yield* Effect.fail("Unable to verify the Namespace worktree policy.");
        const lines = result.stdout.trim().split("\n");
        if (
          lines.length !== 2 ||
          (yield* fs.realPath(lines[0]!)) !== entry.topLevel ||
          (yield* fs.realPath(lines[1]!)) !== sourceAnchor.commonDir
        )
          return yield* Effect.fail("Invalid Git worktree metadata.");
      }
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new GitCommandError({
          operation: "localWorktreePolicy",
          command: "git worktree add",
          cwd,
          detail:
            typeof cause === "string" ? cause : "Unable to verify the Namespace worktree policy.",
          cause,
        }),
    ),
  );
});
