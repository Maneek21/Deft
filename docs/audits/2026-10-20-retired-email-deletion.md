# Retired Email implementation deletion evidence (B)

Audited commit: `0d6275650d244411ed2203d561ce137a4845e0e1`. Counts below describe this exact base, not the earlier preview.125 audit.

Delete **134 API source files** (10,138 lines) and **98 retired implementation test files**. No runtime-reachable source is deleted. Four mixed test files retain the surviving draft/send/template/schema assertions while removing retired service/renderer cases. No web, Kit, DB schema, migration or upgrade file is deleted.

## Reproduce the source proof

From this PR worktree after dependency installation:

```sh
node scripts/audit-email-reachability.mjs 0d6275650d244411ed2203d561ce137a4845e0e1 > email-reachability.json
```

The script reads the pinned Git tree (so it still works after deletion), parses every tracked JS/TS source with TypeScript, and builds a conservative graph from every resolvable literal path. This includes static and type imports, re-exports, literal dynamic imports, require, module mocks and relative URL constructors. It deliberately keeps type-only dependencies. Roots are API server.ts, index.ts and workers/index.ts. All 134 selected files are outside this closure; no surviving source/script/package entry imports them. The output gives every candidate's inbound edges and repository-wide exact-stem references, plus a root-to-file chain for every retained source.

## Non-import roots and exceptions reviewed

- Workers explicitly map job names to static/literal dynamic handlers; no directory discovery loads retired mailbox files. `worker-scheduled-routing.test.ts` keeps its regression that retired job names return null even with the old feature flag set. The retained mailbox store still contains a legacy notification job/dedupe string; that is data, not a module loader, and its handler remains retired.
- The only computed import in the live API closure is `app-connection-registry.ts`: an absolute, digest-pinned deployment module exporting `createAppConnectionAdapter`. None of the deleted modules exports that entry point; no tracked adapter config names one. Arbitrary external deployment configs are outside this repository proof. The retired native registry is itself outside the closure.
- API tests are discovered by `run-api-tests.ts` / the preview partition. They are executable test roots, not falsely labeled unreachable files. The 98 deleted tests exercise retired implementation; mixed draft/send/template tests keep storage/CAS/scope/crypto checks. `email-native-compose-links.test.ts` uses computed `consumer(name)` imports; its deleted template renderer case is removed while retained consumers stay covered. Other computed baseline imports select surviving stores or Kit grammar, external app fixtures or test runtimes.
- All tracked package.json scripts, scripts/, workflows and exact filename/string references were scanned. The preview workflow drops its deleted account-catalog test. The preview API partition drops three retired dedicated tests and removes retired keyring/startup isolation entries; the migration63 and mailbox-store dedicated fixtures remain. CLI module loading in `scripts/modules-cli.ts` addresses module tooling, not the Email implementation. Database fixture migration filename construction stays intact.
- CodeQL: remove reviewed false-positive `FP-016` and its sole source hash for `email-graph-send-db.test.ts`. Keep every unrelated disposition/fingerprint unchanged. The CodeQL review unit tests and CI analysis must still pass; do not regenerate suppressions for unexpected findings.
- Web filesystem routes are implicit framework roots: `/email`, its callback, and native-email adoption source/recovery pages stay. `email-e2-2-app-navigation.json` is read by `apps.test.ts`. At this base there are five paths containing Email under web/src, all accounted for. Historical docs reference the removed implementation as historical evidence and are not executable dependencies.

## Deleted source groups

| Family | Files |
| --- | ---: |
| `email-account-*` / `email-account.ts` | 9 |
| `email-agent-*` / `email-agent.ts` | 4 |
| `email-attachment-*` / `email-attachment.ts` | 2 |
| `email-other-*` / `email-other.ts` | 1 |
| `email-calendar-*` / `email-calendar.ts` | 7 |
| `email-context-*` / `email-context.ts` | 2 |
| `email-draft-*` / `email-draft.ts` | 2 |
| `email-folder-*` / `email-folder.ts` | 1 |
| `email-graph-*` / `email-graph.ts` | 1 |
| `email-imap-*` / `email-imap.ts` | 5 |
| `email-incoming-*` / `email-incoming.ts` | 1 |
| `email-knowledge-*` / `email-knowledge.ts` | 2 |
| `email-mailbox-*` / `email-mailbox.ts` | 14 |
| `email-message-*` / `email-message.ts` | 3 |
| `email-native-*` / `email-native.ts` | 19 |
| `email-notification-*` / `email-notification.ts` | 4 |
| `email-operation-*` / `email-operation.ts` | 1 |
| `email-outbox-*` / `email-outbox.ts` | 4 |
| `email-presentation-*` / `email-presentation.ts` | 1 |
| `email-provider-*` / `email-provider.ts` | 16 |
| `email-reading-*` / `email-reading.ts` | 2 |
| `email-recipient-*` / `email-recipient.ts` | 3 |
| `email-rule-*` / `email-rule.ts` | 6 |
| `email-search-*` / `email-search.ts` | 1 |
| `email-send-*` / `email-send.ts` | 1 |
| `email-sent-*` / `email-sent.ts` | 6 |
| `email-signature-*` / `email-signature.ts` | 3 |
| `email-template-*` / `email-template.ts` | 2 |
| `email-timer-*` / `email-timer.ts` | 9 |
| `email-unread-*` / `email-unread.ts` | 2 |

