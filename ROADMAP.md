# Deft roadmap

This roadmap communicates direction, not delivery dates. Deft is an alpha and priorities may change as pilots expose better evidence.

## Now: make the alpha dependable

- Keep the human workspace surfaces coherent across desktop and mobile
- Harden Defty approval, execution, confirmation, and recovery behavior
- Certify personal MCP and agent employee workflows with real clients
- Improve self-host bootstrap, diagnostics, backups, and operator documentation
- Replace stale repository claims with current product proof
- Keep permission, org isolation, and private-space tests mandatory

## Next preview: make upgrades and releases repeatable

- Support versioned database upgrades from the previous preview
- Publish signed or checksummed release artifacts and a GHCR image
- Add release notes that distinguish fresh installs from upgrades
- Add browser smoke, dependency review, CodeQL, container scanning, and SBOM generation to release gates
- Certify backup, upgrade, rollback, and restore on the supported Docker Compose path
- Expand import/export and operator recovery guidance

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

## Explicit non-commitments

The roadmap does not currently promise native Slack, Gmail, GitHub, Google Calendar OAuth, Linear, or Notion connectors. A hosted multi-customer Deft service is not part of the current self-hosted product promise. External tools should be connected through customer-owned agent or MCP runtimes unless the product contract changes.

See [current limitations](docs/current-limitations.md) for boundaries that apply today.
