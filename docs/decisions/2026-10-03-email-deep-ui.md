# Email deep UI pass — 3 October 2026

Status: implemented candidate; local verification in progress. Not deployed.

## Decision

Keep the independently built Email Worker declarative. Place mailbox controls in the list column and message controls in the reader. Use existing bounded stack, button and input primitives; no new bridge authority or presentation contract. The shared renderer uses host-owned icons and preserves accessible text labels when compacting toolbar actions. Native settings, composer and result dialogs use existing Deft tokens and components.

Account selection and configuration live in host-owned Email settings, reachable through the native workspace navigation. Remove the duplicate account selector and app tools footer. Message data remains literal text. No new provider action is introduced by this pass.

Native composition keeps scalar mailbox input on every keystroke, saved revision/CAS, exact preview invalidation, file manifest verification and the existing send path. Pending or unknown outcomes never trigger automatic resend. Settings keeps current reviewed account/access and approval boundaries; no default identity or unsupported preference is invented.

## Alternatives

A native Email-specific page would duplicate the package/host boundary and is rejected. Extending the declarative protocol solely for this layout is unnecessary. More mockup-only work would not exercise the current production components.

## Baselines and rollback

Web source: C:/tmp/deft-email-web-request-focus-rerender-20261003/source.
Worker source: C:/tmp/deft-email-request-quota-stage1-20261003/worker/email (active stage1.6).
Candidate: C:/tmp/deft-email-deep-ui-20261003/source.
Native runtime17 remains untouched. Candidate changes are isolated from production and the dirty integration checkout. Revert the scoped UI delta to return to the captured baseline. A future deployment must include corresponding source and re-run live navigation/account and draft smoke checks.

## Verification

Check affected host/Worker behavioral tests, TypeScript, affected-file lint, production build, and browser review of desktop/mobile mailbox, reader, search, drafts, composer, settings, files and request outcomes. Fixtures use synthetic data and do not certify real delivery. Full replacement roadmap and unverified live-provider/zoom checks remain separate.
