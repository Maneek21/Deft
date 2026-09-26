import './app-run-enabled-env.js';
// Exercise the actual worker cold-entry import order as well as durable replay.
import { shutdownAppRunRuntime } from '../../src/lib/app-run-runtime.js';
import { Hono } from 'hono';
import { AppPublicClaimService } from '../../src/lib/app-public-service.js';
import { createAppPublicRoutes } from '../../src/routes/app-public.js';
import { closeDb } from '../../src/lib/db.js';
const target = process.env.DATABASE_URL;
if (target !== process.env.DEFT_TEST_DATABASE_URL || !/^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c13_public_hmac_test(?:_v[0-9]+)?$/.test(target ?? '')) throw new Error('Unsafe public HMAC restart fixture');
let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 16_384) throw new Error('Invalid fixture input'); }
try {
  const request = JSON.parse(text);
  const app = new Hono().route('/api/public/apps', createAppPublicRoutes(new AppPublicClaimService({ enabled: true })));
  const response = await app.request(request.path, { method: 'POST', headers: request.headers, body: request.body });
  const result = await response.json() as { code?: string };
  console.log(JSON.stringify({ status: response.status, code: result.code }));
} finally { await shutdownAppRunRuntime(); await closeDb(); }
