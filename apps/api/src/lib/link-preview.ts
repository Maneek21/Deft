import { Worker } from 'node:worker_threads';
import { fetchPublicHttpText } from './public-http-fetch.js';

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
  siteName: string | null;
};

const LINK_PREVIEW_MAX_BYTES = 512 * 1024;
const EXTRACTION_TIME_LIMIT_MS = 2000;
const EXTRACTION_MAX_WAITING = 16;

/** Reference extraction, kept for tests: production runs EXTRACTOR_SOURCE in a worker. */
export function extractLinkMetadataReference(html: string, url: string): LinkPreview | null {
  try {
    const getOg = (property: string): string | null => {
      const match = html.match(new RegExp(`<meta[^>]*property=["']og:${property}["'][^>]*content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${property}["']`, 'i'));
      return match?.[1] || null;
    };
    const getMeta = (name: string): string | null => {
      const match = html.match(new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'));
      return match?.[1] || null;
    };
    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || null;
    const faviconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
    let favicon = faviconMatch?.[1] || null;
    if (favicon && !favicon.startsWith('http')) {
      const baseUrl = new URL(url);
      favicon = new URL(favicon, baseUrl.origin).href;
    }
    const title = getOg('title') || titleTag;
    const description = getOg('description') || getMeta('description');
    const image = getOg('image');
    const siteName = getOg('site_name');
    if (!title && !description) return null;
    return { url, title, description, image, favicon, siteName };
  } catch {
    return null;
  }
}

/**
 * The same extraction as plain JavaScript source, evaluated inside a worker thread.
 * Kept as a string so every loader (dev runner, test runner, compiled build) ships it unchanged.
 */
export const EXTRACTOR_SOURCE = `
function extract(html, url) {
  try {
    const getOg = (property) => {
      const match = html.match(new RegExp(\`<meta[^>]*property=["']og:\${property}["'][^>]*content=["']([^"']*)["']\`, 'i'))
        || html.match(new RegExp(\`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:\${property}["']\`, 'i'));
      return match?.[1] || null;
    };
    const getMeta = (name) => {
      const match = html.match(new RegExp(\`<meta[^>]*name=["']\${name}["'][^>]*content=["']([^"']*)["']\`, 'i'))
        || html.match(new RegExp(\`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']\${name}["']\`, 'i'));
      return match?.[1] || null;
    };
    const titleTag = html.match(/<title[^>]*>([^<]*)<\\/title>/i)?.[1] || null;
    const faviconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
    let favicon = faviconMatch?.[1] || null;
    if (favicon && !favicon.startsWith('http')) {
      const baseUrl = new URL(url);
      favicon = new URL(favicon, baseUrl.origin).href;
    }
    const title = getOg('title') || titleTag;
    const description = getOg('description') || getMeta('description');
    const image = getOg('image');
    const siteName = getOg('site_name');
    if (!title && !description) return null;
    return { url, title, description, image, favicon, siteName };
  } catch {
    return null;
  }
}
`;

const WORKER_SOURCE = `${EXTRACTOR_SOURCE}
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage(extract(workerData.html, workerData.url));
`;

/** Admitted extractions and live extraction threads; read by tests. */
export const linkPreviewExtractionStats = { pending: 0, liveWorkers: 0, maxLiveWorkers: 0 };

let extractionChain: Promise<void> = Promise.resolve();

/** Resolves with the result as soon as it is known; the returned `exited` settles once the thread is gone. */
function runExtractionWorker(
  html: string,
  url: string,
  resolve: (value: LinkPreview | null) => void,
): Promise<void> {
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: { html, url },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
  } catch {
    resolve(null);
    return Promise.resolve();
  }
  const stats = linkPreviewExtractionStats;
  stats.liveWorkers += 1;
  stats.maxLiveWorkers = Math.max(stats.maxLiveWorkers, stats.liveWorkers);
  const startedAt = performance.now();
  let settled = false;
  const finish = (value: LinkPreview | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    worker.terminate().catch(() => undefined);
    resolve(value);
  };
  const timer = setTimeout(() => finish(null), EXTRACTION_TIME_LIMIT_MS);
  worker.on('error', () => finish(null));
  worker.once('message', (value: LinkPreview | null) => {
    finish(performance.now() - startedAt <= EXTRACTION_TIME_LIMIT_MS ? value ?? null : null);
  });
  return new Promise((exited) => {
    worker.once('exit', () => {
      stats.liveWorkers -= 1;
      finish(null);
      exited();
    });
  });
}

/**
 * Extracts preview metadata on a worker thread, one page at a time, with a time limit.
 * A page whose result is not received within the limit, or that arrives while the waiting list
 * is full, gets no preview. The next page starts only after the previous thread has exited.
 */
export function extractLinkMetadata(html: string, url: string): Promise<LinkPreview | null> {
  const stats = linkPreviewExtractionStats;
  if (stats.pending > EXTRACTION_MAX_WAITING) return Promise.resolve(null);
  stats.pending += 1;
  return new Promise((resolve) => {
    extractionChain = extractionChain
      .then(() => runExtractionWorker(html, url, resolve))
      .catch(() => resolve(null))
      .finally(() => { stats.pending -= 1; });
  });
}

export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  try {
    const res = await fetchPublicHttpText(url, {
      maxBytes: LINK_PREVIEW_MAX_BYTES,
      timeoutMs: 5000,
      accept: 'text/html',
      userAgent: 'DeftBot/1.0 (link preview)',
    });
    if (!res.contentType.includes('text/html')) return null;
    return await extractLinkMetadata(res.text, url);
  } catch {
    return null;
  }
}

export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>)"'\]]+/g;
  return [...new Set(text.match(urlRegex) || [])];
}
