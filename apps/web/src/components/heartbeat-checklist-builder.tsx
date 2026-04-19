/**
 * Block 2.9 — structured heartbeat checklist builder.
 *
 * Replaces the raw-markdown textarea that forced operators to remember
 * the heartbeat syntax. Users add/remove rows of
 * `{ interval_min, instruction }`; the component serializes to a markdown
 * checklist (one `- [ ] every {N}min: {instruction}` per row) that the
 * heartbeat worker's existing parser understands.
 *
 * Controlled component:
 *   <HeartbeatChecklistBuilder
 *     value={markdown}
 *     onChange={(nextMd) => ...}
 *   />
 *
 * Internal state is the parsed row list; markdown round-trips via
 * `parseHeartbeatMarkdown` / `serializeHeartbeatMarkdown` so users can
 * still edit the textarea elsewhere without losing data.
 */
'use client';
import { useMemo, useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';

export type ChecklistRow = {
  interval_min: number;
  instruction: string;
};

const ROW_REGEX = /^-\s*\[\s*\]\s*every\s+(\d+)\s*min:\s*(.+)$/i;

export function parseHeartbeatMarkdown(md: string): ChecklistRow[] {
  if (!md) return [];
  const rows: ChecklistRow[] = [];
  for (const line of md.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(ROW_REGEX);
    if (match) {
      const interval = Number.parseInt(match[1] ?? '0', 10);
      const instruction = (match[2] ?? '').trim();
      if (interval > 0 && instruction) rows.push({ interval_min: interval, instruction });
    }
  }
  return rows;
}

export function serializeHeartbeatMarkdown(rows: ChecklistRow[]): string {
  return rows
    .filter((r) => r.instruction.trim() && r.interval_min > 0)
    .map((r) => `- [ ] every ${r.interval_min}min: ${r.instruction.trim()}`)
    .join('\n');
}

type Props = {
  value: string;
  onChange: (nextMarkdown: string) => void;
  disabled?: boolean;
};

export function HeartbeatChecklistBuilder({ value, onChange, disabled }: Props) {
  const [rows, setRows] = useState<ChecklistRow[]>(() => parseHeartbeatMarkdown(value));

  // When the upstream value changes (e.g. loaded fresh from the API),
  // re-parse so the builder stays in sync. We only re-parse when the
  // upstream markdown changes — editing within the builder itself
  // drives onChange, which doesn't need to round-trip through this.
  useEffect(() => {
    const parsed = parseHeartbeatMarkdown(value);
    const currentSerialized = serializeHeartbeatMarkdown(rows);
    if (currentSerialized.trim() !== value.trim()) {
      setRows(parsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (next: ChecklistRow[]) => {
    setRows(next);
    onChange(serializeHeartbeatMarkdown(next));
  };

  const addRow = () => update([...rows, { interval_min: 60, instruction: '' }]);
  const removeRow = (idx: number) => update(rows.filter((_, i) => i !== idx));
  const updateRow = (idx: number, patch: Partial<ChecklistRow>) => {
    update(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && (
        <div className="rounded border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          No heartbeat checks yet. Click &quot;Add check&quot; to define the first one.
        </div>
      )}
      {rows.map((row, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">every</span>
          <input
            type="number"
            min={1}
            step={1}
            value={row.interval_min}
            disabled={disabled}
            onChange={(e) => updateRow(idx, { interval_min: Math.max(1, Number.parseInt(e.target.value, 10) || 0) })}
            className="w-16 rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <span className="text-xs text-muted-foreground">min:</span>
          <input
            type="text"
            value={row.instruction}
            disabled={disabled}
            onChange={(e) => updateRow(idx, { instruction: e.target.value })}
            placeholder="Check unread mentions for @me and summarize"
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={() => removeRow(idx)}
            disabled={disabled}
            aria-label="Remove check"
            className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add check
        </button>
      </div>
    </div>
  );
}
