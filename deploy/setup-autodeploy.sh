#!/usr/bin/env bash
# One-time installation on the existing Ubuntu VPS. Does not deploy new application code.
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022
ulimit -c 0
[[ $(id -u) == 0 && $# == 1 ]] || { echo 'usage: sudo bash setup-autodeploy.sh PUBLIC_KEY_FILE' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
key=$(cat "$1")
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,3}(\ [A-Za-z0-9@._-]+)?$ ]] \
  || { echo invalid_public_key >&2; exit 1; }
ssh-keygen -l -f "$1" >/dev/null
systemctl is-active --quiet uhuru-control-plane.service
test -x /usr/local/bin/node
test -f "$source_dir/uhuru-deploy"
test -f /etc/uhuru/settings.json
for tool in useradd visudo runuser systemd-run npm git flock ssh-keygen sshd; do
  command -v "$tool" >/dev/null || { echo "missing_command: $tool" >&2; exit 1; }
done

exec 9>/run/lock/uhuru-deploy.lock
flock -n 9 || { echo deployment_already_running >&2; exit 1; }
if [[ ! -L /opt/uhuru ]]; then
  test -d /opt/uhuru/.git
  test ! -e /opt/uhuru-repo
  test -z "$(git -C /opt/uhuru status --porcelain --untracked-files=normal)"
  sha=$(git -C /opt/uhuru rev-parse HEAD)
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]]
  install -d -m 0755 /opt/uhuru-releases
  initial=/opt/uhuru-releases/$sha
  if [[ ! -d "$initial" ]]; then
    initial_tmp=$(mktemp -d /opt/uhuru-releases/.initial.XXXXXX)
    trap 'rm -rf "$initial_tmp"' EXIT
    git -C /opt/uhuru archive "$sha" | tar -x --no-same-owner -C "$initial_tmp"
    cp -a /opt/uhuru/node_modules "$initial_tmp/"
    chmod -R a+rX,go-w "$initial_tmp"
    mv "$initial_tmp" "$initial"
    trap - EXIT
  fi
  rm -f /opt/uhuru.next
  ln -s "$initial" /opt/uhuru.next
  # The running process keeps its working-directory inode through the rename.
  mv /opt/uhuru /opt/uhuru-repo
  if ! mv -T /opt/uhuru.next /opt/uhuru; then
    mv /opt/uhuru-repo /opt/uhuru
    exit 1
  fi
fi
test -d /opt/uhuru-repo/.git
test -d /opt/uhuru-releases
install -d -o root -g root -m 0700 /var/lib/uhuru-deploy-state

if ! id uhuru-build >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /var/cache/uhuru-build \
    --shell /usr/sbin/nologin uhuru-build
fi
install -d -o uhuru-build -g uhuru-build -m 0700 /var/cache/uhuru-build
if ! id uhuru-deploy >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /var/lib/uhuru-deploy \
    --shell /bin/bash uhuru-deploy
fi
install -d -o root -g root -m 0755 /var/lib/uhuru-deploy
install -d -o root -g root -m 0700 /var/lib/uhuru-deploy/.ssh
install -o root -g root -m 0755 "$source_dir/uhuru-deploy" /usr/local/sbin/uhuru-deploy

sudoers=$(mktemp)
trap 'rm -f "$sudoers"' EXIT
cat > "$sudoers" <<'SUDOERS'
Defaults:uhuru-deploy env_keep += "SSH_ORIGINAL_COMMAND"
uhuru-deploy ALL=(root) NOPASSWD: /usr/local/sbin/uhuru-deploy ssh
SUDOERS
visudo -cf "$sudoers"
install -o root -g root -m 0440 "$sudoers" /etc/sudoers.d/uhuru-deploy
printf 'restrict,command="/usr/bin/sudo -n /usr/local/sbin/uhuru-deploy ssh" %s\n' "$key" \
  > /var/lib/uhuru-deploy/.ssh/authorized_keys
# The SSH user can read its key but cannot replace it or the forced command.
chown root:uhuru-deploy /var/lib/uhuru-deploy/.ssh /var/lib/uhuru-deploy/.ssh/authorized_keys
chmod 0750 /var/lib/uhuru-deploy/.ssh
chmod 0640 /var/lib/uhuru-deploy/.ssh/authorized_keys
# Additional AllowUsers directives append names, preserving the administrator's list.
# Only extend an existing allowlist; avoid restricting an unrestricted host.
allow_users=$(sshd -T | awk '$1 == "allowusers" { print }')
if [[ -n "$allow_users" ]]; then
  install -d -o root -g root -m 0755 /etc/ssh/sshd_config.d
  printf 'AllowUsers uhuru-deploy\n' > /etc/ssh/sshd_config.d/uhuru-deploy.conf
  if ! sshd -t; then
    rm -f /etc/ssh/sshd_config.d/uhuru-deploy.conf
    exit 1
  fi
  systemctl reload ssh.service
fi
install -d -m 0755 /etc/systemd/system/uhuru-control-plane.service.d
cat > /etc/systemd/system/uhuru-control-plane.service.d/deploy.conf <<'UNIT'
[Service]
TimeoutStopSec=10s
UNIT
systemctl daemon-reload
printf 'Autodeploy installed. Current release: %s\n' "$(basename "$(readlink -f /opt/uhuru)")"
