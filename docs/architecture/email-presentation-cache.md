# Native Email presentation cache

Repeated message opening currently retrieves and parses the original MIME again.
The target is zero provider fetches for a warm, unchanged, authorized reader.

The existing path is human session + native account consent + current connection
authority, then scoped metadata/source lookup, registered provider presentation,
and fresh authority/source checks before response. Keep those checks. Cached HTML
is still untrusted and goes through the existing sandboxed renderer. Files and
images retain their exact-source retrieval path.

Options considered:

- A process LRU is simple but disappears on restart and multiplies per instance.
- A bounded encrypted PostgreSQL cache reuses the mailbox keyring and scopes,
  survives restart, and provides predictable eviction. Choose this option.
- Full MIME caching and offline synchronization add much larger retention and
  file-policy obligations; those remain separate work.

Each key binds org, owner, account, logical message, metadata/source fingerprint,
and the current connected authority version. Every hit still checks current
session/account authority and rechecks the metadata/source before disclosure.
Provider Drafts are excluded because their bodies are mutable. Entries expire
after five minutes, contain at most 480 KiB of JSON, and are capped at 64 entries
per account. Large presentations remain readable but are not cached. These are
rebuildable copies; eviction never alters source mail. SQL-only guards surround
cache transactions, with an account-scoped advisory lock only for bounded writes.
No custody lookup occurs inside those transactions.

Additive migration 81 can be rolled back at the application layer by omitting the
cache dependency. Existing source and metadata tables stay unchanged. Include
cache envelopes in key-retention discovery before enabling the cache.

Acceptance: cold then warm read yields identical presentation with one provider
call; expired/source-changed/authority-changed reads miss; revoked sessions and
changed source during a held hit never disclose; mutable drafts bypass; actual
PostgreSQL tests cover encrypted storage, scope isolation, concurrent capacity,
expiry and key discovery. Fresh/upgrade parity precedes deployment. Fixture
provider-call savings are not a live latency claim.
