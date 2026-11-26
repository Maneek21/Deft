'use client';

// A document's block image, drawn (plan Task F12). The node and its
// attributes are @deft/doc-schema's DocumentImage, so the editor and the API
// share one schema; this adds only the view.
//
// An image that names a Deft file (`fileId`) is fetched with the viewer's own
// token into a blob URL, as notes do, so it shows only to someone the file
// route lets read it (F10: through the documents that link it). A freshly
// uploaded image is readable to viewers and commenters only once the
// document's next store confirms it is in the content, which can take up to a
// minute while people are editing. So a 404 is not taken as broken at once:
// the view shows "Image is loading" and tries again, for about 90 s; only
// then does it say "Image not available". Any other refusal says so at once.
//
// Every retry goes through one backoff (IMAGE_RETRY_STEPS_MS): after the n-th
// miss, no request starts until step n has passed since the last one started,
// whatever asks for it (the timer, a document change, a change that arrived
// while a request was in flight). A document change (a Yjs change, or
// `document:updated`) since the last request lets the next one start as soon
// as its step has passed; without one, the timer waits one step longer. So
// someone typing never makes a viewer fetch more often than the steps allow.
// A deadline timer of its own, set at the first 404, ends the wait at 90 s
// (aborting a request still in flight), and no request is ever planned for
// the last second before it or after it. Success and unmount clear it.
//
// An image from another site (`src`, https only) is drawn as is.

import { useEffect, useState } from 'react';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { DocumentImage } from '@deft/doc-schema/nodes/document-image';
import { api } from '@/lib/api';
import { protectedFilePath } from '@/lib/protected-file';
import { DOCUMENT_UPDATED_EVENT } from '@/lib/document-events';

/** The backoff: after the n-th miss, the least time between the last request's start and the next; the last step repeats. */
export const IMAGE_RETRY_STEPS_MS = [1_500, 3_000, 6_000, 12_000, 24_000, 30_000];
/** How long after the first 404 the image is given up on: a timer of its own ends the wait then, whatever the backoff. */
export const IMAGE_GIVE_UP_AFTER_MS = 90_000;
/** No request starts this close to the deadline (its answer would come too late to count). */
const LAST_REQUEST_LEAD_MS = 1_000;

const stepAfter = (misses: number) => IMAGE_RETRY_STEPS_MS[Math.min(Math.max(misses - 1, 0), IMAGE_RETRY_STEPS_MS.length - 1)]!;

/**
 * When the next request may start, after `misses` misses (at least one), the
 * last request having started at `lastStart`: once its step has passed when
 * the document changed since, else one step later, pulled in to a second
 * before the deadline (`firstMiss` + IMAGE_GIVE_UP_AFTER_MS) when that's
 * later. Null when even the step ends too close to the deadline: no request
 * is ever planned at or after it, and none before its step.
 */
export function nextRetryAt(i: { misses: number; lastStart: number; firstMiss: number; changed: boolean }): number | null {
  const latest = i.firstMiss + IMAGE_GIVE_UP_AFTER_MS - LAST_REQUEST_LEAD_MS;
  const earliest = i.lastStart + stepAfter(i.misses);
  if (earliest > latest) return null;
  const due = i.changed ? earliest : i.lastStart + stepAfter(i.misses + 1);
  return Math.min(due, latest);
}

/** An outside image is drawn only from an https address. */
export function outsideImageSrc(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  try {
    return new URL(src).protocol === 'https:' ? src : null;
  } catch {
    return null;
  }
}

type Phase = { kind: 'loading' } | { kind: 'waiting' } | { kind: 'shown'; url: string } | { kind: 'unavailable' };

