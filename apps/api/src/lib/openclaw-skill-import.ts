/**
 * Phase 4 Task 4.13 — OpenClaw marketplace skill importer.
 *
 * Given a URL pointing at an OpenClaw-format skill markdown file (e.g.
 * https://clawhub.ai/skills/content-creator), fetch the raw markdown and
 * parse it into the shape we persist in the `skills` table. The markdown
 * is expected to carry YAML frontmatter with at minimum a `name` and
 * `description`; the body below the frontmatter becomes the skill's
 * `system_prompt` / `agent_config.system_prompt_addition`.
 *
 * Frontmatter keys we honour (all optional except `name`):
 *   name               → skill.name (required)
 *   slug               → skill.slug (fallback: kebab-case of name)
 *   description        → skill.description
 *   icon               → skill.icon
 *   version            → skill.version (default 1.0.0)
 *   capability_packs   → agent_config.capability_packs (string[] or csv)
 *   tools              → agent_config.tools (string[] or csv)
 *   triggers           → agent_config.triggers (string[] or csv)
 *   trust_level        → agent_config.trust_level_override
 *   model              → agent_config.model_recommendation
 *
 * Parsing is deliberately tolerant: we accept plain scalars, `- list` style
 * yaml lists, and inline `[a, b, c]` / `a, b, c` comma lists so a generic
 * OpenClaw skill file parses without js-yaml as a dependency.
 */
import type { SkillAgentConfig } from './skill-config.js';

export type OpenclawSkillImport = {
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  version: string;
  system_prompt: string;
  agent_config: SkillAgentConfig;
  source_url: string;
};

export class OpenclawImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenclawImportError';
  }
}

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Parse a scalar/list value from a frontmatter line. Accepts:
 *   - "foo"         → "foo"
 *   - foo, bar      → ["foo", "bar"]
 *   - [foo, bar]    → ["foo", "bar"]
 *   - (multiline block with "- foo\n  - bar") is handled by parseFrontmatter.
 */
function parseValue(raw: string): string | string[] {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Quoted string — strip the quotes.
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Inline list [a, b, c]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  // Comma list fallback — only treat as list if a comma is present.
  if (trimmed.includes(',')) {
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }

  return trimmed;
}

/**
 * Minimal frontmatter parser. Splits the doc on the first `---\n...\n---`
 * fence, then parses `key: value` pairs with support for multiline
 * `- item` lists following a bare `key:` line.
 */
export function parseFrontmatter(markdown: string): {
  fm: Record<string, string | string[]>;
  body: string;
} {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    // No frontmatter fence → everything is body.
    return { fm: {}, body: markdown };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { fm: {}, body: markdown };
  }

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join('\n').replace(/^\s+/, '');

  const fm: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;
  let currentList: string[] = [];

  const flushList = () => {
    if (currentListKey) {
      fm[currentListKey] = currentList;
      currentListKey = null;
      currentList = [];
    }
  };

  for (const raw of fmLines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim()) continue;

    // Multiline list item under a bare key.
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (currentListKey && listMatch) {
      currentList.push(listMatch[1]!.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_\-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      // Garbage / comment line — ignore.
      continue;
    }

    flushList();
    const key = kvMatch[1]!;
    const value = kvMatch[2]!;

    if (value.trim() === '') {
      // Start of a bare key — may begin a multiline list.
      currentListKey = key;
      currentList = [];
      continue;
    }

    fm[key] = parseValue(value);
  }

  flushList();

  return { fm, body };
}

/** Narrow helper: coerce a parsed fm value to a string[] if possible. */
function asList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.length > 0) return [v];
  return undefined;
}

/** Turn a parsed markdown file into a SkillCreateInput-shaped payload. */
export function parseOpenclawMarkdown(
  markdown: string,
  sourceUrl: string,
): OpenclawSkillImport {
  const { fm, body } = parseFrontmatter(markdown);

  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name) {
    throw new OpenclawImportError(
      'Failed to parse OpenClaw skill markdown: missing "name" in frontmatter',
    );
  }

  const slug =
    (typeof fm.slug === 'string' && fm.slug.trim()) || toSlug(name);

  const description =
    typeof fm.description === 'string' && fm.description.trim()
      ? fm.description.trim()
      : null;

  const icon =
    typeof fm.icon === 'string' && fm.icon.trim() ? fm.icon.trim() : null;

  const version =
    typeof fm.version === 'string' && fm.version.trim()
      ? fm.version.trim()
      : '1.0.0';

  const systemPrompt = body.trim();

  const agentConfig: SkillAgentConfig = {};
  const packs = asList(fm.capability_packs);
  if (packs && packs.length > 0) agentConfig.capability_packs = packs;
  const tools = asList(fm.tools);
  if (tools && tools.length > 0) agentConfig.tools = tools;
  const triggers = asList(fm.triggers);
  if (triggers && triggers.length > 0) agentConfig.triggers = triggers;
  if (systemPrompt) agentConfig.system_prompt_addition = systemPrompt;

  if (typeof fm.trust_level === 'string') {
    const tl = fm.trust_level.trim();
    if (tl === 'conservative' || tl === 'standard' || tl === 'autonomous') {
      agentConfig.trust_level_override = tl;
    }
  }
  if (typeof fm.model === 'string' && fm.model.trim()) {
    agentConfig.model_recommendation = fm.model.trim();
  }

  return {
    name,
    slug,
    description,
    icon,
    version,
    system_prompt: systemPrompt,
    agent_config: agentConfig,
    source_url: sourceUrl,
  };
}

/**
 * Fetch the URL and parse it. Network + parse errors are surfaced as
 * `OpenclawImportError` so the route handler can propagate a user-facing
 * message without leaking raw fetch internals.
 */
export async function importOpenclawSkill(
  sourceUrl: string,
): Promise<OpenclawSkillImport> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new OpenclawImportError(
      'Failed to parse OpenClaw skill markdown: invalid URL',
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OpenclawImportError(
      'Failed to parse OpenClaw skill markdown: only http(s) URLs are supported',
    );
  }

  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      headers: { Accept: 'text/markdown, text/plain, */*' },
      redirect: 'follow',
    });
  } catch (err) {
    throw new OpenclawImportError(
      `Failed to fetch OpenClaw skill markdown: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    throw new OpenclawImportError(
      `Failed to fetch OpenClaw skill markdown: HTTP ${response.status}`,
    );
  }

  const text = await response.text();
  if (!text || text.length < 4) {
    throw new OpenclawImportError(
      'Failed to parse OpenClaw skill markdown: empty response body',
    );
  }

  return parseOpenclawMarkdown(text, sourceUrl);
}
