#!/usr/bin/env bash
# Run only after ubuntu-apt-https.ts has validated the fixed container sources.
# Bound acquisition, then configure the fully downloaded packages exactly once.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo 'usage: prepare-native-desktop-apt.sh EVIDENCE_DIRECTORY' >&2
  exit 64
fi
evidence_directory=$1
mkdir -p -- "$evidence_directory"

packages=(openbox=3.6.1-12build5 x11-utils=7.7+6build2)
acquire_options=(-o Acquire::Retries=2 -o Acquire::https::Timeout=15)

run_stage() {
  local stage=$1 deadline=$2 started finished command_exit log_exit effective_exit evidence_exit=0
  local -a statuses
  shift 2
  started=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  printf '%q ' "$@" > "$evidence_directory/apt-$stage.command.txt"
  printf '\n' >> "$evidence_directory/apt-$stage.command.txt"
  printf '{"stage":"%s","startedAt":"%s","acquisitionDeadlineSeconds":%s}\n' \
    "$stage" "$started" "$deadline" > "$evidence_directory/apt-$stage.started.json"

  # Capture both real pipeline exits before another command changes PIPESTATUS.
  # Temporarily disabling errexit lets us preserve failure evidence, not continue.
  set +e
  "$@" 2>&1 | tee "$evidence_directory/apt-$stage.log"
  statuses=("${PIPESTATUS[@]}")
  set -e
  command_exit=${statuses[0]}
  log_exit=${statuses[1]}
  effective_exit=$command_exit
  if [ "$effective_exit" -eq 0 ]; then effective_exit=$log_exit; fi
  # Post-command evidence errors must not let errexit replace the primary exit.
  if finished=$(date -u +'%Y-%m-%dT%H:%M:%SZ'); then
    if printf '{"stage":"%s","startedAt":"%s","finishedAt":"%s","acquisitionDeadlineSeconds":%s,"commandExit":%s,"logExit":%s,"exit":%s}\n' \
      "$stage" "$started" "$finished" "$deadline" "$command_exit" "$log_exit" "$effective_exit" \
      > "$evidence_directory/apt-$stage.result.json"; then
      :
    else evidence_exit=$?; fi
  else evidence_exit=$?; fi
  if [ "$evidence_exit" -ne 0 ]; then
    # If stderr is also unavailable, the evidence failure remains a failing exit.
    printf 'APT %s result evidence could not be persisted (exit %s)\n' "$stage" "$evidence_exit" >&2 || :
    if [ "$effective_exit" -eq 0 ]; then effective_exit=$evidence_exit; fi
  fi
  return "$effective_exit"
}

# These commands never unpack/configure packages. Two APT-native file retries
# stay within the 120+5 / 240+5 second hard acquisition bounds (370 seconds total).
# HTTPS Timeout is a connection/data idle timeout, not a file wall-clock limit.
run_stage update 120 timeout --signal=TERM --kill-after=5s 120s \
  apt-get "${acquire_options[@]}" --error-on=any update
run_stage download 240 timeout --signal=TERM --kill-after=5s 240s \
  apt-get "${acquire_options[@]}" --download-only install -y --no-install-recommends "${packages[@]}"

# Same authenticated indices and /var/cache/apt/archives, with no intervening
# update/clean or network fallback. No new timeout or retry may kill/repeat dpkg.
# The original job-wide cancellation and 15-minute limit still apply.
run_stage install null apt-get --no-download install -y --no-install-recommends "${packages[@]}"
