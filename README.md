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

Requirements: Node.js 22.19+, npm, rsync, and an OpenAI-compatible API.

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

The Speculator uses the Actor endpoint by default. Configure the
`PERSEUS_SPECULATOR_*` variables to use a faster compatible endpoint. Keep
`PERSEUS_SAFE_TOOLS` limited to actions whose early execution is semantically
safe, such as reads and searches.

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

The smoke performs a real API, Speculator, Actor, read tools, write tool, and
exact-file scorer loop. See [the integration guide](docs/HARNESSEVAL.md) for
benchmark images, host compatibility, tool injection, matched controls, and
result fields.

## Architecture

The execution protocol and safety boundary are described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The vendored agent runtime and
method provenance are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
