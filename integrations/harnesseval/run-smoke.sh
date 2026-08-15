#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ORCH_ROOT="$(dirname "${ROOT}")"
RUN_DIR="${1:-${ROOT}/runs/harnesseval-smoke}"
CATALOG="${ROOT}/integrations/harnesseval/catalog.json"

for name in PERSEUS_ACTOR_MODEL PERSEUS_ACTOR_BASE_URL PERSEUS_ACTOR_API_KEY; do
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required." >&2
    exit 2
  fi
done

HARNESSEVAL=(harnesseval)
if ! command -v harnesseval >/dev/null 2>&1; then
  if [[ -f "${ORCH_ROOT}/HarnessEval/benchmark_platform/cli.py" ]]; then
    HARNESSEVAL=(python3 -m benchmark_platform.cli)
    export PYTHONPATH="${ORCH_ROOT}/HarnessEval${PYTHONPATH:+:${PYTHONPATH}}"
  else
    echo "Install HarnessEval or place its checkout beside PERSEUS." >&2
    exit 2
  fi
fi

pass_env=(
  PERSEUS_ACTOR_PROVIDER PERSEUS_ACTOR_MODEL PERSEUS_ACTOR_BASE_URL
  PERSEUS_ACTOR_API_TYPE PERSEUS_ACTOR_API_KEY PERSEUS_ACTOR_THINKING
  PERSEUS_SPECULATOR_PROVIDER PERSEUS_SPECULATOR_MODEL PERSEUS_SPECULATOR_BASE_URL
  PERSEUS_SPECULATOR_API_TYPE PERSEUS_SPECULATOR_API_KEY PERSEUS_TOP_K
  PERSEUS_SPECULATOR_MAX_TOKENS PERSEUS_SPECULATOR_TIMEOUT_MS
  PERSEUS_API_TIMEOUT_MS PERSEUS_API_MAX_RETRIES PERSEUS_API_MAX_RETRY_DELAY_MS
  PERSEUS_CONTEXT_WINDOW
)
args=()
for name in "${pass_env[@]}"; do
  if [[ -n "${!name:-}" ]]; then args+=(--pass-env "${name}"); fi
done

"${HARNESSEVAL[@]}" --catalog "${CATALOG}" --orch-root "${ORCH_ROOT}" \
  run perseus-contract-smoke \
  --case read-sum \
  --run-dir "${RUN_DIR}" \
  "${args[@]}" \
  -- python3 /opt/perseus/integrations/harnesseval/adapter.py \
    --request /opt/perseus/integrations/harnesseval/smoke/request.json
