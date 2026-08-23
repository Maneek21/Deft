#!/usr/bin/env node

import { stdin, stdout } from 'node:process';

const endpoint = process.env.DEFT_MCP_URL;
const token = process.env.DEFT_MCP_TOKEN;

if (!endpoint || !token) {
  console.error('DEFT_MCP_URL and DEFT_MCP_TOKEN are required.');
  process.exit(1);
}

let buffer = Buffer.alloc(0);
let replyMode = 'content-length';

stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  while (buffer.length > 0) {
    const text = buffer.toString('utf8');
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const header = text.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = Buffer.byteLength(text.slice(0, headerEnd + 4));
      if (buffer.length < start + length) return;
      replyMode = 'content-length';
      handleEnvelope(buffer.subarray(start, start + length).toString('utf8'));
      buffer = buffer.subarray(start + length);
      continue;
    }

    const newline = text.indexOf('\n');
    if (newline === -1) return;
    const line = text.slice(0, newline).trim();
    buffer = buffer.subarray(Buffer.byteLength(text.slice(0, newline + 1)));
    if (line) {
      replyMode = 'line';
      handleEnvelope(line);
    }
  }
}

async function handleEnvelope(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }

  const isNotification = envelope.id === undefined || envelope.id === null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(envelope),
    });
    const text = await res.text();
    if (isNotification) return;
    if (!text.trim()) {
      writeEnvelope({
        jsonrpc: '2.0',
        id: envelope.id,
        error: { code: -32000, message: `Deft MCP returned HTTP ${res.status} with an empty body` },
      });
      return;
    }
    writeEnvelope(JSON.parse(text));
  } catch (err) {
    if (isNotification) return;
    writeEnvelope({
      jsonrpc: '2.0',
      id: envelope.id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function writeEnvelope(payload) {
  const body = JSON.stringify(payload);
  if (replyMode === 'line') {
    stdout.write(`${body}\n`);
    return;
  }
  stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}
