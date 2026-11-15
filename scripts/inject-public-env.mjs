import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_ENV_PLACEHOLDERS = {
  __DEFT_APP_URL__: 'NEXT_PUBLIC_APP_URL',
  __DEFT_API_URL__: 'NEXT_PUBLIC_API_URL',
  __DEFT_WS_URL__: 'NEXT_PUBLIC_WS_URL',
};

// The web Content-Security-Policy (apps/web/next.config.ts) lets the page
// connect only to the API and live-connection addresses. It names their
// origins, not full URLs, plus each origin's WebSocket form.
export const PUBLIC_ENV_ORIGIN_PLACEHOLDERS = {
  __DEFT_API_ORIGIN__: { key: 'NEXT_PUBLIC_API_URL', ws: false },
  __DEFT_API_WS_ORIGIN__: { key: 'NEXT_PUBLIC_API_URL', ws: true },
  __DEFT_WS_ORIGIN__: { key: 'NEXT_PUBLIC_WS_URL', ws: false },
  __DEFT_WS_WS_ORIGIN__: { key: 'NEXT_PUBLIC_WS_URL', ws: true },
};

function publicOrigin(key, value, ws) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute http(s) or ws(s) URL`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`${key} must be an absolute http(s) or ws(s) URL`);
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return ws ? `${secure ? 'wss' : 'ws'}://${url.host}` : `${secure ? 'https' : 'http'}://${url.host}`;
}

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.json', '.map', '.txt']);

export async function injectPublicEnv(root, env = process.env) {
  const replacements = Object.entries(PUBLIC_ENV_PLACEHOLDERS).map(([placeholder, key]) => {
    const value = env[key];
    if (!value) throw new Error(`${key} is required when using the prebuilt Deft image`);
    return [placeholder, value.replace(/\/$/, '')];
  });
  for (const [placeholder, { key, ws }] of Object.entries(PUBLIC_ENV_ORIGIN_PLACEHOLDERS)) {
    replacements.push([placeholder, publicOrigin(key, env[key], ws)]);
  }

  let filesChanged = 0;
  let replacementsMade = 0;

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!TEXT_EXTENSIONS.has(extname(entry.name))) continue;

      const original = await readFile(path, 'utf8');
      let next = original;
      for (const [placeholder, value] of replacements) {
        const occurrences = next.split(placeholder).length - 1;
        if (!occurrences) continue;
        replacementsMade += occurrences;
        next = next.replaceAll(placeholder, value);
      }
      if (next !== original) {
        await writeFile(path, next);
        filesChanged += 1;
      }
    }
  }

  await visit(root);
  return { filesChanged, replacementsMade };
}

async function main() {
  const root = process.argv[2] || '/app/apps/web/.next';
  const result = await injectPublicEnv(root);
  console.log(`[public-env] injected ${result.replacementsMade} values across ${result.filesChanged} files`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[public-env] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
