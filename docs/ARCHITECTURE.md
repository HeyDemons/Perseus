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
