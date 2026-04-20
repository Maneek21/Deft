/**
 * Raw WebSocket probe of the OpenClaw gateway.
 * Observes the actual wire protocol for 10 seconds after connect.
 */
async function main() {
  const url = 'ws://localhost:18789';
  const ws = new WebSocket(url);

  ws.addEventListener('open', () => console.log('[connected]'));
  ws.addEventListener('close', (ev) => console.log(`[closed] code=${ev.code} reason=${ev.reason}`));
  ws.addEventListener('error', (err) => console.log('[error]', (err as ErrorEvent).message));

  let frameNum = 0;
  ws.addEventListener('message', (ev) => {
    frameNum++;
    const text = String(ev.data);
    console.log(`\n[frame ${frameNum}]`);
    try {
      const obj = JSON.parse(text);
      console.log(JSON.stringify(obj, null, 2));
    } catch {
      // Binary or non-JSON
      console.log('raw:', text.slice(0, 500));
    }

    // After the first frame, try responding with a plausible challenge-response
    if (frameNum === 1) {
      try {
        const obj = JSON.parse(text);
        if (obj.event === 'connect.challenge') {
          // Try the simplest ACK: echo back the nonce
          const reply = {
            type: 'response',
            event: 'connect.challenge',
            payload: { nonce: obj.payload.nonce, authorization: 'unconfigured-dev' },
          };
          console.log('\n[sending reply]:', JSON.stringify(reply));
          ws.send(JSON.stringify(reply));
        }
      } catch { /* noop */ }
    }
  });

  setTimeout(() => {
    console.log('\n--- 10s elapsed, closing ---');
    ws.close();
    setTimeout(() => process.exit(0), 500);
  }, 10_000);
}

main().catch((e) => { console.error(e); process.exit(1); });
