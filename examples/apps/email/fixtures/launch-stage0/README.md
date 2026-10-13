# Email launch Stage 0 synthetic fixtures

This credential-free pack supplies bounded reusable inputs for Stage 1. All identities and addresses are invented; all addresses and remote-content URLs use the reserved `example.test` domain. `fixtures.json` is private test data, not a Deft manifest, provider response schema, account connection file, or public API contract.

The four account identities cover two Gmail accounts, Microsoft, and IMAP. The personal Gmail conversation has three messages across Inbox and Sent, while the work Gmail account has an independent message with the same subject. Reply-To and Cc candidates are explicit; Bcc exists only in an account-owner Sent copy. One IMAP logical message has before/after folder and UID locators. The pack also includes a benign one-page PDF, hostile HTML and instruction text, malformed MIME, a truncated-source case, and interrupted transport/settlement checkpoints.

Copy this directory into the matching independently installed Email example and run:

```sh
node --test fixtures/launch-stage0/verify.test.mjs
```

The verifier imports the current Email runtime and pinned parser. It uses in-memory test doubles for IMAP reads and interrupted outcomes; it opens no network connection. It checks fixture ownership references, MIME/recipient/thread relationships, locator changes, attachment bytes, malformed-parent denial, metadata fallback, no-resend behavior, and lost result acknowledgement.

The historical Stage 0 runtime parsed PDF but skipped it under its seven-type media policy; `current_runtime_outcome` in the fixture manifest records that baseline. The Stage 1 candidate now admits this PDF's exact bytes only under an explicitly reviewed PDF declaration, while the old selected media policy still skips it. PDF download classification is not sanitization or malware certification. SMTP acceptance proves no recipient delivery. A changed IMAP locator resolves the same Message-ID; the new Email-owned logical index has separate move/replay tests. The Gmail/Microsoft scenario locators remain synthetic. HTML parsing checks fixture readiness only: actual safe rich rendering is a separate gate. Attachment-stage and sync-result interruption entries remain targeted recovery inputs; the verifier does not certify the full real-provider journey.

`synthetic-brief.pdf` was generated with ReportLab in invariant mode. It has one page, no forms, JavaScript, links, embedded files, or encryption. Its byte length and SHA-256 are recorded in `fixtures.json`, and the MIME attachment must match exactly.
