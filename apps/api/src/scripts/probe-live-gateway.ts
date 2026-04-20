/**
 * First-contact probe against the live OpenClaw container.
 * Answers: can our Gateway RPC client actually speak to the real thing?
 */
import 'dotenv/config';
import { OpenClawGateway } from '../lib/openclaw-gateway.js';

async function main() {
  const url = 'ws://localhost:18789';
  const token = 'unconfigured-dev';
  const gateway = new OpenClawGateway(url, token, {
    disableReconnect: true,
    callTimeoutMs: 10_000,
    logWarn: (m, ...a) => console.log('[warn]', m, ...a),
    onMetric: (m) => console.log('[metric]', m),
  });

  const probe = async (label: string, fn: () => Promise<unknown>) => {
    process.stdout.write(`→ ${label.padEnd(35)} `);
    try {
      const r = await fn();
      const s = JSON.stringify(r);
      console.log('OK', s.length > 120 ? s.slice(0, 117) + '...' : s);
    } catch (err) {
      console.log('FAIL', (err as Error).message);
    }
  };

  await probe('skills.status', () => gateway.skills.status());
  await probe('skills.list', () => gateway.skills.list());
  await probe('config.get ("gateway.version")', () => gateway.config.get('gateway.version'));
  await probe('cron.list', () => gateway.cron.list());
  await probe('exec.approval.list', () => gateway.exec.approval.list());

  console.log('\nmetrics:', {
    rpc_count: gateway.metrics.rpc_count,
    errors: gateway.metrics.errors,
    avg_latency_ms: gateway.metrics.rpc_latency_ms.length > 0
      ? Math.round(gateway.metrics.rpc_latency_ms.reduce((a, b) => a + b, 0) / gateway.metrics.rpc_latency_ms.length)
      : 0,
  });

  gateway.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
