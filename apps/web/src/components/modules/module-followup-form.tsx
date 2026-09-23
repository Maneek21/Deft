'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AppDialog } from '@/components/overlay-primitives';
import { useModuleMembers } from '@/hooks/use-modules';
import { api } from '@/lib/api';
import { createNativeCreateIntent } from '@/lib/native-create-intent';
import { moduleApiError } from '@/lib/modules';
import { moduleTaskCalendarDay } from '@/lib/module-task-links';

export function ModuleFollowUpForm({ resourceId, title: recordTitle, onClose, onLinked }: {
  resourceId: string; title: string; onClose: () => void; onLinked: () => Promise<void>;
}) {
  const [title, setTitle] = useState(`Follow up with ${recordTitle}`);
  const [projectId, setProjectId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = useModuleMembers();
  const intent = useRef(createNativeCreateIntent(`module-follow-up:${resourceId}`));
  const taskRef = useRef<string | null>(null);
  const requestKey = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError(null);
    void api.get('/api/projects').then(async (response) => {
      if (!response.ok) throw new Error('Unable to load projects.');
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error('Unable to load projects.');
      const rows = body.filter((row): row is { id: string; name: string } => Boolean(row && typeof row === 'object' && typeof row.id === 'string' && typeof row.name === 'string'));
      if (live) {
        setProjects(rows);
        if (rows.length === 1) setProjectId((current) => current || rows[0]!.id);
      }
    }).catch(() => { if (live) setLoadError('Unable to load projects.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [attempt]);

  const close = () => {
    if (busy) return;
    // A known task remains accessible in Tasks; unknown create outcomes retain
    // the native session intent so resubmitting the same draft can reconcile it.
    if (taskRef.current && requestKey.current) intent.current.acknowledgeSuccess(requestKey.current);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!taskRef.current) {
        const body = { project_id: projectId, title: title.trim(), ...(assigneeId ? { assignee_id: assigneeId } : {}), ...(dueDate ? { due_date: dueDate } : {}) };
        requestKey.current = await intent.current.keyFor(body);
        const response = await api.post('/api/tasks', body, { headers: { 'Idempotency-Key': requestKey.current } });
        if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to create follow-up.'));
        const task: unknown = await response.json();
        if (!task || typeof task !== 'object' || !('id' in task) || typeof task.id !== 'string') throw new Error('The task response was incomplete. Retry with the same details to recover it.');
        taskRef.current = task.id;
        setTaskId(task.id);
      }
      const response = await api.post(`/api/tasks/${encodeURIComponent(taskRef.current)}/module-records`, { resource_id: resourceId });
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to link follow-up.'));
      if (requestKey.current) intent.current.acknowledgeSuccess(requestKey.current);
      await onLinked();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save follow-up.');
    } finally { setBusy(false); }
  };

  const fieldStyle = { background: 'var(--surface-container-high)', color: 'var(--on-surface)', borderColor: 'var(--ghost-border)' };
  return <AppDialog open title="New follow-up" description={`Create a native task linked to ${recordTitle}.`} onClose={close} width={520} footer={<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    <button type="button" disabled={busy} onClick={close} className="min-h-10 rounded-full px-4 text-sm">{taskId ? 'Close' : 'Cancel'}</button>
    <button type="submit" form="module-followup-form" disabled={busy || (!taskId && (loading || Boolean(loadError) || !projectId || !title.trim()))} className="min-h-10 rounded-full px-4 text-sm font-medium text-white disabled:opacity-50" style={{ background: 'var(--primary-container)' }}>{busy ? 'Saving…' : taskId ? 'Retry linking' : 'Create follow-up'}</button>
  </div>}>
    <form id="module-followup-form" onSubmit={(event) => void submit(event)} className="space-y-4">
      {taskId && <div role="status" className="rounded-lg p-3 text-sm" style={fieldStyle}>Task created. Linking to this record is still pending. <Link href={`/tasks?task=${encodeURIComponent(taskId)}`} className="underline">Open task</Link>. You can also attach this record from its References tab.</div>}
      {error && <p role="alert" className="rounded-lg p-3 text-sm" style={{ background: 'var(--danger-subtle)' }}>{error}</p>}
      {loadError && <div role="alert" className="text-sm">{loadError} <button type="button" onClick={() => setAttempt((value) => value + 1)} className="min-h-11 underline">Try again</button></div>}
      {!loading && !loadError && projects.length === 0 && <p className="text-sm">Create a project in Tasks before adding a follow-up.</p>}
      <fieldset disabled={busy || Boolean(taskId)} className="space-y-4 disabled:opacity-60">
        <label className="block text-sm">Task title<input required value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border px-3" style={fieldStyle} /></label>
        <label className="block text-sm">Project<select aria-label="Project" required value={projectId} onChange={(event) => setProjectId(event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border px-3" style={fieldStyle}><option value="">{loading ? 'Loading projects…' : 'Choose project'}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="block text-sm">Assignee<select aria-label="Assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border px-3" style={fieldStyle}><option value="">Unassigned</option>{members.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        {members.error && <p role="alert" className="text-xs">Unable to load assignees. <button type="button" className="min-h-11 underline" onClick={() => void members.mutate()}>Try again</button></p>}
        <div>
          <label className="block text-sm">Due date<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border px-3" style={fieldStyle} /></label>
          <div className="mt-2 flex flex-wrap gap-2" aria-label="Choose a follow-up date">
            {([['Today', 0], ['Tomorrow', 1], ['In a week', 7]] as const).map(([label, days]) => <button key={label} type="button" onClick={() => { const date = new Date(); date.setDate(date.getDate() + days); setDueDate(moduleTaskCalendarDay(date)); }} className="min-h-10 rounded-full px-3 text-xs text-[var(--primary)] hover:bg-[var(--surface-container-high)]">{label}</button>)}
          </div>
        </div>
      </fieldset>
    </form>
  </AppDialog>;
}
