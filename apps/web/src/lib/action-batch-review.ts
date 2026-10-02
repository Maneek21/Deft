export type BatchItem = { key: string; label: string; run_id: string; state: string; input?: Record<string, unknown> };
export type BatchStatus = { batch: { id: string; title: string; state: 'pending_approval' | 'approved' | 'cancelled'; runtime_binding_id: string; item_count: number; review_url: string }; items: BatchItem[] };
export type BatchReview = BatchStatus & { ticket: string; digest: string; expires_at: string; app_label: string; action_label: string };
const states = new Set(['pending', 'pending_approval', 'running', 'waiting_external', 'succeeded', 'failed', 'cancelled', 'unknown_outcome', 'expired']);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid batch');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new Error('Invalid batch');
  return value;
}
export function readBatchStatus(value: unknown, id: string): BatchStatus {
  const root = record(value), batch = record(root.batch);
  if (batch.id !== id || !['pending_approval', 'approved', 'cancelled'].includes(String(batch.state))
    || !Array.isArray(root.items) || root.items.length < 1 || root.items.length > 10 || batch.item_count !== root.items.length) throw new Error('Invalid batch');
  const items = root.items.map(value => {
    const item = record(value);
    if (!states.has(String(item.state))) throw new Error('Invalid item status');
    return { key: text(item.key), label: text(item.label), run_id: text(item.run_id), state: text(item.state) };
  });
  if (new Set(items.map(item => item.key)).size !== items.length) throw new Error('Duplicate item');
  return { batch: { id, title: text(batch.title), state: batch.state as BatchStatus['batch']['state'], runtime_binding_id: text(batch.runtime_binding_id), item_count: items.length, review_url: text(batch.review_url) }, items };
}
export function readBatchReview(value: unknown, id: string): BatchReview {
  const root = record(value), status = readBatchStatus(value, id);
  const expires_at = text(root.expires_at);
  if (!Number.isFinite(Date.parse(expires_at)) || Date.parse(expires_at) <= Date.now() || status.batch.state !== 'pending_approval') throw new Error('Expired review');
  return { ...status, items: status.items.map((item, index) => ({ ...item, input: record(record((root.items as unknown[])[index]).input) })),
    ticket: text(root.ticket), digest: text(root.digest), expires_at, app_label: text(root.app_label), action_label: text(root.action_label) };
}
export function batchFieldText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null';
}
export function visibleBatchItems(review: BatchReview | null, status: BatchStatus | null, now: number): BatchItem[] {
  if (review && Date.parse(review.expires_at) > now) return review.items;
  return status?.items.map(({ key, label, run_id, state }) => ({ key, label, run_id, state })) ?? [];
}
