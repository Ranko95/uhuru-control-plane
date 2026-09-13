#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
agent_path=${1:-../node-agent}
name="uhuru-control-plane-stand-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker build --platform linux/arm64 -f "$agent_path/stand/Dockerfile" -t uhuru-node-agent-stand:ticket-01 "$agent_path"
docker build --platform linux/arm64 -f stand/Dockerfile -t uhuru-control-plane-stand:ticket-02 .
# Real systemd needs a private privileged container. No host paths or ports are mounted.
docker run -d --name "$name" --platform linux/arm64 --privileged --cgroupns=private --ulimit core=0:0 \
  --tmpfs /run --tmpfs /run/lock uhuru-control-plane-stand:ticket-02 >/dev/null
docker exec "$name" python3 /control-plane-e2e.py "$(git -C "$agent_path" rev-parse HEAD)"
mkdir -p target
docker cp "$name":/opt/uhuru/stand-results.json target/stand-results.json
