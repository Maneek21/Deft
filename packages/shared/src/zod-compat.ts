import type { z } from 'zod';

/**
 * App/Module protocols freeze Zod 4.4's unknown-key diagnostics, including
 * refinement short-circuiting and union branch errors. Zod 4.6 makes these
 * issues continuable. Retain every issue, but restore its abort flag before
 * downstream checks or containing unions inspect the parse result.
 */
export function abortOnUnknownContractKeys(payload: z.RefinementCtx): boolean {
  let aborted = false;
  for (const [index, issue] of payload.issues.entries()) {
    if (issue.code === 'unrecognized_keys') {
      payload.issues[index] = { ...issue, continue: false };
      aborted = true;
    }
  }
  return aborted;
}
