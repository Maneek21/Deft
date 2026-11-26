'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { AppDialog } from '../overlay-primitives';

export function NewDriveDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (driveId: string) => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'open' | 'private'>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/drives', { name: name.trim(), kind });
      const body = await res.json().catch(() => ({})) as { drive?: { id: string }; error?: string };
      if (!res.ok || !body.drive) {
        setError(body.error ?? 'Could not create the drive');
        return;
      }
      onCreated?.(body.drive.id);
      onClose();
      router.push(`/drive/${body.drive.id}`);
    } catch {
      setError('Could not create the drive');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog onClose={onClose} title="New drive" description="A drive holds documents and folders for a team or a topic.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="text-[0.8125rem] font-medium" style={{ color: 'var(--on-surface)' }}>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoFocus
            className="mt-1 w-full rounded-lg px-3 py-2 text-[0.875rem]"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--on-surface)' }}
          />
        </label>
        <fieldset className="flex flex-col gap-1 text-[0.8125rem]" style={{ color: 'var(--on-surface)' }}>
          <legend className="font-medium mb-1">Who can open it</legend>
          <label className="flex items-center gap-2">
            <input type="radio" checked={kind === 'private'} onChange={() => setKind('private')} />
            Only people you add
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={kind === 'open'} onChange={() => setKind('open')} />
            Everyone in the workspace
          </label>
        </fieldset>
        {error && <p role="alert" className="text-[0.8125rem]" style={{ color: 'var(--error, #b3261e)' }}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="px-3 py-1.5 rounded-lg text-[0.8125rem] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--primary-container)' }}
          >
            {busy ? 'Creating...' : 'Create drive'}
          </button>
        </div>
      </form>
    </AppDialog>
  );
}
