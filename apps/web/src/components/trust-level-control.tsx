// Org-wide (workspace) trust level control for Settings > Agent governance.
//
// What this setting actually governs today (apps/api):
//   - Defty's approved plans that are not owned by an agent employee
//     (lib/agent-plans.ts executePlan). Approved steps run under the plan
//     approval; the level decides whether a write that LATER steps depend on
//     runs straight away or needs its own approval (agent-plans.ts:582-588),
//     and what Defty's background recovery run may auto-execute when a step
//     fails (agent-plans.ts:712-719 -> agent-runner.ts:392,766).
//   - It is NOT used for chat (agent-runner.ts only auto-executes in
//     'background' mode; chat replies run in 'chat_mention' mode), and NOT for
//     agent employees, which carry their own trust level.
// Copy rule: describe what a level ALLOWS Defty to run on its own, never
// promise that everything else is blocked; the approval system has several
// independent paths and this page does not enumerate them.
// Changing the level is an owner/admin action on the server
// (PATCH /api/agent/settings), so the control is read-only for everyone else
// and never shows a value the server has not confirmed.

import { useId } from 'react';

export type TrustLevel = 'conservative' | 'standard' | 'autonomous';

// Examples follow the native tool tiers in apps/api/src/lib/agent-approval.ts
// (TOOL_APPROVAL_TIERS x shouldAutoExecute x isDestructiveAction).
export const TRUST_LEVELS: ReadonlyArray<{ value: TrustLevel; label: string; desc: string }> = [
  {
    value: 'conservative',
    label: 'Conservative',
    desc: "Defty can run low-risk task updates on its own, such as changing a task's status, assignee or due date.",
  },
  {
    value: 'standard',
    label: 'Standard',
    desc: 'Also routine changes, such as creating tasks, adding comments and setting reminders.',
  },
  {
    value: 'autonomous',
    label: 'Autonomous',
    desc: 'Also most other changes, such as posting messages and bulk task updates. Defty does not run actions classed as destructive on its own, such as archiving records or managing agent employees and connections.',
  },
];

export const TRUST_LEGEND = 'Defty trust level';

export const TRUST_SCOPE_NOTE =
  'This workspace setting applies to plans Defty runs after you approve them. Steps of a plan you approved run under that approval. This level decides whether a change that later steps depend on can run on its own or needs its own approval, and it limits what Defty may run on its own when it retries a failed step.';

export const TRUST_CHAT_NOTE =
  'Chat does not use this level. In chat, Defty proposes tasks, messages and similar changes for your approval. A few housekeeping actions happen without a prompt, such as saving a memory, drafting a plan for your review, or cancelling its own unsent app work.';

export const TRUST_EMPLOYEE_NOTE =
  'Agent employees are not affected. Each employee has its own trust level, chosen when it is connected and shown when you open it under Employees below.';

export const TRUST_CONNECTED_NOTE =
  'The examples above are built-in actions. Connected (MCP) tools use the approval setting on their own connection instead, and Autonomous does not let Defty run a call classed as destructive on its own.';

// Confirmation body for upgrading ONE agent employee to Autonomous. Kept to
// category-level exceptions on purpose: employee writes pass through several
// approval paths (employee trust in lib/mcp-tools/writes.ts and modules.ts,
// always-queued document send / plan import, App-owned review). An
// employee's own chat messages (MCP send_message / message_post) post without
// approval at every level while it is healthy (writes.ts
// employeeOwnChatMessageAutoExecutes), so Autonomous does not unlock them.
export const AUTONOMOUS_EMPLOYEE_CONFIRM: ReadonlyArray<string> = [
  "This employee's chat messages already post without approval at every trust level, except while it is marked unhealthy.",
  "Autonomous also lets most of this employee's other writes through Deft run without approval.",
  'Some requests still need approval, including actions classed as destructive (such as deleting, archiving, unlinking, or creating records in bulk), sending documents, importing workspace plans, and apps that require their own review.',
  'Most of its writes are recorded in the Action Log, with a signed receipt attached when one is recorded.',
  'Only workspace owners and admins can make this change, and Settings has no control to lower the level again afterwards.',
];

export const TRUST_READ_ONLY_NOTE ='Only workspace owners and admins can change the trust level.';

