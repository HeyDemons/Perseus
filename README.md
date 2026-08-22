# PERSEUS

**Parallel Early Retrieval and Speculative Execution for Unified Swarms**

PERSEUS is a speculative swarm agent runtime. A fast Speculator observes the
same immutable conversation snapshot as the authoritative Actor and predicts a
frontier of complete next tool calls. Safe read/query candidates start while
the Actor is still reasoning. An exact Actor match reuses the in-flight future;
a miss follows the Actor's ordinary tool path without changing its memory.

The swarm is deliberately light. Speculative branches execute possible actions
but never vote on the answer, inject draft prose, or own task state. The Actor
remains the single authority for tool selection, mutations, and final output.

## Properties

- asynchronous `top-k` frontier prediction on every ordinary Actor turn;
- explicit safe-tool allowlist before any speculative execution;
- canonical tool-name and structured-argument matching;
- single execution on a hit and authoritative fallback on a miss;
- unused result isolation and best-effort cancellation;
- typed future transport and append-only JSONL protocol traces;
- identical Actor loop when `PERSEUS_ENABLED=0` for controlled experiments.

The PERSEUS controller does not slice predicted arguments, claimed future
results, or traces. Individual product tools retain their documented native
pagination/output policies. HarnessEval integration preserves the complete
event stream and terminal artifacts. Optional prediction-output and deadline
settings are sent only when the operator configures them.

## Run

Requirements: Node.js 22.19+, npm, rsync, and either an OpenAI-compatible or
Anthropic Messages-compatible API.

```bash
cp perseus.env.example .env.local
set -a; source .env.local; set +a
./perseus --print --no-session -p \
  "Inspect this workspace and report its package name."
```

Dependencies are installed into an external content-addressed cache. Session
state defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/perseus`; neither is
written into this checkout.

The minimum required variables are:

```bash
export PERSEUS_ACTOR_MODEL=model-id
export PERSEUS_ACTOR_BASE_URL=https://provider.example/v1
export PERSEUS_ACTOR_API_KEY=...
```

For an Anthropic-compatible gateway, keep the same CLI and select its native
transport explicitly:

```bash
export PERSEUS_ACTOR_PROVIDER=provider-id
export PERSEUS_ACTOR_MODEL=claude-model-id
export PERSEUS_ACTOR_BASE_URL=https://provider.example
export PERSEUS_ACTOR_API_TYPE=anthropic-messages
export PERSEUS_ACTOR_API_KEY=...
./perseus --print --no-session -p "Inspect this workspace and report its package name."
```

`PERSEUS_ACTOR_USER_AGENT` defaults to `Perseus/0.1` and can be overridden for
Anthropic-compatible gateways that require a specific client identity. The
Speculator inherits it unless `PERSEUS_SPECULATOR_USER_AGENT` is set.

The Speculator uses the Actor endpoint by default. Configure the
`PERSEUS_SPECULATOR_*` variables to use a faster compatible endpoint. Keep
`PERSEUS_SAFE_TOOLS` limited to actions whose early execution is semantically
safe, such as reads and searches. The Speculator defaults to `off` thinking,
admits candidates with confidence at least `0.5`, and opens a four-turn
cooldown after four consecutive miss-only turns. Override these policies with
`PERSEUS_SPECULATOR_THINKING`, `PERSEUS_SPECULATOR_MIN_CONFIDENCE`,
`PERSEUS_SPECULATOR_MAX_MISS_TURNS`, and
`PERSEUS_SPECULATOR_COOLDOWN_TURNS`. Exact hits emit a `speculation_saved`
trace row with measured head start, tool latency, and critical-path time saved.
Prediction output and wall time default to 256 tokens and 5000ms; both remain
configurable through `PERSEUS_SPECULATOR_MAX_TOKENS` and
`PERSEUS_SPECULATOR_TIMEOUT_MS`.

## Verify

```bash
bash tests/run-protocol.sh
```

The protocol test proves early execution on an exact hit, no duplicate tool
execution, Actor fallback on an argument miss, and rejection of unsafe
prelaunches.

## HarnessEval

The included integration packages PERSEUS as a product harness while
HarnessEval owns image provenance, singleton attempts, logs, resume, and scorer
artifacts:

```bash
bash integrations/harnesseval/run-smoke.sh
```

For a benchmark case, the repository also provides a CLI that runs PERSEUS and
its matched Actor-only control under the same prepared case and scorer:

```bash
python3 integrations/harnesseval/run-benchmark-pair.py gaia \
  --case CASE_ID \
  --run-dir "$HOME/perseus-eval/runs/gaia-pair" \
  --harnesseval-root "$HOME/perseus-eval/HarnessEval" \
  --mode both
```

The smoke performs a real API, Speculator, Actor, read tools, write tool, and
exact-file scorer loop. See [the integration guide](docs/HARNESSEVAL.md) for
benchmark images, host compatibility, tool injection, matched controls, and
result fields.

## Architecture

The execution protocol and safety boundary are described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The vendored agent runtime and
method provenance are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
