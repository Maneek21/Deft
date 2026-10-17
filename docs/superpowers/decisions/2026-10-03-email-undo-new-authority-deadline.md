# A new Undo plan uses new current authority

A completed reversible operation has a retained journal, while its original execution plan expires. The old prepareUndo inherited that original execution deadline, so a new human-approved Undo with fresh same-account/binding authority failed EMAIL_TRIAGE_PLAN_EXPIRED after the original deadline.

Root reviewed and approved a fresh Undo execution deadline: min(current.expires_at, created_at + TRIAGE_LIMITS.ttl_ms). Keeping the original expiry makes ordinary later Undo impossible; extending the original plan would renew old authority and is rejected. The original immutable plan and digest remain unchanged. Old execution still fails after expiry; current owner/account/binding equality, successful-only journal items, reviewed resources, current OAuth authority, provider preconditions and no replay of settled writes remain required. The child still caps each current execution at its authenticated technical-session expiry and300-second wall deadline.

A deterministic mock-provider fixture advances beyond the original plan deadline. Before the fix new Undo fails exactly EMAIL_TRIAGE_PLAN_EXPIRED. After the one-expression fix, focused4/4 checks pass with zero skips: new current authority permits Undo; expired current authority and changed binding deny; original deadline is unchanged; replay cannot repeat provider writes; intervening provider state refuses before writes. Local proof: C:/tmp/deft-email-deep-ui-20261003/receipt-output-proof/undo-expired-before.log and undo-expired-after.log.

This change does not renew expired browsing handles or restore deleted Run action_resources. Those separate host resource gates are preserved and remain independently required before new human confirmation.
