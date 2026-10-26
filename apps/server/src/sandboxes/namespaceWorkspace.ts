export type WorkspaceInput = {
  readonly providerId: string;
  readonly bundlePath: string;
  readonly commitSha: string;
  readonly projectSubdirectory: string;
  readonly branch: string;
  readonly requestId: string;
  readonly projectTitle: string;
  readonly remoteProjectId: string;
  readonly remoteUrl?: string;
};

export type WorkspaceResult = {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
};

const encodedInput = (input: WorkspaceInput) =>
  Buffer.from(JSON.stringify(input)).toString("base64");

// Input travels as data; neither local paths nor branch names become shell syntax.
const prelude = (input: WorkspaceInput, lock = false) => `set -eu
umask 077
${
  lock
    ? `exec 9>"$HOME/t3-workspaces/"'${input.requestId.replaceAll("'", "'\\''")}'"/prepare.lock"
flock -x 9
`
    : ""
}node <<'T3_WORKSPACE_NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const input = JSON.parse(Buffer.from('${encodedInput(input)}', 'base64').toString('utf8'));
const home = process.env.HOME;
function check(ok) { if (!ok) throw new Error('Workspace preparation failed'); }
function inside(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function directory(target) { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); check(fs.realpathSync(target) === target); }
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim(); }
async function main() {
check(typeof home === 'string' && path.isAbsolute(home) && fs.realpathSync(home) === home);
check(/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId));
check(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.commitSha));
check(typeof input.projectSubdirectory === 'string' && !path.isAbsolute(input.projectSubdirectory) && !input.projectSubdirectory.includes('\\\\') && !input.projectSubdirectory.split('/').includes('..'));
check(fs.readFileSync(path.join(home, '.t3-namespace-owner'), 'utf8') === input.providerId);
const base = path.join(home, 't3-workspaces', input.requestId);
directory(path.join(home, 't3-workspaces'));
directory(base);
const bundlePath = path.join(base, input.commitSha + '.bundle');
`;

const ending = `
}
main().catch(() => { process.exitCode = 1; });
T3_WORKSPACE_NODE
`;

export const namespaceWorkspaceDescriptorScript = (input: WorkspaceInput) =>
  `${prelude(input)}process.stdout.write(JSON.stringify({ owner: input.providerId, home, bundlePath }));${ending}`;

export const namespaceWorkspaceScript = (input: WorkspaceInput) => `${prelude(input, true)}
  git(base, ['check-ref-format', '--branch', input.branch]);
  check(!input.branch.startsWith('-'));
  const identity = JSON.stringify({ requestId: input.requestId, commitSha: input.commitSha, branch: input.branch, projectSubdirectory: input.projectSubdirectory, projectId: input.remoteProjectId, remoteUrl: input.remoteUrl });
  const manifest = path.join(base, 'identity.json');
  if (fs.existsSync(manifest)) check(fs.readFileSync(manifest, 'utf8') === identity);
  else fs.writeFileSync(manifest, identity, { flag: 'wx', mode: 0o600 });
  const repo = path.join(base, 'repo');
  const worktree = path.join(base, 'worktree');
  if (!fs.existsSync(repo)) {
    const staging = fs.mkdtempSync(path.join(base, 'clone-'));
    try {
      git(base, ['clone', '--no-checkout', '--', bundlePath, staging]);
      git(staging, ['checkout', '--detach', input.commitSha]);
      git(staging, ['remote', 'remove', 'origin']);
      if (input.remoteUrl) git(staging, ['remote', 'add', 'origin', input.remoteUrl]);
      fs.renameSync(staging, repo);
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); }
  }
  check(fs.realpathSync(repo) === repo);
  check(git(repo, ['rev-parse', 'HEAD']) === input.commitSha);
  if (!fs.existsSync(worktree)) {
    const refs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
    if (refs.split('\\n').includes('refs/heads/' + input.branch)) {
      check(git(repo, ['rev-parse', 'refs/heads/' + input.branch]) === input.commitSha);
      git(repo, ['worktree', 'add', '--', worktree, input.branch]);
    } else git(repo, ['worktree', 'add', '-b', input.branch, '--', worktree, input.commitSha]);
  }
  check(fs.realpathSync(worktree) === worktree);
  check(git(worktree, ['rev-parse', 'HEAD']) === input.commitSha);
  check(git(worktree, ['symbolic-ref', '--short', 'HEAD']) === input.branch);
  check(fs.realpathSync(git(worktree, ['rev-parse', '--git-common-dir'])) === path.join(repo, '.git'));
  const workspaceRoot = path.resolve(repo, input.projectSubdirectory || '.');
  const worktreePath = path.resolve(worktree, input.projectSubdirectory || '.');
  for (const [root, target] of [[repo, workspaceRoot], [worktree, worktreePath]]) {
    check(inside(root, target) && inside(root, fs.realpathSync(target)) && fs.statSync(target).isDirectory());
  }
  const t3Home = path.join(home, '.t3');
  const runtime = JSON.parse(fs.readFileSync(path.join(t3Home, 'userdata/server-runtime.json'), 'utf8'));
  const origin = new URL(runtime.origin);
  check(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) && !origin.username && !origin.password);
  const executable = path.join(t3Home, 'namespace-launcher/node_modules/.bin/t3');
  const cli = args => execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, T3CODE_HOME: t3Home }, cwd: home });
  const session = JSON.parse(cli(['auth', 'session', 'issue', '--base-dir', t3Home, '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--ttl', '5m', '--json']));
  check(typeof session.sessionId === 'string' && session.sessionId.length > 0);
  try {
    check(typeof session.token === 'string' && session.token.length > 0);
    const request = async (url, body) => {
      const response = await fetch(new URL(url, origin), {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { authorization: 'Bearer ' + session.token, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      check(response.ok);
      return response.json();
    };
    const snapshot = await request('/api/projects');
    check(Array.isArray(snapshot.projects));
    let project = snapshot.projects.find(project => project.id === input.remoteProjectId);
    if (!project) project = await request('/api/projects/mutate', {
      type: 'project.create', commandId: 'namespace-workspace-' + input.requestId,
      projectId: input.remoteProjectId, title: input.projectTitle, workspaceRoot,
    });
    check(project.id === input.remoteProjectId && project.workspaceRoot === workspaceRoot && project.deletedAt === null);
  } finally {
    cli(['auth', 'session', 'revoke', session.sessionId, '--base-dir', t3Home]);
  }
  process.stdout.write(JSON.stringify({ projectId: input.remoteProjectId, workspaceRoot, worktreePath, branch: input.branch }));
${ending}`;
