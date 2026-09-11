# Deft roadmap

This roadmap communicates direction, not delivery dates. Deft is an alpha and priorities may change as pilots expose better evidence.

## Now: make the alpha dependable

- Keep the human workspace surfaces coherent across desktop and mobile
- Harden Defty approval, execution, confirmation, and recovery behavior
- Certify personal MCP and agent employee workflows with real clients
- Improve self-host bootstrap, diagnostics, backups, and operator documentation
- Replace stale repository claims with current product proof
- Keep permission, org isolation, and private-space tests mandatory

## Current core preview

- `v0.3.0-preview.15` is published as a core release
- Connected Apps and bounded scheduled actions ship as experimental, opt-in capabilities
- Hermes certification and its bundle are excluded from this release
- Release assets include operational notes, checksums, provenance, SBOM, and the exact revision

## Before stable v1

- Define a stable API, migration, and configuration compatibility policy
- Publish a supported release and security maintenance policy
- Complete independent security review of the highest-risk auth, permission, MCP, agent, upload, and WebSocket paths
- Establish measurable performance envelopes for small and medium team deployments
- Close accessibility and cross-browser gaps on core workspace workflows
- Make observability and failure recovery understandable without source-code access

## Later, evidence permitting

- Finer workspace and knowledge permissions
- Broader data import/export
- Additional calendar and external-tool pathways through customer-owned MCP runtimes
- Richer team analytics and administrative audit controls
- Ecosystem work around reusable agent skills and templates
- Arbitrary App custom UI, public portals, general external runtimes, and synchronization after their identity and authorization contracts are defined

## Explicit non-commitments

The roadmap does not currently promise native Slack, Gmail, GitHub, Google Calendar OAuth, Linear, or Notion connectors. A hosted multi-customer Deft service is not part of the current self-hosted product promise. External tools should be connected through customer-owned agent or MCP runtimes unless the product contract changes.

See [current limitations](docs/current-limitations.md) for boundaries that apply today.
