#!/usr/bin/env bash
set -euo pipefail

RELEASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_SRC="${RELEASE}/harness"
CACHE_ROOT="${PERSEUS_HARNESS_CACHE_ROOT:-${XDG_CACHE_HOME:-${HOME}/.cache}/perseus}"

for command in node npm rsync; do
  command -v "${command}" >/dev/null 2>&1 || { echo "Missing required command: ${command}" >&2; exit 2; }
done

if [[ -n "${PERSEUS_HARNESS_RUNTIME:-}" ]]; then
  RUNTIME_HARNESS="$(cd "${PERSEUS_HARNESS_RUNTIME}" && pwd)"
  if [[ ! -x "${RUNTIME_HARNESS}/node_modules/.bin/tsx" ]]; then
    echo "PERSEUS_HARNESS_RUNTIME has no installed tsx runtime: ${RUNTIME_HARNESS}" >&2
    exit 2
  fi
  printf '%s\n' "${RUNTIME_HARNESS}"
  exit 0
fi

LOCK_HASH="$({ shasum -a 256 "${HARNESS_SRC}/package.json"; shasum -a 256 "${HARNESS_SRC}/package-lock.json"; } | shasum -a 256 | awk '{print $1}')"
RUNTIME_ROOT="${CACHE_ROOT}/${LOCK_HASH}"
RUNTIME_HARNESS="${RUNTIME_ROOT}/harness"
MARKER="${RUNTIME_ROOT}/.package-lock.sha256"
PREPARE_LOCK="${RUNTIME_ROOT}.prepare-lock"
LOCK_OWNER="${PREPARE_LOCK}/pid"
acquired_lock=0

release_lock() {
  if [[ "${acquired_lock}" == "1" ]]; then rm -rf "${PREPARE_LOCK}"; fi
}
trap release_lock EXIT INT TERM

mkdir -p "${CACHE_ROOT}"
while ! mkdir "${PREPARE_LOCK}" 2>/dev/null; do
  owner_pid="$(cat "${LOCK_OWNER}" 2>/dev/null || true)"
  if [[ -n "${owner_pid}" ]] && ! kill -0 "${owner_pid}" 2>/dev/null; then
    rm -rf "${PREPARE_LOCK}"
    continue
  fi
  sleep 1
done
acquired_lock=1
printf '%s\n' "$$" > "${LOCK_OWNER}"

mkdir -p "${RUNTIME_ROOT}"
rsync -a --delete --exclude node_modules --exclude .DS_Store "${HARNESS_SRC}/" "${RUNTIME_HARNESS}/"
if [[ ! -x "${RUNTIME_HARNESS}/node_modules/.bin/tsx" || ! -f "${MARKER}" || "$(cat "${MARKER}")" != "${LOCK_HASH}" ]]; then
  (cd "${RUNTIME_HARNESS}" && npm ci --ignore-scripts --no-audit --no-fund >&2)
  printf '%s' "${LOCK_HASH}" > "${MARKER}"
fi
printf '%s\n' "${RUNTIME_HARNESS}"
