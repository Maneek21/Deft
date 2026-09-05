# Loop 1 scheduled App effect evidence

Date: 2026-09-05

The focused database proof uses the current App package lifecycle, real
`CapabilityService` discovery and review, the production automation scanner,
both durable queues, the production fire dispatcher, the generic App Run worker,
and the frozen stdio sandbox email provider. No network provider or stubbed
execution authorizer is used for the proving path.

The initial run reproduced `APP_RUN_AUTHORIZATION_STALE` while preparing the
durable attempt. An automation Run persists its execution actor as the
definition ID, while the live authorizer also needs the approving human identity
to bind the automation actor to the authenticated subject. Reconstruction had
dropped that human identity. It now restores it from the stored authorization
snapshot; the current organization membership and the definition's
`approved_by_user_id` remain independently rechecked.

The green proof delivered the scanner and fire jobs twice and delivered the App
Run attempt twice. The sandbox provider recorded exactly one durable effect and
Deft recorded exactly one signed receipt. A second Run was revoked after its
attempt was durably queued and before the generic worker handled it; the worker
recorded zero additional provider effects and zero receipts for that Run.

Run on a freshly upgraded disposable database:

```powershell
$env:DEFT_TEST_DATABASE_URL='postgres://preview:REDACTED@127.0.0.1:55439/preview_loop1_apps'
node scripts/preview-loop1-app-effect-proof.mjs
```

Fresh result: one test passed, zero failed, exit code 0. The proving test body
took 38.7 seconds and the forced-exit test process completed in 51.8 seconds.
`--test-force-exit` is used because the production runtime retains queue/runtime
handles after the assertions; it does not change test execution or assertions.

The separate 402-definition capacity profile remains a measurement contract.
This effect proof does not claim the profile's query, full-scan, or Org B
fairness thresholds were measured.
