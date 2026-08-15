# PERSEUS Harness

Vendored TypeScript agent runtime for the PERSEUS speculative swarm. The public
entrypoint is `../perseus`; do not run the internal CLI directly.

Dependencies are installed into an external cache by
`../scripts/prepare-harness-runtime.sh`. This directory must remain free of
`node_modules`, sessions, credentials, benchmark data, and evaluation logs.
