import type { ExperienceNode } from './app-experience-bridge';
import type { ExperienceDocumentContext, ExperienceRendererOptions } from './app-experience-renderer';
import type { SourcePresentation } from './app-experience-source-view';

type Reference = Extract<ExperienceNode, { kind: 'resource_document' }>;
type DocumentNode = Extract<ExperienceNode, { kind: 'document' }>;
type Presentation = Readonly<{ presentation: SourcePresentation; expires_at: string }>;
type Options = Readonly<{
  resourceKeys: readonly string[];
  current: () => boolean;
  load: (resourceKey: string, recordId: string, signal: AbortSignal) => Promise<Presentation>;
  mount: (reference: Reference, resolved: DocumentNode, wrapper: HTMLElement,
    current: () => boolean, load: (signal: AbortSignal) => Promise<Presentation>) => () => void;
  now?: () => number;
}>;

/** Pending review work belongs to its producer signal; a later render must not
 * inherit an aborted fetch. A completed snapshot can be reused until its caller
 * validates/invalidates its current authority and deadline. */
export function createExperiencePresentationReviewCache<T>() {
  let entry: { promise: Promise<T>; signal: AbortSignal | null; value?: T } | null = null;
  return {
    read(signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      if (entry?.signal?.aborted) entry = null;
      if (!entry) {
        const pending = { promise: Promise.resolve().then(() => load(signal)), signal, value: undefined as T | undefined };
        entry = pending;
        void pending.promise.then(value => {
          if (entry === pending) { pending.value = value; entry.signal = null; }
        }, () => { if (entry === pending) entry = null; });
      }
      return entry.promise;
    },
    invalidate(value: T) { if (entry?.value === value) entry = null; },
    clear() { entry = null; },
  };
}

/** Resolve signed resource references through host custody. Worker body text is
 * never used as an identity or a source locator. Full formatting/images remain
 * inside the existing reviewed presentation controller. */
export function createExperienceResourceDocumentHost(options: Options): Pick<ExperienceRendererOptions,
  'resolveResourceDocument' | 'enhanceResourceDocument'> {
  const valid = (reference: Reference, context: ExperienceDocumentContext) =>
    options.current() && context.current() && !context.signal.aborted
    && options.resourceKeys.includes(reference.resource_key);
  const read = async (reference: Reference, context: ExperienceDocumentContext, signal: AbortSignal) => {
    if (!valid(reference, context) || signal.aborted) throw Error('APP_DOCUMENT_UNAVAILABLE');
    const value = await options.load(reference.resource_key, reference.record_id, signal);
    const expiry = Date.parse(value.expires_at);
    if (!valid(reference, context) || signal.aborted || !Number.isFinite(expiry)
      || expiry <= (options.now?.() ?? Date.now())) throw Error('APP_DOCUMENT_UNAVAILABLE');
    return value;
  };
  return {
    async resolveResourceDocument(reference, context) {
      const { presentation } = await read(reference, context, context.signal);
      // The legacy Document leaf remains bounded; the trusted enhancement uses
      // the complete presentation. Do not cut a Unicode code point in half.
      let content = '', bytes = 0;
      const encoder = new TextEncoder();
      for (const character of presentation.plain_text) {
        const length = encoder.encode(character).byteLength;
        if (bytes + length > 16_384) break;
        content += character; bytes += length;
      }
      return { kind: 'document', id: reference.id, format: 'plain', content,
        truncated: presentation.truncated || content.length < presentation.plain_text.length };
    },
    enhanceResourceDocument(reference, resolved, wrapper, context) {
      if (!valid(reference, context)) return;
      const dispose = options.mount(reference, resolved, wrapper,
        () => valid(reference, context), signal => read(reference, context, signal));
      let disposed = false;
      const close = () => {
        if (disposed) return;
        disposed = true; context.signal.removeEventListener('abort', close); dispose();
      };
      context.signal.addEventListener('abort', close, { once: true });
      if (!valid(reference, context)) close();
      return close;
    },
  };
}
