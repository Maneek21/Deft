/**
 * Failure switches for testing a running cell (launch check 13, cases 13.9
 * and 13.10). They let a tester make an approved assistant action fail,
 * finally or once-and-retryable, and make an assistant reply job hang.
 *
 * Off unless the operator sets DEFT_TEST_FAILURE_SWITCHES in the cell's
 * environment. Workspace owners, admins and members cannot set it: it is not
 * stored in the database and no route reads or writes it. When it is on, a
 * switch fires only for an action or a message that carries its marker text,
 * so the tester picks which action fails.
 *
 * The value must be exact, or the API refuses to start:
 *   - self-hosted: "on";
 *   - hosted: "cell:<DEFT_CELL_ID>", naming this cell. A value copied from
 *     another cell's settings names the wrong cell and stops the API.
 */

import { isHostedMode } from './hosted-mode.js';

export const TEST_FAILURE_SWITCHES_SETTING = 'DEFT_TEST_FAILURE_SWITCHES';

/** An approved action whose proposed params contain this fails finally. */
export const FAIL_APPROVAL_FINAL_MARKER = 'deft-test-fail-final';
/** An approved action whose params contain this fails once, retryably. */
export const FAIL_APPROVAL_RETRYABLE_MARKER = 'deft-test-fail-retryable';
/** An assistant reply triggered by a message containing this hangs until the job timeout. */
export const HANG_REPLY_MARKER = 'deft-test-hang-reply';

export const FORCED_FINAL_FAILURE_ERROR =
  'A test failure switch stopped this action on purpose. It did not run.';
export const FORCED_RETRYABLE_FAILURE_ERROR =
  'A test failure switch stopped this action once on purpose. It did not run; approve it again to retry.';

function expectedValue(hostedMode: boolean, source: NodeJS.ProcessEnv): string | null {
  if (!hostedMode) return 'on';
  const cellId = source.DEFT_CELL_ID?.trim();
  return cellId ? `cell:${cellId}` : null;
}

/** Startup check, called from env.ts. */
export function validateTestFailureSwitchesEnvironment(
  hostedMode: boolean,
  source: NodeJS.ProcessEnv = process.env,
): void {
  const value = source[TEST_FAILURE_SWITCHES_SETTING];
  if (value === undefined) return;
  if (value === expectedValue(hostedMode, source)) return;
  throw new Error(hostedMode
    ? `${TEST_FAILURE_SWITCHES_SETTING} is set but does not name this cell. On a hosted cell it must be exactly ` +
      '"cell:<DEFT_CELL_ID>" for this cell. Remove it unless this is a test cell.'
    : `${TEST_FAILURE_SWITCHES_SETTING} must be exactly "on" when it is set. Remove it unless this is a test install.`);
}

export function testFailureSwitchesEnabled(
  hostedMode = isHostedMode(),
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = source[TEST_FAILURE_SWITCHES_SETTING];
  return value !== undefined && value === expectedValue(hostedMode, source);
}

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? '';
  } catch {
    return '';
  }
}

function previousFailureWasForcedRetryable(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result)
    && (result as Record<string, unknown>).retryable === true
    && (result as Record<string, unknown>).test_failure_switch === 'retryable');
}

export type ForcedApprovalFailure = {
  success: false;
  error: string;
  result: Record<string, unknown>;
};

/**
 * The failure a switch forces on an approved action, or null to run it.
 * The retryable switch fires once: the reopened row remembers it, so the
 * next approval runs the action for real.
 */
export function forcedApprovalFailure(row: { params: unknown; result: unknown }): ForcedApprovalFailure | null {
  if (!testFailureSwitchesEnabled()) return null;
  const params = serialized(row.params);
  if (params.includes(FAIL_APPROVAL_FINAL_MARKER)) {
    return {
      success: false,
      error: FORCED_FINAL_FAILURE_ERROR,
      result: { terminal_refusal: true, test_failure_switch: 'final' },
    };
  }
  if (params.includes(FAIL_APPROVAL_RETRYABLE_MARKER) && !previousFailureWasForcedRetryable(row.result)) {
    return {
      success: false,
      error: FORCED_RETRYABLE_FAILURE_ERROR,
      result: { test_failure_switch: 'retryable' },
    };
  }
  return null;
}

/**
 * Hang an assistant reply whose trigger message carries the hang marker,
 * until the worker aborts the job (its timeout). Returns at once otherwise,
 * or when there is no abort signal to end the hang.
 */
export async function hangReplyForTestSwitch(content: string | null | undefined, signal?: AbortSignal): Promise<void> {
  if (!signal || !content || !content.includes(HANG_REPLY_MARKER) || !testFailureSwitchesEnabled()) return;
  console.warn('[test-failure-switches] holding an assistant reply until its job times out');
  await new Promise<never>((_, reject) => {
    const stop = () => reject(signal.reason instanceof Error ? signal.reason : new Error('agent-reply: test hang aborted'));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}