/** Loads a Deft file image, waiting out the 404 a new image gives viewers until its document is stored. */
function useDocumentFile(fileId: string, editor: Editor): Phase {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  useEffect(() => {
    let done = false;
    let objectUrl: string | null = null;
    let inFlight: AbortController | null = null;
    let misses = 0;
    let firstMiss: number | null = null;
    let lastStart = 0;
    /** A document change since the last request started. */
    let changed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Ends the wait IMAGE_GIVE_UP_AFTER_MS after the first 404, whatever the backoff is doing. */
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      timer = null;
      deadline = null;
    };
    const finish = (next: Phase) => {
      done = true;
      clearTimers();
      setPhase(next);
    };
    /**
     * The one gate: (re)plans the next request from the backoff. While a
     * request is in flight nothing is planned; its end plans again, with any
     * change that arrived meanwhile.
     */
    const plan = () => {
      if (done || inFlight || firstMiss === null) return;
      if (timer) clearTimeout(timer);
      timer = null;
      const at = nextRetryAt({ misses, lastStart, firstMiss, changed });
      // Nothing more before the deadline: the deadline timer ends the wait.
      if (at === null) return;
      timer = setTimeout(() => { timer = null; void attempt(); }, Math.max(0, at - Date.now()));
    };
    const attempt = async (): Promise<void> => {
      if (done || inFlight) return;
      const controller = new AbortController();
      inFlight = controller;
      lastStart = Date.now();
      changed = false;
      let status: number | 'network' = 'network';
      let blob: Blob | null = null;
      try {
        const res = await api.fetch(protectedFilePath(fileId), { signal: controller.signal });
        status = res.status;
        if (res.ok) blob = await res.blob();
      } catch {
        status = 'network';
      }
      inFlight = null;
      if (done || controller.signal.aborted) return;
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        finish({ kind: 'shown', url: objectUrl });
        return;
      }
      if (status !== 404 && status !== 'network') {
        finish({ kind: 'unavailable' });
        return;
      }
      misses += 1;
      if (firstMiss === null) {
        firstMiss = Date.now();
        deadline = setTimeout(() => {
          deadline = null;
          if (done) return;
          inFlight?.abort();
          finish({ kind: 'unavailable' });
        }, IMAGE_GIVE_UP_AFTER_MS);
      }
      if (Date.now() - firstMiss >= IMAGE_GIVE_UP_AFTER_MS) {
        finish({ kind: 'unavailable' });
        return;
      }
      setPhase({ kind: 'waiting' });
      plan();
    };
    const onDocumentChange = () => {
      if (done || firstMiss === null) return;
      if (changed && !inFlight) return; // already planned for the earliest the step allows
      changed = true;
      plan();
    };
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) onDocumentChange();
    };
    editor.on('transaction', onTransaction);
    window.addEventListener(DOCUMENT_UPDATED_EVENT, onDocumentChange);
    void attempt();
    return () => {
      done = true;
      clearTimers();
      inFlight?.abort();
      editor.off('transaction', onTransaction);
      window.removeEventListener(DOCUMENT_UPDATED_EVENT, onDocumentChange);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, editor]);
  return phase;
}

function Unavailable() {
  return <span className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Image not available</span>;
}

function FileImage({ fileId, name, editor }: { fileId: string; name: string; editor: Editor }) {
  const phase = useDocumentFile(fileId, editor);
  if (phase.kind === 'shown') {
    // eslint-disable-next-line @next/next/no-img-element -- a blob URL fetched with the viewer's own token
    return <img src={phase.url} alt={name} className="max-w-full rounded-lg" />;
  }
  if (phase.kind === 'unavailable') return <Unavailable />;
  return (
    <span role="status" aria-label={phase.kind === 'waiting' ? 'Image is loading' : `Loading ${name}`}
      className="flex h-24 w-40 max-w-full items-center justify-center rounded-lg text-[12px]"
      style={{ background: 'var(--surface-container)', color: 'var(--on-surface-variant)' }}>
      {phase.kind === 'waiting' ? 'Image is loading' : null}
    </span>
  );
}

function DocumentImageView({ node, editor }: NodeViewProps) {
  const fileId = typeof node.attrs.fileId === 'string' ? node.attrs.fileId : '';
  const name = typeof node.attrs.alt === 'string' && node.attrs.alt ? node.attrs.alt : 'Image';
  const src = fileId ? null : outsideImageSrc(node.attrs.src);
  return (
    <NodeViewWrapper className="my-2" data-document-image="">
      {fileId ? (
        <FileImage key={fileId} fileId={fileId} name={name} editor={editor} />
      ) : src ? (
        // eslint-disable-next-line @next/next/no-img-element -- an outside image the document links to; next/image would proxy it
        <img src={src} alt={name} loading="lazy" referrerPolicy="no-referrer" className="max-w-full rounded-lg" />
      ) : (
        <Unavailable />
      )}
    </NodeViewWrapper>
  );
}

/** DocumentImage with the view above; same name (`image`), attributes and HTML. */
export const DocumentImageWithView = DocumentImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentImageView);
  },
});
