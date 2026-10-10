#!/bin/sh
set -eu
umask 077
ulimit -c 0
cd "$(dirname "$0")/.."

if [ -d /opt/homebrew/opt/postgresql@18/bin ]; then
  PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
fi

test_root=$(mktemp -d /tmp/uhuru-cp-test.XXXXXX)
export PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=postgres
PGPORT=$(node --input-type=module -e '
import net from "node:net";
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
    process.stdout.write(String(server.address().port));
    server.close();
});
')
PGPASSWORD=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
TEST_DATABASE_PASSWORD=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + ":@/?#%")')
export PGPORT PGPASSWORD TEST_DATABASE_PASSWORD

cleanup() {
  pg_ctl -D "$test_root/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$test_root"
}

trap cleanup EXIT INT TERM

printf '%s\n' "$PGPASSWORD" > "$test_root/postgres-password"
initdb -D "$test_root/data" -U postgres --auth-local=trust --auth-host=scram-sha-256 \
  --pwfile="$test_root/postgres-password" --no-locale >/dev/null
cat >> "$test_root/data/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = $PGPORT
password_encryption = 'scram-sha-256'
unix_socket_directories = '$test_root'
unix_socket_permissions = 0700
log_statement = 'none'
log_min_messages = panic
log_min_error_statement = panic
log_error_verbosity = terse
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
log_min_duration_statement = -1
log_min_duration_sample = -1
log_transaction_sample_rate = 0
log_duration = off
EOF

pg_ctl -D "$test_root/data" -l "$test_root/postgres.log" -w start >/dev/null
node --test --test-concurrency=1 "$@" test/*.test.ts