## Per-file source evidence

Every row has **no server/worker root path**. Incoming source edges are exclusively inside the deletion set. Test importers are retired or have only the retired cases removed. Full reference paths and exact chains are reproducible with the command above.

| Deleted file (`apps/api/src/lib/`) | Inbound deleted sources | Test importers |
| --- | ---: | --- |
| `email-account-authority-router.ts` | 17 | `email-account-consent-store-db.test.ts` |
| `email-account-authority.ts` | 1 | `email-account-consent-store-db.test.ts`, `email-knowledge-db.test.ts`, `email-native-connection-account-db.test.ts` |
| `email-account-catalog.ts` | 1 | `email-account-catalog.test.ts` |
| `email-account-connection.ts` | 0 | `email-account-connection.test.ts` |
| `email-account-consent-store.ts` | 10 | `email-account-consent-store-db.test.ts`, `email-knowledge-db.test.ts`, `email-native-connection-account-db.test.ts` |
| `email-account-lifecycle-runtime.ts` | 0 | None |
| `email-account-lifecycle-service.ts` | 1 | `email-account-consent-store-db.test.ts` |
| `email-account-lifecycle.ts` | 10 | `email-account-connection.test.ts`, `email-account-consent-store-db.test.ts`, `email-account-lifecycle.test.ts`, `email-knowledge-db.test.ts`, `email-native-connection-account-db.test.ts` |
| `email-account-owner-authority.ts` | 2 | `email-account-consent-store-db.test.ts` |
| `email-agent-access.ts` | 0 | None |
| `email-agent-authority.ts` | 1 | None |
| `email-agent-tool-runtime.ts` | 0 | None |
| `email-agent-tools.ts` | 1 | `email-agent-tools-contract.test.ts` |
| `email-attachment-runtime.ts` | 1 | None |
| `email-attachment-service.ts` | 2 | `email-attachment-service-send.test.ts`, `email-native-send-attachment-integration-db.test.ts` |
| `email-availability.ts` | 0 | `email-availability.test.ts` |
| `email-calendar-attendee-projection.ts` | 1 | `email-calendar-attendee-projection.test.ts` |
| `email-calendar-invitation-contract.ts` | 3 | None |
| `email-calendar-invitation-preview.ts` | 2 | `email-calendar-attendee-projection.test.ts`, `email-calendar-invitation-preview.test.ts`, `email-calendar-invitation-store-db.test.ts` |
| `email-calendar-invitation-runtime.ts` | 0 | None |
| `email-calendar-invitation-service.ts` | 1 | `email-calendar-attendee-projection.test.ts`, `email-calendar-invitation-store-db.test.ts` |
| `email-calendar-invitation-store.ts` | 3 | `email-calendar-attendee-projection.test.ts`, `email-calendar-invitation-store-db.test.ts` |
| `email-calendar-reply-outbox.ts` | 2 | `email-calendar-invitation-store-db.test.ts` |
| `email-context-transfer-runtime.ts` | 0 | None |
| `email-context-transfer.ts` | 1 | None |
| `email-draft-runtime.ts` | 1 | None |
| `email-draft-sync-journal.ts` | 2 | `email-draft-sync-journal-db.test.ts`, `email-folder-management-rollback-db.test.ts` |
| `email-folder-management-journal.ts` | 1 | `email-folder-management-db.test.ts` |
| `email-graph-send-journal.ts` | 2 | `email-folder-management-rollback-db.test.ts`, `email-graph-send-db.test.ts` |
| `email-imap-alias-store.ts` | 1 | `email-imap-alias-db.test.ts` |
| `email-imap-credential-store.ts` | 1 | `email-imap-credential-store-db.test.ts` |
| `email-imap-runtime.ts` | 2 | `email-imap-runtime.test.ts` |
| `email-imap-setup-probe.ts` | 1 | `email-imap-setup-probe.test.ts` |
| `email-imap-setup-targets.ts` | 0 | `email-imap-setup-targets.test.ts` |
| `email-incoming-read-budget.ts` | 2 | `email-incoming-read-budget.test.ts` |
| `email-knowledge-runtime.ts` | 0 | `email-knowledge-db.test.ts` |
| `email-knowledge.ts` | 1 | `email-knowledge-db.test.ts`, `email-knowledge.test.ts` |
| `email-mailbox-authority.ts` | 23 | `email-account-consent-store-db.test.ts`, `email-mailbox-authority-db.test.ts`, `email-mailbox-authority.test.ts`, `email-mailbox-checkpoint-race-db.test.ts`, `email-mailbox-enrollment.test.ts`, `email-mailbox-refresh-db.test.ts`, `email-mailbox-refresh.test.ts` |
| `email-mailbox-connected-authority.ts` | 12 | `email-folder-management-runtime.test.ts`, `email-mailbox-connected-authority.test.ts`, `email-mailbox-native-imap-db.test.ts`, `email-mailbox-native-provider-db.test.ts`, `email-reading-preferences.test.ts` |
| `email-mailbox-connection-completion.ts` | 0 | `email-mailbox-connection-completion.test.ts` |
| `email-mailbox-conversation.ts` | 2 | `email-mailbox-conversation.test.ts`, `email-native-imap-query.test.ts` |
| `email-mailbox-enrollment.ts` | 1 | `email-imap-setup-db.test.ts`, `email-mailbox-enrollment.test.ts` |
| `email-mailbox-job.ts` | 1 | `email-mailbox-checkpoint-race-db.test.ts`, `email-mailbox-job.test.ts` |
| `email-mailbox-provider.ts` | 9 | `email-imap-alias-db.test.ts`, `email-incoming-read-budget.test.ts`, `email-mailbox-native-imap-db.test.ts`, `email-mailbox-native-provider-db.test.ts`, `email-mailbox-provider.test.ts`, `email-message-presentation.test.ts`, `email-native-imap-query.test.ts` |
| `email-mailbox-refresh.ts` | 0 | `email-mailbox-checkpoint-race-db.test.ts`, `email-mailbox-refresh-db.test.ts`, `email-mailbox-refresh.test.ts` |
| `email-mailbox-runtime.ts` | 25 | `email-folder-management-runtime.test.ts` |
| `email-mailbox-scheduler-runtime.ts` | 3 | `email-mailbox-scheduler-runtime-db.test.ts` |
| `email-mailbox-scheduler.ts` | 2 | `email-mailbox-checkpoint-race-db.test.ts`, `email-mailbox-refresh-db.test.ts`, `email-mailbox-refresh.test.ts`, `email-mailbox-scheduler.test.ts` |
| `email-mailbox-search.ts` | 3 | `email-mailbox-native-provider-db.test.ts`, `email-mailbox-search.test.ts`, `email-native-imap-query.test.ts` |
| `email-mailbox-service-runtime.ts` | 0 | `email-mailbox-checkpoint-race-db.test.ts`, `email-mailbox-service-runtime.test.ts` |
| `email-mailbox-unified.ts` | 1 | `email-mailbox-unified.test.ts` |
| `email-message-content.ts` | 9 | `email-calendar-invitation-preview.test.ts`, `email-mailbox-native-provider-db.test.ts`, `email-message-content.test.ts`, `email-message-presentation.test.ts`, `email-native-incoming-size.test.ts` |
| `email-message-summary-runtime.ts` | 0 | None |
| `email-message-summary.ts` | 1 | None |
| `email-native-adoption-gate.ts` | 4 | None |
| `email-native-connection-account-store.ts` | 3 | `email-context-transfer-mounted-db.test.ts`, `email-native-connection-account-db.test.ts` |
| `email-native-connection-implementation.ts` | 1 | `email-native-connection-implementation.test.ts`, `email-native-connection-registry.test.ts` |
| `email-native-connection-mailbox.ts` | 1 | None |
| `email-native-connection-owner.ts` | 1 | `email-native-connection-account-db.test.ts` |
| `email-native-connection-profile.ts` | 3 | `email-native-connection-account-db.test.ts` |
| `email-native-connection-registry.ts` | 3 | `email-native-connection-registry.test.ts` |
| `email-native-connection-retained-runtime.ts` | 1 | None |
| `email-native-connection-runtime.ts` | 0 | None |
| `email-native-connection-service.ts` | 1 | `email-native-connection-account-db.test.ts`, `email-native-connection-service.test.ts` |
| `email-native-connection-store.ts` | 3 | `email-native-connection-account-db.test.ts`, `email-native-connection-store-db.test.ts` |
| `email-native-draft-provider.ts` | 4 | `email-native-draft-provider.test.ts` |
| `email-native-folders.ts` | 1 | `email-folder-management-runtime.test.ts`, `email-folder-management.test.ts`, `email-native-folders.test.ts` |
| `email-native-outgoing-snapshot.ts` | 4 | `email-calendar-invitation-store-db.test.ts`, `email-graph-send-db.test.ts`, `email-native-outgoing-snapshot.test.ts`, `email-native-recipient-profile.test.ts`, `email-native-send-attachment-integration-db.test.ts`, `email-outbox-db.test.ts` |
| `email-native-reply-policy.ts` | 2 | `email-native-recipient-profile.test.ts` |
| `email-native-reply.ts` | 2 | `email-native-recipient-profile.test.ts`, `email-native-reply.test.ts` |
| `email-native-send-provider.ts` | 2 | `email-graph-send-db.test.ts`, `email-native-send-attachment-integration-db.test.ts`, `email-native-send-provider.test.ts` |
| `email-native-send-service.ts` | 6 | `email-native-send-attachment-integration-db.test.ts`, `email-native-send-envelope.test.ts`, `email-native-send-store-db.test.ts` |
| `email-native-triage.ts` | 4 | `email-imap-alias-db.test.ts`, `email-mailbox-checkpoint-race-db.test.ts`, `email-native-folders.test.ts`, `email-native-triage-sync-race.test.ts`, `email-native-triage.test.ts`, `email-notification-db.test.ts`, `email-rule-execution.test.ts`, `email-triage-membership-ack-db.test.ts`, `email-triage-message-ack-db.test.ts` |
| `email-notification-runtime.ts` | 0 | None |
| `email-notification-scheduler-runtime.ts` | 0 | `email-notification-db.test.ts` |
| `email-notification-scheduler.ts` | 1 | None |
| `email-notification.ts` | 2 | `email-notification.test.ts` |
| `email-operation-journal.ts` | 2 | `email-folder-management-rollback-db.test.ts`, `email-imap-alias-db.test.ts`, `email-operation-journal-db.test.ts` |
| `email-outbox-job.ts` | 0 | `email-outbox-schedule.test.ts` |
| `email-outbox-runtime.ts` | 1 | None |
| `email-outbox-schedule.ts` | 2 | `email-outbox-schedule.test.ts` |
| `email-outbox-service.ts` | 1 | `email-graph-send-db.test.ts`, `email-outbox-db.test.ts` |
| `email-presentation-cache.ts` | 1 | `email-presentation-cache-db.test.ts` |
| `email-provider-draft-cleanup-job.ts` | 4 | `email-provider-draft-cleanup-job.test.ts` |
| `email-provider-draft-cleanup-runtime.ts` | 0 | None |
| `email-provider-draft-cleanup-scheduler-runtime.ts` | 0 | None |
| `email-provider-draft-cleanup-scheduler.ts` | 1 | `email-provider-draft-cleanup-db.test.ts` |
| `email-provider-draft-cleanup.ts` | 1 | `email-provider-draft-cleanup-db.test.ts` |
| `email-provider-draft-controls-runtime.ts` | 0 | None |
| `email-provider-draft-controls.ts` | 1 | `email-provider-draft-cleanup-db.test.ts`, `email-provider-draft-scheduler-db.test.ts` |
| `email-provider-draft-job.ts` | 5 | `email-provider-draft-job.test.ts` |
| `email-provider-draft-mime.ts` | 1 | `email-draft-store-db.test.ts`, `email-native-recipient-profile.test.ts`, `email-provider-draft-mime.test.ts` |
| `email-provider-draft-mirror-service.ts` | 2 | `email-draft-store-db.test.ts`, `email-provider-draft-mirror-service.test.ts` |
| `email-provider-draft-mirror-store.ts` | 9 | `email-draft-store-db.test.ts`, `email-provider-draft-cleanup-db.test.ts`, `email-provider-draft-scheduler-db.test.ts` |
| `email-provider-draft-recovery.ts` | 1 | `email-provider-draft-scheduler-db.test.ts` |
| `email-provider-draft-runtime.ts` | 0 | None |
| `email-provider-draft-scheduler-runtime.ts` | 0 | None |
| `email-provider-draft-scheduler.ts` | 1 | `email-provider-draft-scheduler-db.test.ts` |
| `email-provider-draft-settings.ts` | 0 | `email-provider-draft-settings-db.test.ts`, `email-provider-draft-settings.test.ts` |
| `email-reading-preferences.ts` | 1 | `email-reading-preferences.test.ts` |
| `email-reading-source-policy.ts` | 0 | `email-reading-source-policy.test.ts` |
| `email-recipient-assistance.ts` | 2 | `email-recipient-assistance.test.ts` |
| `email-recipient-contacts.ts` | 1 | `email-recipient-assistance.test.ts` |
| `email-recipient-runtime.ts` | 0 | None |
| `email-rule-execution.ts` | 1 | `email-rule-execution.test.ts` |
| `email-rule-receipt-store.ts` | 2 | `email-rule-receipt-store-db.test.ts` |
| `email-rule-runtime.ts` | 0 | None |
| `email-rule-service.ts` | 2 | `email-rule-service.test.ts` |
| `email-rule-store.ts` | 2 | `email-rule-receipt-store-db.test.ts`, `email-rule-store-db.test.ts` |
| `email-rule-types.ts` | 4 | `email-rule-receipt-store-db.test.ts`, `email-rule-service.test.ts`, `email-rule-store-db.test.ts` |
| `email-search-diagnostics.ts` | 2 | `email-mailbox-authority.test.ts`, `email-mailbox-search.test.ts`, `email-search-diagnostics.test.ts` |
| `email-send-runtime.ts` | 3 | None |
| `email-sent-copy-job.ts` | 0 | `email-outbox-db.test.ts`, `email-sent-copy-job.test.ts` |
| `email-sent-copy-journal.ts` | 1 | `email-folder-management-rollback-db.test.ts`, `email-outbox-db.test.ts` |
| `email-sent-copy-provider.ts` | 3 | `email-outbox-db.test.ts` |
| `email-sent-copy-runtime.ts` | 0 | None |
| `email-sent-copy-service.ts` | 1 | `email-outbox-db.test.ts` |
| `email-sent-copy-settings.ts` | 1 | `email-sent-copy-settings.test.ts` |
| `email-signature-runtime.ts` | 0 | None |
| `email-signature-service.ts` | 1 | `email-signature-store-db.test.ts` |
| `email-signature-store.ts` | 2 | `email-signature-store-db.test.ts` |
| `email-template-runtime.ts` | 0 | None |
| `email-template-service.ts` | 1 | `email-template-store-db.test.ts` |
| `email-timer-job.ts` | 0 | `email-timer-job.test.ts` |
| `email-timer-runtime.ts` | 1 | None |
| `email-timer-scheduler-runtime.ts` | 1 | None |
| `email-timer-scheduler.ts` | 1 | None |
| `email-timer-service.ts` | 1 | `email-timer-service.test.ts` |
| `email-timer-store.ts` | 4 | `email-timer-store-db.test.ts`, `email-timer-unread-scale.test.ts`, `email-unread-aggregate-db.test.ts`, `email-unread-aggregate.test.ts`, `email-unread-scale-db.test.ts` |
| `email-timer-types.ts` | 7 | `email-timer-job.test.ts`, `email-timer-service.test.ts`, `email-timer-store-db.test.ts` |
| `email-timer-worker-runtime.ts` | 0 | None |
| `email-timer-worker.ts` | 1 | None |
| `email-unread-runtime.ts` | 0 | None |
| `email-unread.ts` | 1 | `email-notification-db.test.ts`, `email-unread-aggregate-db.test.ts`, `email-unread-scale-db.test.ts`, `email-unread.test.ts` |

