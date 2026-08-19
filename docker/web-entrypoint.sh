#!/bin/sh
set -eu

exit_dir="$(mktemp -d)"
pids=""

shutdown() {
  trap - INT TERM
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    for pid in $pids; do
      wait "$pid" 2>/dev/null || true
    done
  fi
  exit "${1:-0}"
}

start_service() {
  service_name="$1"
  shift
  (
    set +e
    child_pid=""
    forward_signal() {
      if [ -n "$child_pid" ]; then
        kill "$child_pid" 2>/dev/null || true
        wait "$child_pid" 2>/dev/null || true
      fi
      exit 0
    }
    trap forward_signal INT TERM
    "$@" &
    child_pid="$!"
    wait "$child_pid"
    status="$?"
    printf '%s' "$status" > "$exit_dir/$service_name"
    exit "$status"
  ) &
  pids="$pids $!"
}

run_telemetry() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if node -e 'const net = require("node:net"); const socket = net.connect(1883, "127.0.0.1", () => { socket.end(); process.exit(0); }); socket.on("error", () => process.exit(1)); setTimeout(() => process.exit(1), 250);'; then
      exec fleet-telemetry -config /secrets/telemetry-server.json
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "MQTT broker did not become ready; Fleet Telemetry was not started" >&2
  return 1
}

trap 'shutdown 143' TERM
trap 'shutdown 130' INT

if [ -f /secrets/tesla-private-key.pem ] && [ -f /secrets/proxy-server-key.pem ] && [ -f /secrets/proxy-server-cert.pem ]; then
  start_service vehicle-command-proxy tesla-http-proxy \
    -host 127.0.0.1 \
    -port 4443 \
    -key-file /secrets/tesla-private-key.pem \
    -tls-key /secrets/proxy-server-key.pem \
    -cert /secrets/proxy-server-cert.pem
fi

if [ -f /secrets/telemetry-server.json ] && [ -f /secrets/telemetry-server-cert.pem ] && [ -f /secrets/telemetry-server-key.pem ]; then
  start_service fleet-telemetry run_telemetry
fi

start_service web node dist-server/index.js

while :; do
  for marker in "$exit_dir"/*; do
    [ -e "$marker" ] || continue
    service_name="${marker##*/}"
    status="$(cat "$marker")"
    echo "$service_name exited unexpectedly with status $status" >&2
    shutdown 1
  done
  sleep 1
done
