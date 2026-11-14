#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

fail() { printf '::error::%s\n' "$*" >&2; exit 1; }
architecture=$(dpkg --print-architecture)
server="postgresql-16:$architecture"
client="postgresql-client-16:$architecture"

# The installed APT candidate can have no download source on a hosted runner.
# Use binary repository records, not dpkg status or a source-only version.
repository_versions() {
  apt-cache madison "$1" | awk -F '|' '$3 ~ / Packages[[:space:]]*$/ {
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2
  }'
}
server_versions=$(repository_versions "$server")
client_versions=$(repository_versions "$client")
selected_version=''
while IFS= read -r version; do
  [[ "$version" =~ ^([0-9]+:)?16\. ]] || continue
  grep -Fxq -- "$version" <<< "$client_versions" || continue
  if [[ -z "$selected_version" ]] || dpkg --compare-versions "$version" gt "$selected_version"; then
    selected_version=$version
  fi
done <<< "$server_versions"
[[ -n "$selected_version" ]] || fail "No downloadable PostgreSQL 16 server/client pair for $architecture in configured APT indexes"
printf 'Private PostgreSQL tools: version=%s architecture=%s\n' "$selected_version" "$architecture"

restart_tools=$(mktemp -d "$RUNNER_TEMP/boardroom-pg16-restart-tools.XXXXXX")
restart_tools=$(realpath "$restart_tools")
restart_debs=$(mktemp -d "$RUNNER_TEMP/boardroom-pg16-restart-debs.XXXXXX")
# Keep normal APT authentication and fail on any download error. No installation,
# dependency closure, maintainer scripts or host/default cluster is involved.
(
  cd "$restart_debs"
  apt-get download "$server=$selected_version" "$client=$selected_version"
)
for package in postgresql-16 postgresql-client-16; do
  archives=("$restart_debs/${package}_"*.deb)
  [[ ${#archives[@]} -eq 1 && -f "${archives[0]}" ]] || fail "Expected exactly one downloaded $package archive"
  archive=${archives[0]}
  [[ "$(dpkg-deb --field "$archive" Package)" == "$package" ]] || fail "Unexpected package in $archive"
  [[ "$(dpkg-deb --field "$archive" Version)" == "$selected_version" ]] || fail "Unexpected version in $archive"
  [[ "$(dpkg-deb --field "$archive" Architecture)" == "$architecture" ]] || fail "Unexpected architecture in $archive"
  dpkg-deb --extract "$archive" "$restart_tools"
done

restart_bin="$restart_tools/usr/lib/postgresql/16/bin"
test -f "$restart_tools/usr/share/postgresql/16/postgres.bki"
test -d "$restart_tools/usr/lib/postgresql/16/lib"
for tool in postgres initdb pg_ctl pg_dump pg_restore; do
  executable="$restart_bin/$tool"
  [[ -x "$executable" && "$(realpath "$executable")" == "$executable" ]] || fail "$tool is not a private executable"
  version_output=$("$executable" --version)
  printf '%s\n' "$version_output"
  [[ "$version_output" =~ \(PostgreSQL\)\ 16\. ]] || fail "$tool is not PostgreSQL 16"
done
# All later backup/restore consumers and the independent restart fixture use
# this same package pair; publish paths only after successful validation.
printf '%s\n' "$restart_bin" >> "$GITHUB_PATH"
printf 'bin=%s\n' "$restart_bin" >> "$GITHUB_OUTPUT"