export const TRUST_LOADING_NOTE = 'Loading current trust level…';
export const TRUST_LOAD_ERROR = 'Could not load the current trust level. Reload the page to try again.';

export function isTrustLevel(value: unknown): value is TrustLevel {
  return value === 'conservative' || value === 'standard' || value === 'autonomous';
}

export function canEditTrustLevel(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function trustLevelLabel(value: TrustLevel): string {
  return TRUST_LEVELS.find((t) => t.value === value)?.label ?? value;
}

type ApiResponse = Pick<Response, 'ok' | 'status' | 'json'>;
type Patch = (path: string, body: unknown) => Promise<ApiResponse>;
type Get = (path: string) => Promise<ApiResponse>;

/**
 * - `ok`: the server confirmed the new value.
 * - `rejected`: a definite 4xx refusal; the value was not changed.
 * - `unknown`: no usable answer (network failure, timeout, 5xx, unreadable
 *   success body). The write may or may not have committed.
 */
export type TrustSaveResult =
  | { ok: true; value: TrustLevel }
  | { ok: false; outcome: 'rejected' | 'unknown'; error: string };

const UNKNOWN_SUFFIX = 'so it is not known whether the trust level changed.';

/** Persist a trust level. Never throws. */
export async function saveTrustLevel(patch: Patch, value: TrustLevel): Promise<TrustSaveResult> {
  let res: ApiResponse;
  try {
    res = await patch('/api/agent/settings', { trust_level: value });
  } catch {
    return { ok: false, outcome: 'unknown', error: `Could not reach the server, ${UNKNOWN_SUFFIX}` };
  }
  const body = (await res.json().catch(() => null)) as { trust_level?: unknown; error?: unknown } | null;
  if (res.ok) {
    if (isTrustLevel(body?.trust_level)) return { ok: true, value: body.trust_level };
    return { ok: false, outcome: 'unknown', error: `The server's reply could not be read, ${UNKNOWN_SUFFIX}` };
  }
  const detail = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`;
  if (res.status >= 400 && res.status < 500 && res.status !== 408) {
    if (res.status === 403) {
      return { ok: false, outcome: 'rejected', error: `${TRUST_READ_ONLY_NOTE} The trust level was not changed.` };
    }
    return { ok: false, outcome: 'rejected', error: `Could not save the trust level (${detail}). It was not changed.` };
  }
  return { ok: false, outcome: 'unknown', error: `The server did not confirm the save (${detail}), ${UNKNOWN_SUFFIX}` };
}

/** Read the authoritative trust level. Never throws. */
export async function loadTrustLevel(get: Get): Promise<{ ok: true; value: TrustLevel } | { ok: false }> {
  try {
    const res = await get('/api/agent/settings');
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { trust_level?: unknown } | null;
    return isTrustLevel(data?.trust_level) ? { ok: true, value: data.trust_level } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Generation guard: each begin() makes every earlier begin() obsolete, and
 * cancel() (effect cleanup / unmount) makes all of them obsolete. Used so an
 * older GET can never overwrite a newer saved or reloaded value.
 */
export function createGenerationGuard() {
  let generation = 0;
  return {
    begin(): () => boolean {
      const mine = ++generation;
      return () => mine === generation;
    },
    cancel(): void {
      generation += 1;
    },
  };
}

export type TrustViewPatch = Partial<{
  value: TrustLevel | null;
  loadError: string | null;
  saveError: string | null;
  saving: boolean;
}>;

export type TrustSaveOutcome = 'saved' | 'rejected' | 'reloaded' | 'unknown' | 'obsolete';

/**
 * Save, and when the outcome is unconfirmed, re-fetch the authoritative value
 * instead of keeping a possibly stale selection. `apply` receives view-state
 * patches; nothing is applied once `isCurrent()` turns false.
 */
export async function saveTrustLevelAndReconcile(
  deps: { patch: Patch; get: Get },
  next: TrustLevel,
  apply: (patch: TrustViewPatch) => void,
  isCurrent: () => boolean,
): Promise<TrustSaveOutcome> {
  apply({ saving: true, saveError: null });
  const result = await saveTrustLevel(deps.patch, next);
  if (!isCurrent()) return 'obsolete';
  if (result.ok) {
    apply({ value: result.value, loadError: null, saving: false });
    return 'saved';
  }
  if (result.outcome === 'rejected') {
    apply({ saving: false, saveError: result.error });
    return 'rejected';
  }
  // Unconfirmed: stop showing the old selection and ask the server.
  apply({ value: null, loadError: null, saving: false, saveError: `${result.error} Checking the current value…` });
  const reloaded = await loadTrustLevel(deps.get);
  if (!isCurrent()) return 'obsolete';
  if (reloaded.ok) {
    apply({
      value: reloaded.value,
      saveError: `${result.error} Reloaded from the server: the trust level is now ${trustLevelLabel(reloaded.value)}.`,
    });
    return 'reloaded';
  }
  apply({
    value: null,
    saveError: null,
    loadError: `${result.error} The current value could not be reloaded either. Reload the page to see it.`,
  });
  return 'unknown';
}

export function TrustLevelControl({
  value,
  loadError,
  canEdit,
  saving,
  error,
  onSelect,
}: {
  /** Server-confirmed level, or null while unknown (loading, failed load, unconfirmed save). */
  value: TrustLevel | null;
  loadError?: string | null;
  canEdit: boolean;
  saving: boolean;
  error?: string | null;
  onSelect: (value: TrustLevel) => void;
}) {
  const baseId = useId();
  const name = `${baseId}-trust-level`;
  const scopeId = `${baseId}-scope`;
  const readOnlyId = `${baseId}-read-only`;
  const stateId = `${baseId}-state`;
  // Read-only and unknown states disable the radios. While a save is in
  // flight they stay focusable (so keyboard focus is not dropped) and further
  // changes are ignored; aria-busy announces the pending state.
  const disabled = !canEdit || value === null;
  const describedBy = [scopeId, !canEdit ? readOnlyId : null, value === null ? stateId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <fieldset
      className="m-0 min-w-0 border-0 p-0"
      data-testid="trust-level-control"
      aria-describedby={describedBy}
      aria-busy={saving || undefined}
    >
      <legend className="sr-only">{TRUST_LEGEND}</legend>
      <div id={scopeId} className="mb-3 max-w-[640px] space-y-1.5 text-[12px] text-[var(--muted)]" data-testid="trust-scope-note">
        <p>{TRUST_SCOPE_NOTE}</p>
        <p>{TRUST_EMPLOYEE_NOTE}</p>
        <p>{TRUST_CHAT_NOTE}</p>
      </div>
      {!canEdit && (
        <p id={readOnlyId} className="mb-3 text-[12px] text-[var(--foreground-secondary)]" data-testid="trust-read-only-note">
          {TRUST_READ_ONLY_NOTE}
        </p>
      )}
      {value === null && (
        <p
          id={stateId}
          className={`mb-3 text-[12px] ${loadError ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`}
          role={loadError ? 'alert' : 'status'}
          data-testid="trust-level-state"
        >
          {loadError ?? TRUST_LOADING_NOTE}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {TRUST_LEVELS.map((t) => {
          const selected = value === t.value;
          const descId = `${baseId}-${t.value}-desc`;
          return (
            <label
              key={t.value}
              className={`flex gap-3 rounded-lg border p-4 text-left ${
                selected
                  ? 'border-[var(--primary-container)] bg-[var(--bg-active)]'
                  : 'border-transparent bg-[var(--surface-container)]'
              } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${disabled && !selected ? 'opacity-60' : ''}`}
            >
              <input
                type="radio"
                name={name}
                value={t.value}
                checked={selected}
                disabled={disabled}
                aria-describedby={descId}
                data-testid={`trust-level-${t.value}`}
                onChange={() => {
                  if (!disabled && !saving && !selected) onSelect(t.value);
                }}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary-container)] disabled:cursor-not-allowed"
              />
              <span>
                <span className="block text-[13px] font-medium text-[var(--on-surface)]">{t.label}</span>
                <span id={descId} className="mt-1 block text-[11px] text-[var(--outline)]">
                  {t.desc}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-2 max-w-[640px] text-[11px] text-[var(--outline)]" data-testid="trust-connected-note">
        {TRUST_CONNECTED_NOTE}
      </p>
      <p className="mt-2 text-[11px] text-[var(--outline)]" role="status" aria-live="polite">
        {saving ? 'Saving…' : ''}
      </p>
      {error && (
        <p className="mt-2 text-[12px] text-[var(--danger)]" role="alert" data-testid="trust-level-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
