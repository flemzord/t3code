import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ProcessRunner from "../processRunner.ts";
import {
  namespaceWorkspaceDescriptorScript,
  namespaceWorkspaceScript,
  type WorkspaceInput,
} from "./namespaceWorkspace.ts";

it.live(
  "prepares the bundled commit and subdirectory, recovers registration, and rejects conflicting retries",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* ProcessRunner.ProcessRunner;
      const home = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
      const source = `${home}/source repo's $(touch forbidden)`;
      yield* fs.makeDirectory(`${source}/apps/a folder`, { recursive: true });
      const git = (cwd: string, args: readonly string[]) =>
        runner.run({ command: "git", args: ["-C", cwd, ...args] });
      assert.strictEqual((yield* git(source, ["init", "-b", "main"])).code, 0);
      yield* fs.writeFileString(`${source}/apps/a folder/tracked`, "unpushed committed data");
      yield* git(source, ["add", "apps"]);
      assert.strictEqual(
        (yield* git(source, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "-m",
          "unpushed",
        ])).code,
        0,
      );
      const commitSha = (yield* git(source, ["rev-parse", "HEAD"])).stdout.trim();
      const input: WorkspaceInput = {
        providerId: "vm-1",
        requestId: "request-1",
        bundlePath: `${home}/local bundle`,
        commitSha,
        projectSubdirectory: "apps/a folder",
        branch: "feature/branch's-name",
        projectTitle: "Remote project",
        remoteProjectId: "00000000-0000-4000-8000-000000000001",
        remoteUrl: "git@example.invalid:example/project.git",
      };
      for (const directory of [".codex", ".claude"]) {
        yield* fs.makeDirectory(`${home}/${directory}`);
        yield* fs.writeFileString(`${home}/${directory}/auth`, "existing-image-credential");
      }
      const base = `${home}/t3-workspaces/request-1`;
      yield* fs.makeDirectory(`${home}/bin`);
      // macOS has no flock; the fixture runs preparations sequentially.
      yield* fs.writeFileString(`${home}/bin/flock`, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      yield* fs.writeFileString(`${home}/.t3-namespace-owner`, input.providerId);
      yield* fs.makeDirectory(`${home}/.t3/userdata`, { recursive: true });
      yield* fs.writeFileString(
        `${home}/.t3/userdata/server-runtime.json`,
        JSON.stringify({ origin: "http://127.0.0.1:3773" }),
      );
      yield* fs.makeDirectory(`${home}/.t3/namespace-launcher/node_modules/.bin`, {
        recursive: true,
      });
      yield* fs.writeFileString(
        `${home}/.t3/namespace-launcher/node_modules/.bin/t3`,
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[2] === 'issue') {
  if (!args.includes('5m') || !args.includes('orchestration:read') || !args.includes('orchestration:operate')) process.exit(1);
  fs.appendFileSync(process.env.HOME + '/issued', '1');
  process.stdout.write(JSON.stringify({ sessionId: 'session-1', token: 'private-fixture-token' }));
} else if (args[2] === 'revoke' && args[3] === 'session-1') fs.appendFileSync(process.env.HOME + '/revoked', '1');
else process.exit(1);
`,
        { mode: 0o700 },
      );
      const preload = `${home}/http-fixture.cjs`;
      yield* fs.writeFileString(
        preload,
        `
const fs = require('node:fs');
global.fetch = async (url, options) => {
  if (url.origin !== 'http://127.0.0.1:3773' || options.headers.authorization !== 'Bearer private-fixture-token') throw Error('bad authorization');
  const filename = process.env.HOME + '/project.json';
  if (url.pathname === '/api/projects') return { ok: true, json: async () => ({ projects: fs.existsSync(filename) ? [JSON.parse(fs.readFileSync(filename, 'utf8'))] : [] }) };
  if (url.pathname !== '/api/projects/mutate') throw Error('bad endpoint');
  const mutation = JSON.parse(options.body);
  if (mutation.type !== 'project.create' || mutation.projectId !== '${input.remoteProjectId}' || mutation.namespaceWorktrees !== undefined) throw Error('bad mutation');
  const project = { id: mutation.projectId, workspaceRoot: mutation.workspaceRoot, deletedAt: null };
  fs.writeFileSync(filename, JSON.stringify(project));
  if (fs.existsSync(process.env.HOME + '/fail-after-create')) throw Error('lost response');
  return { ok: true, json: async () => project };
};
`,
      );
      const env = {
        HOME: home,
        PATH: `${home}/bin:${process.env.PATH}`,
        NODE_OPTIONS: `--require=${preload}`,
      };
      const run = (script: string) =>
        runner.run({ command: "sh", args: ["-s"], stdin: script, env });
      assert.strictEqual((yield* run(namespaceWorkspaceDescriptorScript(input))).code, 0);
      assert.strictEqual(
        (yield* git(source, ["bundle", "create", `${base}/${commitSha}.bundle`, "HEAD"])).code,
        0,
      );
      yield* fs.writeFileString(`${home}/fail-after-create`, "1");
      const lost = yield* run(namespaceWorkspaceScript(input));
      assert.strictEqual(lost.code, 1);
      assert.strictEqual(lost.stdout, "");
      assert.strictEqual(lost.stderr, "");
      assert.strictEqual(yield* fs.readFileString(`${home}/revoked`), "1");
      yield* fs.remove(`${home}/fail-after-create`);
      const prepared = yield* run(namespaceWorkspaceScript(input));
      assert.strictEqual(prepared.code, 0);
      assert.deepStrictEqual(JSON.parse(prepared.stdout), {
        projectId: input.remoteProjectId,
        workspaceRoot: `${base}/repo/apps/a folder`,
        worktreePath: `${base}/worktree/apps/a folder`,
        branch: input.branch,
      });
      assert.strictEqual(
        yield* fs.readFileString(`${base}/worktree/apps/a folder/tracked`),
        "unpushed committed data",
      );
      assert.strictEqual(
        (yield* git(`${base}/worktree`, ["rev-parse", "HEAD"])).stdout.trim(),
        commitSha,
      );
      assert.strictEqual(
        (yield* git(`${base}/repo`, ["remote", "get-url", "origin"])).stdout.trim(),
        input.remoteUrl,
      );
      assert.strictEqual((yield* run(namespaceWorkspaceScript(input))).stdout, prepared.stdout);
      for (const changed of [
        { branch: "other" },
        { commitSha: "a".repeat(40) },
        { remoteProjectId: "another" },
        { projectSubdirectory: "../outside" },
      ]) {
        const rejected = yield* run(namespaceWorkspaceScript({ ...input, ...changed }));
        assert.strictEqual(rejected.code, 1);
        assert.strictEqual(rejected.stdout, "");
      }
      yield* git(`${base}/worktree`, ["checkout", "-b", "other"]);
      assert.strictEqual((yield* run(namespaceWorkspaceScript(input))).code, 1);
      yield* git(`${base}/worktree`, ["checkout", input.branch]);
      yield* git(`${base}/worktree`, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "moved",
      ]);
      assert.strictEqual((yield* run(namespaceWorkspaceScript(input))).code, 1);
      for (const directory of [".codex", ".claude"]) {
        assert.strictEqual(
          yield* fs.readFileString(`${home}/${directory}/auth`),
          "existing-image-credential",
        );
      }
      assert.strictEqual(
        yield* fs.readFileString(`${home}/issued`),
        yield* fs.readFileString(`${home}/revoked`),
      );
    }).pipe(Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))),
);
