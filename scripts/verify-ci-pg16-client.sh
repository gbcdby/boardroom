#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

fail() { printf '::error::%s\n' "$*" >&2; exit 1; }
[[ $# == 0 ]] || fail "Unexpected client verification arguments"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${BOARDROOM_CI_PG16_VERSION:?validated PostgreSQL version is required}"
: "${BOARDROOM_CI_PG16_CLIENT_ARCHIVE:?validated client archive is required}"
: "${BOARDROOM_CI_PG16_CLIENT_BYTES:?validated client byte count is required}"
: "${BOARDROOM_CI_PG16_CLIENT_SHA256:?validated client digest is required}"
: "${BOARDROOM_CI_PG16_CLIENT_PACKAGE:?validated client package is required}"
: "${BOARDROOM_CI_PG16_ARCHITECTURE:?validated client architecture is required}"

[[ "$BOARDROOM_CI_PG16_VERSION" =~ ^([0-9]+:)?16\.15-[0-9A-Za-z.+~:-]+$ ]] || fail "Unexpected PostgreSQL profile"
[[ "$BOARDROOM_CI_PG16_CLIENT_PACKAGE" == postgresql-client-16 ]] || fail "Only the validated client may be installed"
[[ "$BOARDROOM_CI_PG16_ARCHITECTURE" == "$(dpkg --print-architecture)" ]] || fail "Client architecture differs from the runner"
[[ "$BOARDROOM_CI_PG16_CLIENT_BYTES" =~ ^[1-9][0-9]*$ ]] || fail "Invalid client byte count"
[[ "$BOARDROOM_CI_PG16_CLIENT_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "Invalid client digest"

archive=$BOARDROOM_CI_PG16_CLIENT_ARCHIVE
[[ "$archive" == /* && "$archive" != *$'\n'* && "$archive" != *$'\r'* ]] || fail "Client archive must have a single absolute path"
[[ -f "$archive" && ! -L "$archive" && "$archive" == "$(realpath -e -- "$archive")" ]] || fail "Client archive is not a canonical regular file"
temp_root=$(realpath -e -- "$RUNNER_TEMP")
archive_directory=$(dirname -- "$archive")
[[ "$(dirname -- "$archive_directory")" == "$temp_root" \
  && "$(basename -- "$archive_directory")" == boardroom-pg16-restart-debs.* ]] || fail "Client archive is outside the private preparation directory"
[[ "$(stat -c %s -- "$archive")" == "$BOARDROOM_CI_PG16_CLIENT_BYTES" ]] || fail "Client archive size changed"
actual_sha256=$(sha256sum -- "$archive")
[[ "${actual_sha256%% *}" == "$BOARDROOM_CI_PG16_CLIENT_SHA256" ]] || fail "Client archive digest changed"
[[ "$(dpkg-deb --field "$archive" Package)" == "$BOARDROOM_CI_PG16_CLIENT_PACKAGE" ]] || fail "Client package changed"
[[ "$(dpkg-deb --field "$archive" Version)" == "$BOARDROOM_CI_PG16_VERSION" ]] || fail "Client version changed"
[[ "$(dpkg-deb --field "$archive" Architecture)" == "$BOARDROOM_CI_PG16_ARCHITECTURE" ]] || fail "Client archive architecture changed"
printf '%s\n' "$archive"
