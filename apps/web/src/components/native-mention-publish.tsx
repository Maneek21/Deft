'use client';
import { useState } from 'react';
import { type NativeMentionSource } from '@deft/shared';
import { useNativeMentionsCapability, publishSavedNativeMentions } from '@/lib/native-mentions';
export function NativeMentionPublish({ source, content, prepare }: {
  source: NativeMentionSource; content: string; prepare?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ key: '', message: '' });
  const enabled = useNativeMentionsCapability();
  const key = source.kind + ':' + source.id + ':' + content;
  if (!enabled) return null;
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
    <button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={async () => {
      setBusy(true); setStatus({ key, message: '' });
      try {
        await prepare?.();
        const result = await publishSavedNativeMentions(source, content);
        setStatus({ key, message: result.blocked_count ? `${result.queued_count} queued · ${result.blocked_count} cannot access this source. Share it, then retry.`
          : result.queued_count ? `${result.queued_count} notification(s) queued` : 'Mentions are up to date' });
      } catch (error) { setStatus({ key, message: error instanceof Error ? error.message : 'Save and retry' }); }
      finally { setBusy(false); }
    }}>{busy ? 'Publishing…' : 'Notify mentions'}</button>
    <span role="status">{status.key === key ? status.message : ''}</span>
  </div>;
}
