#!/bin/sh
set -eu
ulimit -c 0
cd "$(dirname "$0")/.."
if [ -d /opt/homebrew/opt/postgresql@18/bin ]; then
  PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
fi
test_root=$(mktemp -d /tmp/uhuru-cp-test.XXXXXX)
export TEST_DATABASE_SOCKET="$test_root"
cleanup() {
  pg_ctl -D "$test_root/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT INT TERM
initdb -D "$test_root/data" -U postgres -A trust --no-locale >/dev/null
cat >> "$test_root/data/postgresql.conf" <<EOF
listen_addresses = ''
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
