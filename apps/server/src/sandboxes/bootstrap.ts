const packageVersion = "0.1.2";
// Node 24+ and passwordless sudo are prerequisites of the clean saved template.
export const bootstrapScript = (sandboxId: string) => `set -eu
umask 077
exec 9>/tmp/t3-boat-bootstrap.lock
flock -x 9
t3_boat_home=/home/user/.t3-boat/${sandboxId}
export T3CODE_HOME="$t3_boat_home"
owner=/home/user/.t3-boat/owner
if [ -e "$owner" ]; then
  [ "$(cat "$owner")" = '${sandboxId}' ] || exit 41
elif [ -e /home/user/.t3-boat ] || [ -e /home/user/.t3/userdata/environment-id ] || sudo systemctl is-active --quiet t3-boat.service; then
  exit 42
else
  initial=$(mktemp -d /home/user/.t3-boat.initial.XXXXXX)
  mkdir "$initial/${sandboxId}"
  printf '%s' '${sandboxId}' > "$initial/owner"
  mv "$initial" /home/user/.t3-boat
fi
node -e 'if(Number(process.versions.node.split(".")[0])<24) process.exit(43)'
launcher="$t3_boat_home/launcher"
if [ ! -x "$launcher/node_modules/.bin/t3" ]; then
  npm install --prefix "$launcher" --no-audit --no-fund t3@${packageVersion} >/dev/null 2>&1
fi
node - "$launcher/node_modules/t3/package.json" <<'NODE'
if(require(process.argv[2]).version!=="${packageVersion}") process.exit(44);
NODE
node "$launcher/node_modules/t3/bin/t3.mjs" --version >/dev/null 2>&1
[ -x "$t3_boat_home/runtime/versions/${packageVersion}/t3" ]
sudo tee /etc/systemd/system/t3-boat.service >/dev/null <<'UNIT'
[Unit]
Description=Independent T3 Boat service
After=network.target
[Service]
Type=simple
User=user
WorkingDirectory=/home/user
Environment=HOME=/home/user
Environment=T3CODE_HOME=/home/user/.t3-boat/${sandboxId}
ExecStart=/home/user/.t3-boat/${sandboxId}/runtime/versions/${packageVersion}/t3 --base-dir /home/user/.t3-boat/${sandboxId} --host 127.0.0.1 --port 3773 --no-browser
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now t3-boat.service >/dev/null 2>&1
curl --fail --silent --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:3773/.well-known/t3/environment
`;
export const pairingScript = (sandboxId: string, origin: string, filename: string) => `set -eu
umask 077
T3CODE_HOME=/home/user/.t3-boat/${sandboxId} /home/user/.t3-boat/${sandboxId}/runtime/versions/${packageVersion}/t3 auth pairing create --base-dir /home/user/.t3-boat/${sandboxId} --base-url '${origin}' --ttl 5m --json > '${filename}' 2>/dev/null
`;
