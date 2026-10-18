# Gate G DEC-01 first-wave browser experiment

This is a synthetic localhost fixture, not a Deft Experience Host or public SDK. It never loads a workspace session, credential, external URL, or user data.

Run from the repository root with Node 22+:

```powershell
node scripts/gate-g/experiences/browser-check.mjs
```

The browser check starts `server.mjs` on `127.0.0.1:4311`, uses the locally installed Playwright package (or the Codex desktop bundle) and Chrome, and writes `browser-results.json` plus desktop, 390 px, and 320 px screenshots to `GATE_G_EVIDENCE_DIR` or `~/Documents/Codex/2026-09-24/deft-gate-g/experiences`. Override `GATE_G_EXPERIENCE_PORT` with a free port in 4311–4319. It exits nonzero if the observed security and interaction assertions fail.

For manual inspection, run `node scripts/gate-g/experiences/server.mjs` and open `http://127.0.0.1:4311`. The server only binds loopback. `/sink` records synthetic channel markers in memory; `/observations` shows them. `POST /reset` clears them. The iframe uses `sandbox="allow-scripts"`, an opaque origin, a nonce script, and restrictive response CSP. The Worker has a separate response CSP and returns structured view data for host rendering.

`browser-results.json` distinguishes API-call return values from actual sink hits. A returned WebSocket or EventSource object is not proof that a request escaped. The Worker test proves only the inspected Chrome/localhost channels; it is not a browser-wide no-egress, credential-isolation, deployment, or production certificate.

## Checkpoint 02: credential and sibling isolation

`bootstrap-check.mjs` starts a host on `127.0.0.1:4313` and a trusted bootstrap on `localhost:4314`. The bootstrap is inside an opaque `sandbox="allow-scripts"` iframe. It creates a Blob Worker from synthetic author bytes; those bytes never run in its document. The check runs installed Playwright Chromium, Firefox and WebKit, adds a synthetic host-only cookie, and records actual host/app requests, Worker channel probes, sibling BroadcastChannel messages, IndexedDB/CacheStorage writes and reads, and screenshots.

```powershell
node scripts/gate-g/experiences/bootstrap-check.mjs
$env:GATE_G_BOOTSTRAP_MODE='same-origin'
node scripts/gate-g/experiences/bootstrap-check.mjs
```

The second command is a **control** that adds `allow-same-origin` to both frames. It demonstrates which browser state becomes shared. Clear `GATE_G_BOOTSTRAP_MODE` before the opaque run. Results default to the external `~/Documents/Codex/2026-09-24/deft-gate-g/experiences/checkpoint-02/{http-opaque,http-same-origin}` directories. Set `GATE_G_BROWSER` to one of `chromium`, `firefox` or `webkit` to repeat only that browser, and `GATE_G_CHECKPOINT_02_DIR` to preserve a distinct retry.

For local HTTPS, generate a short-lived, self-signed localhost certificate outside the repository and set these environment variables before running the same check:

```powershell
python scripts/gate-g/experiences/make-local-cert.py 'C:\temp\gate-g-local-cert'
$env:GATE_G_BOOTSTRAP_TLS='1'
$env:GATE_G_BOOTSTRAP_HOST_PORT='4315'
$env:GATE_G_BOOTSTRAP_APP_PORT='4316'
$env:GATE_G_BOOTSTRAP_CERT='C:\temp\gate-g-local-cert\localhost-cert.pem'
$env:GATE_G_BOOTSTRAP_KEY='C:\temp\gate-g-local-cert\localhost-key.pem'
node scripts/gate-g/experiences/bootstrap-check.mjs
```

Playwright ignores this test certificate's trust error. This exercises HTTPS browser behavior, not a real reverse proxy or operator TLS configuration. The synthetic author bundle is embedded without production digest validation. The trusted bootstrap's simple port filter is not a production bridge.
