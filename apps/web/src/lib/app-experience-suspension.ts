/** Visibility suspends presentation, not the exact accepted authority interval. */
export function experienceOperationAllowedWhileHidden(operation: string, input: unknown): boolean {
  return operation === 'private_state' && !!input && typeof input === 'object' && !Array.isArray(input)
    && (input as { operation?: unknown }).operation === 'put';
}

export function createExperienceSuspension(input: {
  current: () => boolean; live: (signal:AbortSignal) => Promise<boolean>; hidden: () => boolean;
  flush: () => void; clear: () => void; restore: () => void; end: () => void; unavailable?:()=>void;
}) {
  let epoch = 0, disposed = false, pending:AbortController|undefined;
  return {
    hide() { if (disposed) return; epoch += 1; pending?.abort(); input.flush(); input.clear(); },
    async show() {
      const ticket = ++epoch;
      if (disposed) return false;
      pending?.abort();const controller=new AbortController();pending=controller;
      const timeout=setTimeout(()=>controller.abort(),10000);let live=false,unavailable=false;
      let rejectAborted!:()=>void;const aborted=new Promise<never>((_,reject)=>{rejectAborted=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',rejectAborted,{once:true});});
      try { live = await Promise.race([input.live(controller.signal),aborted]); } catch { unavailable=true; }
      finally{clearTimeout(timeout);controller.signal.removeEventListener('abort',rejectAborted);if(pending===controller)pending=undefined;}
      if (disposed || ticket !== epoch || input.hidden()) return false;
      if(!input.current()){input.end();return false;}
      if(unavailable&&input.unavailable){input.unavailable();return false;}
      if (!live) { input.end(); return false; }
      input.restore(); return true;
    },
    dispose() { disposed = true; epoch += 1; pending?.abort(); },
  };
}
