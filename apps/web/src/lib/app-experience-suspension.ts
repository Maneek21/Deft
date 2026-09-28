/** Visibility suspends presentation, not the exact accepted authority interval. */
export function experienceOperationAllowedWhileHidden(operation: string, input: unknown): boolean {
  return operation === 'private_state' && !!input && typeof input === 'object' && !Array.isArray(input)
    && (input as { operation?: unknown }).operation === 'put';
}

export function createExperienceSuspension(input: {
  current: () => boolean; live: () => Promise<boolean>; hidden: () => boolean;
  flush: () => void; clear: () => void; restore: () => void; end: () => void;
}) {
  let epoch = 0, disposed = false;
  return {
    hide() { if (disposed) return; epoch += 1; input.flush(); input.clear(); },
    async show() {
      const ticket = ++epoch;
      if (disposed) return false;
      let live = false;
      try { live = await input.live(); } catch { /* Failed revalidation is terminal. */ }
      if (disposed || ticket !== epoch || input.hidden()) return false;
      if (!live || !input.current()) { input.end(); return false; }
      input.restore(); return true;
    },
    dispose() { disposed = true; epoch += 1; },
  };
}
