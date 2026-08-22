# Speculative Swarm Architecture

## Turn Lifecycle

For each ordinary Actor turn, PERSEUS creates one immutable turn snapshot and
starts two paths concurrently:

1. The authoritative Actor reasons over the task, complete observations, and
   registered tool schemas.
2. The Speculator streams up to `top-k` complete tool calls from the same
   snapshot. Candidates describe calls that may coexist in the Actor's next
   batch rather than mutually exclusive whole-batch alternatives.
3. The runtime validates candidate schemas and admits only explicitly safe tool
   names to the speculative frontier.
4. Each admitted candidate executes as an isolated future as soon as its
   NDJSON row validates; the runtime does not wait for the remaining frontier.
   Results are not appended to Actor memory.
5. When the Actor emits a tool call, the runtime canonicalizes its structured
   arguments and checks the frontier.
6. An exact match claims the corresponding future. A miss executes the Actor
   call normally.
7. Unclaimed futures are cancelled when possible and otherwise discarded.
8. Only the Actor-selected tool result enters the authoritative trajectory.

This topology overlaps prediction, model latency, and safe tool latency without
adding a manager barrier before the Actor can act.

## Optional Depth-Two Continuation

The default remains the strict single-step protocol above. With
`PERSEUS_DEPTH2=1`, one high-confidence safe candidate may additionally seed a
detached next-Actor request after its tool result resolves. Tool-use turns are
projected to canonical calls/results for both the enabled arm and its matched
control. The detached response is committed only if the actual next provider
context has the exact same canonical key; otherwise it is aborted and the
normal Actor request runs.

Canonical projection omits non-tool text on tool-use turns. Consequently this
mode is an explicit experimental variant, not a claim of byte-identical
transcript semantics relative to the default loop.

## Verification Critic Variant

The default Actor accepts its first final answer. The opt-in
`perseus-critic` variant instead inserts one user-visible verification gate
after a tool-using run first attempts to stop. The same Actor must execute the
strongest available task-specific checks, inspect failures, repair the
artifact when necessary, and then answer again. The gate is bounded by
`PERSEUS_CRITIC_MAX_PASSES` and does not use a separate critic model.

This variant targets task success rather than lossless latency. Its results,
tokens, turns, and wall time must be compared separately from PERSEUS.

## Why It Is A Swarm

Each candidate is an independent, non-authoritative execution branch over one
possible next-action frontier. The branches share an immutable input snapshot
but not mutable memory. The Actor is the convergence point that selects at most
one matching future per emitted call. This is a light swarm because branch
coordination is enforced by the harness rather than delegated to additional
LLM conversations.

## Lossless Boundary

The speculative path may change latency, but it must not change Actor-visible
semantics:

- Matching uses exact tool name plus canonical structured arguments.
- A speculative error cannot replace an Actor call unless that exact call is
  selected; the normal tool result contract still applies.
- Unsafe tools never start early.
- Unselected arguments and results never enter task memory.
- Trace failures are ignored by the execution path.
- The controller forwards the exact typed future result and introduces no
  character-level truncation of its own. Tool-native pagination remains part of
  the evaluated product configuration.

## Experimental Controls

`PERSEUS_ENABLED=0` removes only the Speculator controller. The Actor model,
thinking level, system prompt, tools, task environment, and native scorer stay
unchanged. Report at least strict task success, native score, execution wall
time, Actor/model tokens, Speculator tokens, prediction latency, candidate
count, exact hits, misses, unsafe rejections, and cancelled futures.

Speed comparisons should use jointly successful cases and should keep rubric
or external-judge time separate from agent execution time.
