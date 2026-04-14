/**
 * Phase 9 — Tiny Handlebars-compatible renderer for USER.md templates.
 *
 * Supports exactly the two constructs Phase 9 templates use:
 *   - `{{var}}` single-variable substitution
 *   - `{{#each arr}}...{{/each}}` single-level iteration with
 *     `{{name}}`/`{{role}}`/etc. inside the block
 *
 * Intentionally NOT a general Handlebars engine — we don't install the
 * handlebars package for v1. A later phase can swap this for the real
 * thing when we need conditionals, nested blocks, or helpers.
 *
 * The deploy-provision worker currently passes the raw template string
 * through to OpenClaw without rendering. This helper is available to any
 * caller who wants to materialise the template with real values.
 */
export type UserMdContext = {
  org_name: string;
  trust_level: string;
  teammates: Array<{ name: string; role: string; email: string }>;
};

export function renderUserMd(template: string, ctx: UserMdContext): string {
  // First pass — {{#each teammates}}...{{/each}} blocks.
  let out = template.replace(
    /\{\{#each teammates\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, block: string) => {
      return ctx.teammates
        .map((t) =>
          block
            .replace(/\{\{name\}\}/g, t.name)
            .replace(/\{\{role\}\}/g, t.role)
            .replace(/\{\{email\}\}/g, t.email),
        )
        .join('');
    },
  );
  // Second pass — top-level scalars.
  out = out.replace(/\{\{org_name\}\}/g, ctx.org_name);
  out = out.replace(/\{\{trust_level\}\}/g, ctx.trust_level);
  return out;
}
