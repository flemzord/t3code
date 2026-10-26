const packageVersion = "0.1.2";

export const namespaceVerificationScript = (id: string) => `set -eu
[ "$(cat "$HOME/.t3-namespace-owner")" = '${id}' ]
service_pid=$(systemctl show t3-namespace.service --property=MainPID --value)
node - "$HOME" "$service_pid" <<'NODE'
const fs = require('node:fs');
const home = process.argv[2];
const runtime = JSON.parse(fs.readFileSync(home + '/.t3/userdata/server-runtime.json', 'utf8'));
if (!Number.isInteger(runtime.pid) || runtime.pid <= 0 || runtime.pid !== Number(process.argv[3])) process.exit(45);
process.kill(runtime.pid, 0);
const origin = new URL(runtime.origin);
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) process.exit(46);
fetch(new URL('/.well-known/t3/environment', origin), { signal: AbortSignal.timeout(10000) })
  .then(async response => {
    if (!response.ok) throw new Error('Service unavailable');
    const descriptor = await response.json();
    if (typeof descriptor.environmentId !== 'string' || !descriptor.environmentId) process.exit(47);
    process.stdout.write(JSON.stringify({ environmentId: descriptor.environmentId, owner: fs.readFileSync(home + '/.t3-namespace-owner', 'utf8') }));
  }).catch(() => { process.exitCode = 48; });
NODE
`;

// The Desktop SSH launcher adopts external services only from the user's default T3 home.
export const namespaceBootstrapScript = (id: string) => `set -eu
umask 077
case "$HOME" in /*) ;; *) exit 40 ;; esac
case "$HOME" in *[!a-zA-Z0-9/_-]*) exit 40 ;; esac
account=$(id -un)
case "$account" in *[!a-zA-Z0-9_-]*|'') exit 40 ;; esac
[ "$(getent passwd "$account" | cut -d: -f6)" = "$HOME" ] || exit 40
privileged() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
exec 9>"$HOME/.t3-namespace-bootstrap.lock"
flock -x 9
owner="$HOME/.t3-namespace-owner"
if [ -e "$owner" ]; then
  [ "$(cat "$owner")" = '${id}' ] || exit 41
elif [ -e "$HOME/.t3" ] || systemctl is-active --quiet t3-namespace.service; then
  exit 42
else
  printf '%s' '${id}' > "$owner"
fi
node -e 'if(Number(process.versions.node.split(".")[0])<24) process.exit(43)'
launcher="$HOME/.t3/namespace-launcher"
if [ ! -x "$launcher/node_modules/.bin/t3" ]; then
  npm install --prefix "$launcher" --no-audit --no-fund t3@${packageVersion} >/dev/null 2>&1
fi
node - "$launcher/node_modules/t3/package.json" <<'NODE'
if(require(process.argv[2]).version!=="${packageVersion}") process.exit(44);
NODE
T3CODE_HOME="$HOME/.t3" node "$launcher/node_modules/t3/bin/t3.mjs" --version >/dev/null 2>&1
[ -x "$HOME/.t3/runtime/versions/${packageVersion}/t3" ]
privileged tee /etc/systemd/system/t3-namespace.service >/dev/null <<UNIT
[Unit]
Description=Independent T3 Namespace service
After=network.target
[Service]
Type=simple
User=$account
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=T3CODE_HOME=$HOME/.t3
ExecStart=$HOME/.t3/runtime/versions/${packageVersion}/t3 --base-dir $HOME/.t3 --host 127.0.0.1 --port 3773 --no-browser
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
privileged systemctl daemon-reload
privileged systemctl enable --now t3-namespace.service >/dev/null 2>&1
curl --fail --silent --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:3773/.well-known/t3/environment >/dev/null
${namespaceVerificationScript(id)}
`;
