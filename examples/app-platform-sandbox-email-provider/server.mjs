#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const SERVER_INFO = Object.freeze({
  name: 'deft-app-platform-sandbox-email-provider',
  version: '0.1.0-alpha.1',
});

const MAX_REQUEST_BYTES = 1024 * 1024;
const EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]+$/u;
const BODY_TEXT_PATTERN = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]+$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['to', 'subject', 'body_text', 'idempotency_key']),
  properties: Object.freeze({
    to: Object.freeze({ type: 'string', format: 'email', maxLength: 320 }),
    subject: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 998,
      pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060\\u2066-\\u2069\\ufeff]+$',
    }),
    body_text: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 100_000,
      pattern: '^[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060\\u2066-\\u2069\\ufeff]+$',
    }),
    idempotency_key: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
    }),
  }),
});

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['message_id', 'status']),
  properties: Object.freeze({
    message_id: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$',
    }),
    status: Object.freeze({ const: 'accepted' }),
  }),
});

const SEND_EMAIL_TOOL = Object.freeze({
  name: 'send_email',
  title: 'Send sandbox email',
  description: 'Accept one deterministic sandbox email without network egress.',
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: Object.freeze({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  }),
});

const effects = new Map();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateInput(value) {
  if (!isObject(value)) return 'input must be an object';
  const keys = Object.keys(value);
  const expected = ['body_text', 'idempotency_key', 'subject', 'to'];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    return 'input must contain exactly to, subject, body_text, and idempotency_key';
  }
  if (typeof value.to !== 'string' || value.to.length > 320 || !EMAIL_PATTERN.test(value.to)) {
    return 'to must be a valid email address of at most 320 characters';
  }
  if (
    typeof value.subject !== 'string'
    || value.subject.length < 1
    || value.subject.length > 998
    || !SUBJECT_PATTERN.test(value.subject)
  ) {
    return 'subject does not satisfy the sandbox email contract';
  }
  if (
    typeof value.body_text !== 'string'
    || value.body_text.length < 1
    || value.body_text.length > 100_000
    || !BODY_TEXT_PATTERN.test(value.body_text)
  ) {
    return 'body_text does not satisfy the sandbox email contract';
  }
  if (
    typeof value.idempotency_key !== 'string'
    || value.idempotency_key.length < 1
    || value.idempotency_key.length > 256
    || !IDEMPOTENCY_KEY_PATTERN.test(value.idempotency_key)
  ) {
    return 'idempotency_key does not satisfy the sandbox email contract';
  }
  return null;
}

function inputDigest(input) {
  return createHash('sha256')
    .update(`${input.to}\u0000${input.subject}\u0000${input.body_text}\u0000${input.idempotency_key}`)
    .digest('hex');
}

function toolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function sendEmail(input) {
  const validationError = validateInput(input);
  if (validationError) return toolError(`Invalid sandbox email input: ${validationError}`);

  const digest = inputDigest(input);
  const prior = effects.get(input.idempotency_key);
  if (prior) {
    if (prior.digest !== digest) {
      return toolError('Sandbox email idempotency key was reused with different input');
    }
    return prior.response;
  }

  const output = Object.freeze({
    message_id: `sandbox_${digest.slice(0, 24)}`,
    status: 'accepted',
  });
  const response = Object.freeze({
    content: Object.freeze([{ type: 'text', text: JSON.stringify(output) }]),
    structuredContent: output,
  });
  effects.set(input.idempotency_key, { digest, response });
  return response;
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleRequest(message) {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return error(isObject(message) && 'id' in message ? message.id : null, -32600, 'Invalid Request');
  }

  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    return null;
  }
  if (!('id' in message)) return null;

  if (message.method === 'server/discover') {
    return error(message.id, -32601, 'Method not found');
  }
  if (message.method === 'initialize') {
    const protocolVersion = isObject(message.params) && typeof message.params.protocolVersion === 'string'
      ? message.params.protocolVersion
      : null;
    if (!protocolVersion) return error(message.id, -32602, 'Invalid initialize params');
    return result(message.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: 'Proof-only sandbox provider. It performs no network egress.',
    });
  }
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'tools/list') return result(message.id, { tools: [SEND_EMAIL_TOOL] });
  if (message.method === 'tools/call') {
    if (!isObject(message.params) || message.params.name !== 'send_email') {
      return result(message.id, toolError('Unknown sandbox provider tool'));
    }
    return result(message.id, sendEmail(message.params.arguments));
  }
  return error(message.id, -32601, 'Method not found');
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
    writeMessage(error(null, -32600, 'Request exceeds the sandbox provider limit'));
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage(error(null, -32700, 'Parse error'));
    return;
  }
  const response = handleRequest(message);
  if (response) writeMessage(response);
});
