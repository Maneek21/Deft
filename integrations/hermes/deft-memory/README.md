# Deft memory provider for Hermes

This adapter uses Hermes's native `MemoryProvider` contract. Deft remains the
canonical company wiki; Hermes keeps its normal local `MEMORY.md` and `USER.md`.

Install the directory as `$HERMES_HOME/plugins/deft-memory`, set
`memory.provider: deft-memory`, and configure:

- `DEFT_MCP_URL=https://your-deft.example/api/mcp/v1`
- `DEFT_MCP_TOKEN=<employee-specific token>`

The provider automatically recalls scoped Deft wiki context before turns,
records a concise turn receipt after responses, and mirrors explicit Hermes
memory writes into an employee-owned Deft wiki page. Verified shared knowledge
is promoted with Deft's existing `memory_update` approval flow.

Hermes must be upgraded to a version whose memory-provider discovery supports
user or packaged providers before certification. The currently audited v0.16.0
runtime is not the production baseline.
