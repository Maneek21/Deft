import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claim, complete, heartbeat, openHost, startCall } from './state.mjs';

const [hostPath, providerPath, runId, mode, retryClass] = process.argv.slice(2);
const db = openHost(hostPath);
const claimed = claim(db, runId);
process.send?.({ event: 'claim', accepted: Boolean(claimed), claim: claimed, process_id: process.pid });
if (!claimed) process.exit(0);
if (!heartbeat(db, claimed.id, claimed.token, 1)) throw new Error('heartbeat rejected');
process.send?.({ event: 'heartbeat' });
let sequence = 1;
const heartbeatTimer = setInterval(() => {
  sequence += 1;
  if (!heartbeat(db, claimed.id, claimed.token, sequence)) clearInterval(heartbeatTimer);
}, 200);
if (!startCall(db, claimed.id, claimed.token)) throw new Error('start rejected');
if (mode === 'before_effect') {
  process.send?.({ event: 'before_effect' });
  await new Promise(() => setInterval(() => {}, 1_000));
}
const providerScript = fileURLToPath(new URL('./provider.mjs', import.meta.url));
const key = retryClass === 'idempotent_with_key'
  ? `idempotent:${runId}` : `unsafe:${runId}:${claimed.id}`;
const effect = await new Promise((resolve, reject) => {
  const processHandle = spawn(process.execPath, [providerScript, 'effect', providerPath, key],
    { timeout: 12_000, killSignal: 'SIGKILL' });
  let stderr = '';
  processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
  processHandle.on('error', reject);
  processHandle.on('exit', (code) => resolve({ code, stderr }));
});
if (effect.code !== 0) throw new Error(effect.stderr);
if (mode === 'after_effect') {
  process.send?.({ event: 'after_effect' });
  await new Promise(() => setInterval(() => {}, 1_000));
}
process.send?.({ event: 'completion', accepted: complete(db, claimed.id, claimed.token) });
clearInterval(heartbeatTimer);
db.close();
