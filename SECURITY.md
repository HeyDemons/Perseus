# Security

Report vulnerabilities privately to the repository owner. Do not open a public
issue containing API credentials, private benchmark data, or trace content.

PERSEUS records complete model messages, predicted tool arguments, and tool
results when tracing is enabled. Treat trace and run directories as sensitive.
The runtime never redacts those artifacts after the fact and never serializes
API credential values intentionally.

Only tools explicitly named in `PERSEUS_SAFE_TOOLS` may start before Actor
selection. Review this list for every toolset. Mutation, payment, submission,
message-send, and state-changing tools should remain Actor-only unless their
environment provides a genuine isolated transaction sandbox.
