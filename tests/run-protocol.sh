#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$(bash "${ROOT}/scripts/prepare-harness-runtime.sh")"

node "${ROOT}/tests/configure-agent.test.mjs"

(
  cd "${RUNTIME}"
  npm run check
  ./node_modules/.bin/tsx \
    --tsconfig tsconfig.json \
    packages/ai/test/overflow.test.ts
  ./node_modules/.bin/tsx \
    --tsconfig tsconfig.json \
    packages/agent/test/perseus-runtime.test.ts
  ./node_modules/.bin/tsx \
    --tsconfig tsconfig.json \
    packages/coding-agent/test/perseus-recovery.test.ts
)
