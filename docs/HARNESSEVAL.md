# HarnessEval Integration

HarnessEval and PERSEUS keep separate ownership boundaries:

- HarnessEval selects the benchmark case, builds or verifies the task image,
  passes named credentials, isolates attempts, resumes completed cases, keeps
  full terminal logs, and records native scorer payloads.
- PERSEUS owns the Actor/Speculator topology, exact future reuse, safe-tool
  policy, model calls, and speculative trace.
- The benchmark remains authoritative for tools, environment state, and score.

## Included Contract Smoke

The catalog at `integrations/harnesseval/catalog.json` defines a transparent
infrastructure task. It builds PERSEUS into a Node image, asks the Actor to read
two files and write their sum, then checks the artifact, real tool events, and
Speculator trace. It is an oracle smoke, not a benchmark score.

With HarnessEval installed and the required `PERSEUS_ACTOR_*` variables set:

```bash
bash integrations/harnesseval/run-smoke.sh runs/harnesseval-smoke
```

HarnessEval stores the complete attempt under:

```text
RUN_DIR/perseus-contract-smoke/read-sum/
  result.json
  attempts/0001/
    terminal.log
    perseus-events.jsonl
    perseus-stderr.log
    perseus-trace.jsonl
    harness_result.json
    payload.json
```

No credential value is serialized. `result.json` records only the names of
allow-listed environment variables.

## Benchmark Experiments

Use one of two faithful integration paths.

### Product Image Path

For terminal, repository, and artifact workspaces, install PERSEUS in the
benchmark task image and invoke it through `harnesseval run BENCHMARK ... --`.
Expose only benchmark-granted tools and write native scorer output to
`/job/payload.json`. This path is appropriate for Terminal-Bench, SWE-bench,
and workspace-style GDPval tasks.

### Tool Adapter Path

For service simulators such as VitaBench or tau, provide a versioned Pi tool
extension that maps every benchmark tool schema to its native transport. The
extension must preserve complete structured arguments/results, session identity,
and mutation ordering. Derive `PERSEUS_SAFE_TOOLS` from benchmark-declared
read/query semantics; mutation tools remain Actor-only. Do not infer safety from
tool-name substrings inside the PERSEUS runtime.

In both paths, the command adapter must leave the benchmark prompt and native
scorer unchanged. A benchmark-specific system prompt, answer-bearing cache, or
replacement scorer invalidates architectural comparison.

## Matched Evaluation

For each case, run a paired block:

1. `PERSEUS_ENABLED=1` with the frozen frontier and safety configuration.
2. `PERSEUS_ENABLED=0` with the identical Actor, prompt, tools, image, and
   scorer.

Use distinct case keys such as `case-id-perseus` and `case-id-control`, or
distinct run directories. Record agent execution time separately from rubric
time. The included adapter writes PERSEUS mechanism counters into
`harness_result.json`; benchmark adapters should retain the same field names
alongside their native score payload.
