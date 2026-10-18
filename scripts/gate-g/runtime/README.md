# Gate G external runtime crash experiment

This is a **simulation of a proposed external Runtime claim boundary**, not an
adapter to the current production App Run engine. Its control-plane state is in
`simulated-host.sqlite`. A different OS process writes the durable synthetic
provider effect ledger in `external-provider-effects.sqlite`. Neither file is a
Deft database, migration, scheduler, credential store or production receipt.

Run on Node 24 with a new output directory. The runner rejects an existing
directory so evidence is never mixed across runs:

```powershell
node scripts/gate-g/runtime/experiment.mjs --out 'C:/tmp/my-unique-gate-g-runtime-run'
```

The runner forks a runtime worker, which claims and heartbeats an attempt,
marks the provider call boundary, and invokes a separate provider process. The
coordinator kills the worker at two controlled points, waits for the lease to
expire, and reconciles the host state against the independent effect ledger.
Assertions cover double claim, stale heartbeat/completion, idempotent replay,
unsupported reconciliation, cancellation, and exact org/actor/install/version/
grant/epoch substitution. `results.json` records the observed state and effect
counts. A failed assertion exits nonzero; keep the failed output for comparison.

For a cleanup fault check, add `--fail-after-first-pause` with a fresh output
directory. It intentionally exits nonzero after writing `injected-worker-pid.txt`;
the coordinator's `finally` must terminate and await that paused worker.

The fixture deliberately models only the claimed recovery semantics. The
current App Run engine already owns Run, attempt, approval, result and receipt
state; a production Runtime channel must extend those services. No code here
implements registration, authentication, runtime sessions, public endpoints,
live authorization, secret delivery, App-private capability policy, bounded
output or real provider credentials. Passing this experiment is not Gate G
acceptance for R03/R05 or any other production row.
