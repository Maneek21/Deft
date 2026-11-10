import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
const observations = [];
const port = 4187;
const origin = `http://127.0.0.1:${port}`;
const nonce = randomBytes(18).toString('base64');
const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'`;
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (req.url.startsWith('/sink')) {
    const marker = new URL(req.url, origin).searchParams.get('probe');
    observations.push({ marker, at: new Date().toISOString() });
    console.log(JSON.stringify({ event: 'LOCAL_SYNTHETIC_EGRESS', marker }));
    res.setHeader('Content-Type', 'text/html');
    res.end('<p>Synthetic navigation destination reached. No workspace data was used.</p>');
    return;
  }
  if (req.url === '/observations') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(observations)); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/child') {
    res.setHeader('Content-Security-Policy', policy);
    res.end(`<!doctype html><title>Opaque sandbox child</title><p>Hostile synthetic App fixture</p><script nonce="${nonce}">
      addEventListener('message', async e => {
        if (e.source !== parent || e.data?.kind !== 'initialize' || !e.ports[0]) return;
        const channel = e.ports[0];
        const results = [];
        for (const [name, operation] of [
          ['Read parent DOM', () => parent.document.body.innerText],
          ['Read cookie API', () => document.cookie],
          ['Read local storage', () => localStorage.length],
          ['Create popup', () => { if (!window.open('${origin}/sink?probe=popup')) throw Error('Popup denied'); return 'opened'; }],
        ]) { try { operation(); results.push({name, result:'ALLOWED'}); } catch (error) { results.push({name,result:'BLOCKED',reason:error.name}); } }
        try { await fetch('${origin}/sink?probe=fetch'); results.push({name:'Fetch egress',result:'ALLOWED'}); }
        catch { results.push({name:'Fetch egress',result:'BLOCKED'}); }
        channel.postMessage({kind:'results',results});
        setTimeout(() => { location.href = '${origin}/sink?probe=self-navigation'; }, 100);
      }, {once:true});
    </script>`);
    return;
  }
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deft isolation exploration</title>
    <style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:20px;background:#16151b;color:#eee}button{padding:12px}iframe{display:block;width:100%;height:100px;background:white;margin-top:24px}li{margin:12px 0}.bad{color:#ffae8f}</style>
    <h1>Opaque-origin sandbox experiment</h1><p>Local synthetic markers only. No Deft credentials, workspace records, or external destinations.</p>
    <button id="run">Run isolated probe</button><ul id="results"></ul><p id="navigation" aria-live="polite"></p><div id="frame"></div>
    <script>
      document.getElementById('run').onclick = () => {
        document.getElementById('run').disabled = true;
        const iframe = document.createElement('iframe');
        iframe.title = 'Synthetic hostile App'; iframe.sandbox = 'allow-scripts'; iframe.referrerPolicy = 'no-referrer'; iframe.src = '/child';
        iframe.onload = () => {
          iframe.onload = null;
          const channel = new MessageChannel();
          channel.port1.onmessage = event => {
            if (event.data?.kind !== 'results' || !Array.isArray(event.data.results)) return;
            for (const item of event.data.results) { const li = document.createElement('li'); li.textContent = item.name + ': ' + item.result; document.getElementById('results').append(li); }
          };
          iframe.contentWindow.postMessage({kind:'initialize'}, '*', [channel.port2]);
        };
        document.getElementById('frame').append(iframe);
        setTimeout(async () => {
          const entries = await (await fetch('/observations')).json();
          const nav = document.getElementById('navigation');
          nav.textContent = entries.some(x => x.marker === 'self-navigation') ? 'FAIL: frame self-navigation reached the local sink despite the sandbox and restrictive CSP.' : 'No self-navigation observed in this sample; not a universal egress proof.';
          nav.className = 'bad';
        }, 1600);
      };
    </script>`);
});
server.listen(port, '127.0.0.1', () => console.log(`Isolation spike: ${origin}`));
