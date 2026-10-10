#!/usr/bin/env bash
# One-time database setup from a reviewed, root-owned /opt/uhuru installation.
# The application user reads the secret; postgres receives it only through the pipe.
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
ulimit -c 0

[[ $(id -u) == 0 && $# == 0 ]] || { printf 'usage: sudo bash setup-database.sh\n' >&2; exit 1; }
[[ $(stat -c %a /etc/uhuru/local.json) =~ ^6[04]0$ ]] || { printf 'invalid_database_settings\n' >&2; exit 1; }

runuser -u uhuru -- node -e '
const { password } = JSON.parse(require("node:fs").readFileSync("/etc/uhuru/local.json", "utf8")).database ?? {};
if (typeof password !== "string" || !password) { console.error("invalid_database_settings"); process.exit(1); }
process.stdout.write(password);
' | runuser -u postgres -- env -i PATH="$PATH" PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres \
    node /opt/uhuru/deploy/db-setup.ts
printf 'Database prepared; existing data and role password preserved\n'