The computed template renderer reference in `email-native-compose-links.test.ts` is additionally reviewed above; it is not a literal import edge.

## Retired tests

These are removed with their obsolete implementations, not skipped or excluded from discovery. Storage/migration, key inventory, Knowledge audience, Calendar projection and adoption compatibility coverage remains.

- `apps/api/test/email-account-catalog.test.ts`
- `apps/api/test/email-account-connection.test.ts`
- `apps/api/test/email-account-consent-store-db.test.ts`
- `apps/api/test/email-account-lifecycle.test.ts`
- `apps/api/test/email-agent-tools-contract.test.ts`
- `apps/api/test/email-attachment-service-send.test.ts`
- `apps/api/test/email-availability.test.ts`
- `apps/api/test/email-calendar-attendee-projection.test.ts`
- `apps/api/test/email-calendar-invitation-preview.test.ts`
- `apps/api/test/email-calendar-invitation-store-db.test.ts`
- `apps/api/test/email-context-transfer-mounted-db.test.ts`
- `apps/api/test/email-draft-sync-journal-db.test.ts`
- `apps/api/test/email-folder-management-db.test.ts`
- `apps/api/test/email-folder-management-rollback-db.test.ts`
- `apps/api/test/email-folder-management-runtime.test.ts`
- `apps/api/test/email-folder-management.test.ts`
- `apps/api/test/email-graph-send-db.test.ts`
- `apps/api/test/email-imap-alias-db.test.ts`
- `apps/api/test/email-imap-credential-store-db.test.ts`
- `apps/api/test/email-imap-runtime.test.ts`
- `apps/api/test/email-imap-setup-db.test.ts`
- `apps/api/test/email-imap-setup-probe.test.ts`
- `apps/api/test/email-imap-setup-targets.test.ts`
- `apps/api/test/email-incoming-read-budget.test.ts`
- `apps/api/test/email-knowledge-db.test.ts`
- `apps/api/test/email-knowledge.test.ts`
- `apps/api/test/email-mailbox-authority-db.test.ts`
- `apps/api/test/email-mailbox-authority.test.ts`
- `apps/api/test/email-mailbox-checkpoint-race-db.test.ts`
- `apps/api/test/email-mailbox-connected-authority.test.ts`
- `apps/api/test/email-mailbox-connection-completion.test.ts`
- `apps/api/test/email-mailbox-conversation.test.ts`
- `apps/api/test/email-mailbox-enrollment.test.ts`
- `apps/api/test/email-mailbox-job.test.ts`
- `apps/api/test/email-mailbox-native-imap-db.test.ts`
- `apps/api/test/email-mailbox-native-provider-db.test.ts`
- `apps/api/test/email-mailbox-provider.test.ts`
- `apps/api/test/email-mailbox-refresh-db.test.ts`
- `apps/api/test/email-mailbox-refresh.test.ts`
- `apps/api/test/email-mailbox-scheduler-runtime-db.test.ts`
- `apps/api/test/email-mailbox-scheduler.test.ts`
- `apps/api/test/email-mailbox-search.test.ts`
- `apps/api/test/email-mailbox-service-runtime.test.ts`
- `apps/api/test/email-mailbox-unified.test.ts`
- `apps/api/test/email-message-content.test.ts`
- `apps/api/test/email-message-presentation.test.ts`
- `apps/api/test/email-native-connection-account-db.test.ts`
- `apps/api/test/email-native-connection-implementation.test.ts`
- `apps/api/test/email-native-connection-registry.test.ts`
- `apps/api/test/email-native-connection-service.test.ts`
- `apps/api/test/email-native-connection-store-db.test.ts`
- `apps/api/test/email-native-draft-provider.test.ts`
- `apps/api/test/email-native-folders.test.ts`
- `apps/api/test/email-native-imap-query.test.ts`
- `apps/api/test/email-native-incoming-size.test.ts`
- `apps/api/test/email-native-outgoing-snapshot.test.ts`
- `apps/api/test/email-native-recipient-profile.test.ts`
- `apps/api/test/email-native-reply.test.ts`
- `apps/api/test/email-native-send-attachment-integration-db.test.ts`
- `apps/api/test/email-native-send-envelope.test.ts`
- `apps/api/test/email-native-send-provider.test.ts`
- `apps/api/test/email-native-triage-sync-race.test.ts`
- `apps/api/test/email-native-triage.test.ts`
- `apps/api/test/email-notification-db.test.ts`
- `apps/api/test/email-notification.test.ts`
- `apps/api/test/email-operation-journal-db.test.ts`
- `apps/api/test/email-outbox-db.test.ts`
- `apps/api/test/email-outbox-schedule.test.ts`
- `apps/api/test/email-presentation-cache-db.test.ts`
- `apps/api/test/email-provider-draft-cleanup-db.test.ts`
- `apps/api/test/email-provider-draft-cleanup-job.test.ts`
- `apps/api/test/email-provider-draft-job.test.ts`
- `apps/api/test/email-provider-draft-mime.test.ts`
- `apps/api/test/email-provider-draft-mirror-service.test.ts`
- `apps/api/test/email-provider-draft-scheduler-db.test.ts`
- `apps/api/test/email-provider-draft-settings-db.test.ts`
- `apps/api/test/email-provider-draft-settings.test.ts`
- `apps/api/test/email-reading-preferences.test.ts`
- `apps/api/test/email-reading-source-policy.test.ts`
- `apps/api/test/email-recipient-assistance.test.ts`
- `apps/api/test/email-rule-execution.test.ts`
- `apps/api/test/email-rule-receipt-store-db.test.ts`
- `apps/api/test/email-rule-service.test.ts`
- `apps/api/test/email-rule-store-db.test.ts`
- `apps/api/test/email-search-diagnostics.test.ts`
- `apps/api/test/email-sent-copy-job.test.ts`
- `apps/api/test/email-sent-copy-settings.test.ts`
- `apps/api/test/email-signature-store-db.test.ts`
- `apps/api/test/email-timer-job.test.ts`
- `apps/api/test/email-timer-service.test.ts`
- `apps/api/test/email-timer-store-db.test.ts`
- `apps/api/test/email-timer-unread-scale.test.ts`
- `apps/api/test/email-triage-membership-ack-db.test.ts`
- `apps/api/test/email-triage-message-ack-db.test.ts`
- `apps/api/test/email-unread-aggregate-db.test.ts`
- `apps/api/test/email-unread-aggregate.test.ts`
- `apps/api/test/email-unread-scale-db.test.ts`
- `apps/api/test/email-unread.test.ts`

