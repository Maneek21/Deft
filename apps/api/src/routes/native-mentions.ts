import { Hono } from 'hono';
import { z } from 'zod';
import { NativeMentionRefSchema, NativeMentionRefsSchema, NativeMentionSourceSchema } from '@deft/shared';
import {
  nativeMentionsEnabled, searchNativeMentions, resolveNativeMentions, nativeMentionBacklinks,
  publishNativeMentions, loadNativeSource, nativeContentHash, NativeMentionError,
} from '../lib/native-mentions.js';

export const nativeMentionRoutes = new Hono();
nativeMentionRoutes.get('/capabilities', c => c.json({ enabled: nativeMentionsEnabled() }));
nativeMentionRoutes.get('/search', async c => {
  const query = z.string().max(120).safeParse(c.req.query('q') ?? '');
  if (!query.success) return c.json({ error: 'Invalid search query', code: 'VALIDATION_ERROR' }, 400);
  if (!nativeMentionsEnabled()) return c.json({ items: [] });
  const user = c.get('user');
  return c.json({ items: await searchNativeMentions({ orgId: user.org_id, userId: user.id }, query.data) });
});
nativeMentionRoutes.post('/resolve', async c => {
  const parsed = z.strictObject({ refs: NativeMentionRefsSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid references', code: 'VALIDATION_ERROR' }, 400);
  const user = c.get('user');
  return c.json({ items: await resolveNativeMentions({ orgId: user.org_id, userId: user.id }, parsed.data.refs) });
});
nativeMentionRoutes.post('/backlinks', async c => {
  const parsed = z.strictObject({ ref: NativeMentionRefSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid reference', code: 'VALIDATION_ERROR' }, 400);
  const user = c.get('user');
  try { return c.json(await nativeMentionBacklinks({ orgId: user.org_id, userId: user.id }, parsed.data.ref)); }
  catch (error) { if (error instanceof NativeMentionError) return c.json({ error: error.message, code: error.code }, error.status); throw error; }
});
nativeMentionRoutes.post('/source', async c => {
  const parsed = NativeMentionSourceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid source', code: 'VALIDATION_ERROR' }, 400);
  const user = c.get('user');
  const source = await loadNativeSource({ orgId: user.org_id, userId: user.id }, parsed.data);
  if (!source) return c.json({ error: 'Source not found', code: 'NOT_FOUND' }, 404);
  return c.json({ source: parsed.data, content_hash: nativeContentHash(source.content) });
});
nativeMentionRoutes.post('/publish', async c => {
  const parsed = z.strictObject({
    source: NativeMentionSourceSchema, content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid publication', code: 'VALIDATION_ERROR' }, 400);
  const user = c.get('user');
  try { return c.json(await publishNativeMentions(
    { orgId: user.org_id, userId: user.id }, parsed.data.source, parsed.data.content_hash,
  )); }
  catch (error) { if (error instanceof NativeMentionError) return c.json({ error: error.message, code: error.code }, error.status); throw error; }
});
