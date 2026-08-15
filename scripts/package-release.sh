#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-${ROOT}/../Perseus.tar.gz}"

tar \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='runs' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  -czf "${OUTPUT}" \
  -C "$(dirname "${ROOT}")" \
  "$(basename "${ROOT}")"

printf '%s\n' "${OUTPUT}"
