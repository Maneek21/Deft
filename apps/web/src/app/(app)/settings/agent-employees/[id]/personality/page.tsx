/**
 * Block 1.2 — agents.files.* UI.
 *
 * Per-employee personality editor. Lists the 7 canonical OpenClaw files
 * (SOUL.md, AGENTS.md, USER.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md,
 * BOOT.md), lets the user click into each, shows body in a textarea,
 * saves via PUT /api/agent-employees/:id/files/:filename.
 *
 * Kept as a dedicated page (rather than a drawer tab) so Block 1.2 ships
 * as a self-contained unit. Drawer-tab integration is a UI polish task
 * that belongs with the agent-drawer rewrite in Block 2.
 */
'use client';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Loader2, Save, FileText, AlertCircle } from 'lucide-react';
import { HeartbeatChecklistBuilder } from '@/components/heartbeat-checklist-builder';

type FileEntry = { filename: string; size: number | null; exists: boolean | null };

export default function PersonalityEditorPage() {
  const params = useParams();
  const router = useRouter();
  const employeeId = String(params?.id ?? '');

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [gatewayUnreachable, setGatewayUnreachable] = useState(false);

  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeContent, setActiveContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await api.fetch(`/api/agent-employees/${employeeId}/files`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFiles(data.files ?? []);
      setGatewayUnreachable(Boolean(data.gateway_unreachable || data.gateway_error));
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setListLoading(false);
    }
  }, [employeeId]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const openFile = useCallback(async (filename: string) => {
    setActiveFile(filename);
    setContentLoading(true);
    setContentError(null);
    setSaveMessage(null);
    try {
      const res = await api.fetch(`/api/agent-employees/${employeeId}/files/${encodeURIComponent(filename)}`);
      if (!res.ok) {
        if (res.status === 503) { setContentError('Gateway unreachable — cannot load file right now.'); return; }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setActiveContent(String(data.content ?? ''));
    } catch (e) {
      setContentError((e as Error).message);
    } finally {
      setContentLoading(false);
    }
  }, [employeeId]);

  const saveActive = useCallback(async () => {
    if (!activeFile) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await api.fetch(`/api/agent-employees/${employeeId}/files/${encodeURIComponent(activeFile)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: activeContent }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSaveMessage(data.note ?? 'Saved.');
      loadFiles();
    } catch (e) {
      setSaveMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [activeFile, activeContent, employeeId, loadFiles]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <button
            type="button"
            onClick={() => router.push('/settings/agent')}
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Back to agents
          </button>
          <h1 className="mt-2 text-2xl font-semibold">Personality</h1>
          <p className="text-sm text-muted-foreground">
            Edit the agent&apos;s canonical markdown files. Changes take effect on the next session.
          </p>
        </div>
      </div>

      {gatewayUnreachable && (
        <div className="mb-4 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <AlertCircle className="mt-0.5 size-4 text-amber-500" />
          <div>
            <div className="font-medium">Gateway unreachable</div>
            <div className="text-muted-foreground">
              The agent&apos;s sidecar is offline. File contents can&apos;t be fetched or saved until it reconnects.
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-12 gap-6">
        {/* File list */}
        <div className="col-span-4 rounded border border-border bg-card p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</div>
          {listLoading ? (
            <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : listError ? (
            <div className="p-2 text-sm text-destructive">{listError}</div>
          ) : (
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.filename}>
                  <button
                    type="button"
                    onClick={() => openFile(f.filename)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${activeFile === f.filename ? 'bg-accent' : ''}`}
                  >
                    <FileText className="size-3.5 shrink-0" />
                    <span className="flex-1">{f.filename}</span>
                    {f.size !== null && (
                      <span className="text-[10px] text-muted-foreground">{f.size}B</span>
                    )}
                    {f.exists === false && (
                      <span className="text-[10px] text-muted-foreground">(new)</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Editor */}
        <div className="col-span-8 rounded border border-border bg-card p-3">
          {!activeFile ? (
            <div className="flex h-full min-h-[24rem] items-center justify-center text-sm text-muted-foreground">
              Select a file to edit.
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium">{activeFile}</div>
                <button
                  type="button"
                  onClick={saveActive}
                  disabled={saving || contentLoading || gatewayUnreachable}
                  title={gatewayUnreachable ? "Sidecar offline — changes can't be saved until it reconnects" : undefined}
                  className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  Save
                </button>
              </div>
              {contentError ? (
                <div className="mb-2 text-xs text-destructive">{contentError}</div>
              ) : null}
              {contentLoading ? (
                <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> Loading file…
                </div>
              ) : activeFile === 'HEARTBEAT.md' ? (
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Each row below becomes a <code>- [ ] every Nmin: ...</code> line in HEARTBEAT.md. The raw markdown stays editable below.
                  </p>
                  <HeartbeatChecklistBuilder value={activeContent} onChange={setActiveContent} />
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground hover:underline">Raw markdown</summary>
                    <textarea
                      value={activeContent}
                      onChange={(e) => setActiveContent(e.target.value)}
                      className="mt-2 min-h-[12rem] w-full resize-y rounded border border-border bg-background p-3 font-mono text-xs"
                      spellCheck={false}
                    />
                  </details>
                </div>
              ) : (
                <textarea
                  value={activeContent}
                  onChange={(e) => setActiveContent(e.target.value)}
                  className="min-h-[32rem] w-full resize-y rounded border border-border bg-background p-3 font-mono text-xs"
                  spellCheck={false}
                />
              )}
              {saveMessage && (
                <div className={`mt-2 text-xs ${saveMessage.startsWith('Error') ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {saveMessage}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
