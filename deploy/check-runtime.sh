#!/bin/sh
set -eu

grep -Eq '^Max core file size[[:space:]]+0[[:space:]]+0[[:space:]]+' /proc/self/limits || {
    printf '%s\n' core_dump_policy >&2
    exit 1
}

core_pattern=$(cat /proc/sys/kernel/core_pattern)

case "$core_pattern" in
    \|*)
        printf '%s\n' core_dump_policy >&2
        exit 1
        ;;
esac
