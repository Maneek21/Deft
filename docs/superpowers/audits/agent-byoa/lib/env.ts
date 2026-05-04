// docs/superpowers/audits/agent-byoa/lib/env.ts
import 'dotenv/config';

export interface ByoaEnv {
  apiUrl: string;
  webUrl: string;
  databaseUrl: string;
  testEmail: string;
  testPassword: string;
  agentId: string;
  agentSlug: string;
  agentToken: string;
  // Layer B only — undefined in Layer A
  anthropicKey?: string;
  layerBLive: boolean;
  layerBModel: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadEnv(opts: { requireLayerB?: boolean } = {}): ByoaEnv {
  const env: ByoaEnv = {
    apiUrl: process.env.DEFT_API_URL || 'http://localhost:3001',
    webUrl: process.env.DEFT_WEB_URL || 'http://localhost:3000',
    databaseUrl: req('DATABASE_URL'),
    testEmail: req('DEFT_TEST_EMAIL'),
    testPassword: req('DEFT_TEST_PASSWORD'),
    agentId: req('DEFT_TEST_AGENT_ID'),
    agentSlug: req('DEFT_TEST_AGENT_SLUG'),
    agentToken: req('DEFT_TEST_AGENT_TOKEN'),
    layerBLive: process.env.DEFT_TEST_AGENT_LIVE === '1',
    layerBModel: process.env.DEFT_TEST_LAYER_B_MODEL || 'claude-sonnet-4-6',
  };
  if (opts.requireLayerB) {
    env.anthropicKey = req('ANTHROPIC_API_KEY');
    if (!env.layerBLive) {
      throw new Error('DEFT_TEST_AGENT_LIVE=1 required to run Layer B');
    }
  }
  return env;
}