## Retained API source (35 files)

Each chain ends at a live source root. Type-only transitive contracts are retained conservatively; extracting them would be another refactor.

| File | Immediate parent in root traversal |
| --- | --- |
| `apps/api/src/lib/email-agent-actor.ts` | `apps/api/src/lib/email-mailbox-service.ts` |
| `apps/api/src/lib/email-attachment-crypto.ts` | `apps/api/src/lib/email-attachment-store.ts` |
| `apps/api/src/lib/email-attachment-store.ts` | `apps/api/src/lib/email-native-adoption-recovery.ts` |
| `apps/api/src/lib/email-calendar-invitation.ts` | `apps/api/src/lib/email-calendar-projection.ts` |
| `apps/api/src/lib/email-calendar-projection.ts` | `apps/api/src/routes/dashboard.ts` |
| `apps/api/src/lib/email-draft-service.ts` | `apps/api/src/lib/email-attachment-store.ts` |
| `apps/api/src/lib/email-draft-store.ts` | `apps/api/src/lib/email-native-adoption-recovery.ts` |
| `apps/api/src/lib/email-draft-sync-contract.ts` | `apps/api/src/lib/email-native-adapter-contract.ts` |
| `apps/api/src/lib/email-folder-management-contract.ts` | `apps/api/src/lib/email-native-adapter-contract.ts` |
| `apps/api/src/lib/email-graph-send-contract.ts` | `apps/api/src/lib/email-native-adapter-contract.ts` |
| `apps/api/src/lib/email-imap-alias-contract.ts` | `apps/api/src/lib/email-native-adapter-contract.ts` |
| `apps/api/src/lib/email-imap-custody.ts` | `apps/api/src/lib/email-imap-host.ts` |
| `apps/api/src/lib/email-imap-host.ts` | `apps/api/src/lib/email-native-adapter-contract.ts` |
| `apps/api/src/lib/email-knowledge-citations.ts` | `apps/api/src/lib/native-wiki-owner.ts` |
| `apps/api/src/lib/email-knowledge-visibility.ts` | `apps/api/src/lib/retrieve-context.ts` |
| `apps/api/src/lib/email-mailbox-crypto.ts` | `apps/api/src/lib/email-native-adoption-recovery.ts` |
| `apps/api/src/lib/email-mailbox-key-references.ts` | `apps/api/src/lib/app-run-runtime.ts` |
| `apps/api/src/lib/email-mailbox-service.ts` | `apps/api/src/lib/email-mailbox-store.ts` |
| `apps/api/src/lib/email-mailbox-store.ts` | `apps/api/src/lib/email-native-adoption-recovery.ts` |
| `apps/api/src/lib/email-native-adapter-contract.ts` | `apps/api/src/lib/email-outbox-contract.ts` |
| `apps/api/src/lib/email-native-adoption-citations.ts` | `apps/api/src/routes/email-native-adoption-source.ts` |
| `apps/api/src/lib/email-native-adoption-publication.ts` | `apps/api/src/lib/email-native-adoption-citations.ts` |
| `apps/api/src/lib/email-native-adoption-recovery.ts` | `apps/api/src/lib/email-native-adoption-citations.ts` |
| `apps/api/src/lib/email-native-connection-contract.ts` | `apps/api/src/lib/email-native-connection-retained.ts` |
| `apps/api/src/lib/email-native-connection-retained.ts` | `apps/api/src/lib/email-native-adapter-contract.ts` |
| `apps/api/src/lib/email-outbox-contract.ts` | `apps/api/src/lib/email-outbox-crypto.ts` |
| `apps/api/src/lib/email-outbox-crypto.ts` | `apps/api/src/lib/email-outbox-store.ts` |
| `apps/api/src/lib/email-outbox-store.ts` | `apps/api/src/lib/email-native-adoption-recovery.ts` |
| `apps/api/src/lib/email-public-address.ts` | `apps/api/src/lib/email-imap-host.ts` |
| `apps/api/src/lib/email-send-store.ts` | `apps/api/src/lib/email-native-adoption-recovery.ts` |
| `apps/api/src/lib/email-sent-copy-contract.ts` | `apps/api/src/lib/email-native-adapter-contract.ts` |
| `apps/api/src/lib/email-signature-types.ts` | `apps/api/src/lib/email-draft-service.ts` |
| `apps/api/src/lib/email-smtp-host.ts` | `apps/api/src/lib/email-native-adapter-contract.ts` |
| `apps/api/src/lib/email-template-store.ts` | `apps/api/src/lib/email-signature-types.ts` |
| `apps/api/src/routes/email-native-adoption-source.ts` | `apps/api/src/index.ts` |

