# Native mention ownership and publication

Core owns native references and mention attention. Preserve the existing task/module resource v1 contract and reuse the Platform candidate's additive resource v2 identities unchanged. Only people (including agents), tasks and wiki pages are mention targets in this release. Source integration is limited to Chat, Tasks and Knowledge. Notes/daily notes, Calendar and Canvas are excluded while their product models change.

The compatibility review rejected modifying the shared cross-reference uniqueness key: existing conflict-target callers and manual/module relationships depend on it. Instead, persist one bounded current reference set per native source in a dedicated Core state table. Backlinks query those sets with live source and target authorization. Existing relationship stores retain their ownership.

Use a small database trigger to enqueue reconciliation when native content changes, including direct MCP and agent writes. The trigger sends only source identity through the existing tenant-bound PostgreSQL queue; TypeScript performs extraction and validation. Content and its reconciliation job commit or roll back together. Reconciliation reads current content under a row lock, so old jobs cannot restore old edges. It creates no notification or agent work.

Publication is a separate, authenticated Core operation against the saved content hash. It atomically records the new published recipient set and a durable delivery ledger with its delivery job. Authenticated human Send/Post/edit-save commits hash-bound publication intent with content. Task descriptions and wikis publish through an explicit Notify mentions action after saving; autosave, blur, navigation and wiki Save alone never notify. Persisted human author IDs cannot attest intent because governed agent actions may use them. A revision mismatch is a conflict, not permission to notify from another edit. Repeat publication of the same recipient set is a no-op. Retain delivery identities beyond queue retention.

Outside-chat agent mentions use existing attention records plus identity-bound MCP read/acknowledge adapters. They do not enter the runtime execution channel. Explicit requests use existing shared chat. Existing chat agent invocation and assigned-agent task events keep their current owners.

New references persist identity and neutral labels. Authorized display projections are resolved for the current viewer. Backlinks, attention, notifications and their counts recheck source visibility. The mention task adapter excludes watcher-only grants because the existing watcher authorization defect is a separate remediation concern.

The runtime feature is opt-in. Reader compatibility remains available when publication is disabled. New table/trigger names and the upgrade version must not overlap the active Platform candidate. Screenshots and session recordings must use synthetic data in isolated databases.

The Request action opens the existing agent DM composer; the human writes and sends the instruction. Source-context prefill is deferred. Migration .61 avoids the candidate's reserved .31 through .60. Combining manifests and checksums with the unmerged Platform/Email candidate remains a release integration gate.
