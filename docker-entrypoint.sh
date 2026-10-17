#!/bin/sh
# Runs the service as the unprivileged `node` user. Fly.io attaches volumes
# owned by root, so the directory holding the SQLite database is handed to
# `node` before privileges are dropped.
set -e

if [ "$(id -u)" = "0" ]; then
  dir="$(dirname "${DATABASE_PATH:-./payflow.db}")"
  mkdir -p "$dir"
  chown node:node "$dir"
  exec gosu node "$@"
fi

exec "$@"