## Database inventory: keep all of it

The 19 Email-named schema modules declare 40 tables: **39 Email-only domain/legacy-adoption tables and one shared capture budget table**. All schema definitions, fresh-install extras, historical upgrade SQL, lineage manifests and checksums stay byte-for-byte unchanged. Shared `events`, wiki pages/citations, jobs, users, connected accounts and generic App tables are not Email-only.

| Schema module | Tables | Later drop assessment |
| --- | --- | --- |
| `email-account-consent-schema.ts` | `email_account_consents` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-agent-grant-schema.ts` | `email_agent_grants` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-attachment-schema.ts` | `email_attachments` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-calendar-invitation-schema.ts` | `email_calendar_invitations`, `email_calendar_invitation_actions` | Candidate only after invitation history, receipts and retained key references are migrated or explicitly purged; events metadata needs separate conversion. |
| `email-context-transfer-schema.ts` | `email_context_transfers` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-imap-alias-schema.ts` | `email_imap_aliases`, `email_imap_move_reservations` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-knowledge-schema.ts` | `email_knowledge_policies`, `email_knowledge_observations`, `email_knowledge_sources`, `email_knowledge_threads`, `email_knowledge_budgets` | Sources/citations must migrate first. Policies/observations/threads may be dropped only after retention and FK review. Budgets are shared with generic capture: migrate reservations/config names, never drop as Email-only. |
| `email-native-connection-schema.ts` | `email_native_connection_owners`, `email_native_connection_requests`, `email_native_account_connections` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-notification-schema.ts` | `email_notification_events`, `email_notification_states` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-operation-schema.ts` | `email_operations` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-outbox-schema.ts` | `email_outbox`, `email_outbox_events` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-presentation-cache-schema.ts` | `email_presentation_cache` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-rule-receipt-schema.ts` | `email_rule_receipts` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-rule-schema.ts` | `email_rules` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-schema.ts` | `email_accounts`, `email_checkpoints`, `email_messages`, `email_memberships`, `email_sync_receipts`, `email_provider_states`, `email_reading_preferences`, `email_imap_credentials`, `email_drafts`, `email_send_operations`, `email_provider_draft_mirrors` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-signature-schema.ts` | `email_signatures` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-template-schema.ts` | `email_templates` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `email-timer-schema.ts` | `email_timers` | Candidate for a later explicit migration only after adoption/export or authorized purge, retention, FK/trigger and key-inventory checks; not safe to drop merely because execution was retired. |
| `native-email-adoption-schema.ts` | `native_email_adoptions`, `native_email_adoption_destinations` | Keep as routing/adoption receipts and recovery authority; no drop until historical links and recovery are retired or migrated. |

A future drop must inventory actual rows per org (including soft-deleted/disconnected data), preserve or export user content and audit receipts, handle FKs/triggers without CASCADE data loss, preserve restore/upgrade compatibility, and prove no active query or ciphertext-key reference remains. This PR makes no database inspection or drop request against any deployment.

## Validation scope

Run API typecheck, focused retained contracts, CodeQL disposition tests, preview partition discovery and public docs checks locally. PR CI must additionally pass full API tests, web type/lint/build, supported upgrades, production-image/browser smoke and security analysis. This document is an audit record, not a claim that remote checks have passed; the PR check results are authoritative.
