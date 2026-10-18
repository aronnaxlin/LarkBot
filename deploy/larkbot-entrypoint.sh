#!/bin/sh
# Entrypoint for the LarkBot bot container.
#
# This exists for one optional guard: an existing deployment whose database
# lives on a bind mount must fail loudly if that mount is missing or empty,
# instead of quietly starting against a fresh SQLite file in the container's
# writable layer. Set LARKBOT_REQUIRE_EXISTING_DB=1 for that (docs/deploy.md).
# Everything else is an exec passthrough, so the app stays PID 1's child and
# receives SIGTERM directly.

set -eu

if [ "${LARKBOT_REQUIRE_EXISTING_DB:-0}" = "1" ]; then
  db_path=$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { parse } from "yaml";
    const configPath = process.env.CONFIG_PATH ?? "config.yaml";
    const config = parse(readFileSync(configPath, "utf8"));
    process.stdout.write(String(config?.database?.path ?? "./data/cahciua.db"));
  ')
  if [ ! -f "$db_path" ]; then
    echo "larkbot: LARKBOT_REQUIRE_EXISTING_DB=1 but the database '$db_path' does not exist." >&2
    echo "larkbot: refusing to start on an empty database; check the /app/data mount and config.yaml database.path." >&2
    exit 1
  fi
fi

exec "$@"
