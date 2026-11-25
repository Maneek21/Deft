/**
 * "Report a problem" (telemetry contract, section 2). Hosted cells only.
 *
 * A signed-in person (guests included) writes what went wrong. The cell adds
 * technical details (release, the page as a template, browser family and
 * major version, the cell's recent error references) and forwards it to the
 * control plane over the seat-statement channel:
 *
 *   POST <control plane>/v1/cells/telemetry/reports
 *
 * The reporter's own email address goes along only when they tick "Email me
 * about this report", and it is read from their account, never from the form.
 * The person's text is sent as written: they were told what it is for.
 *
 * Unlike error events, a report is what the person asked for, so the cell
 * waits (briefly) for the control plane and tells them whether it arrived.
 * It is never retried behind their back. Self-hosted Deft never sends one.
 */
import { randomUUID } from 'node:crypto';
import type { ControlPlaneTarget } from './settings.js';

export const REPORT_TEXT_MAX = 4000;
export const REPORT_CATEGORIES = ['bug', 'confusing', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export type ReportRole = 'owner' | 'admin' | 'member' | 'guest';

const SEND_TIMEOUT_MS = 8_000;

export type ProblemReport = {
  cell_id: string;
  release: string;
  report_id: string;
  role: ReportRole;
  category: ReportCategory;
  text: string;
  route: string;
  client: string;
  request_ids: string[];
  reply_email: string | null;
  created_at: string;
};

async function defaultRelease(): Promise<string> {
  const { DEFT_RELEASE_VERSION } = await import('../agent-channel.js');
  return DEFT_RELEASE_VERSION;
}

/** Test seams. */
export const problemReportDeps = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  now: (): number => Date.now(),
  release: defaultRelease,
  newId: (): string => randomUUID(),
};

/** The person's text as written, minus characters that are never text. */
export function cleanReportText(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, REPORT_TEXT_MAX);
}

/** A short reference the person can quote: the report ID's first eight characters. */
export function reportReference(reportId: string): string {
  return reportId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export async function buildProblemReport(target: ControlPlaneTarget, input: {
  role: ReportRole;
  category: ReportCategory;
  text: string;
  route: string;
  client: string;
  requestIds: string[];
  replyEmail: string | null;
}): Promise<ProblemReport> {
  return {
    cell_id: target.cellId,
    release: await problemReportDeps.release().catch(() => 'unknown'),
    report_id: problemReportDeps.newId(),
    role: input.role,
    category: input.category,
    text: input.text,
    route: input.route,
    client: input.client,
    request_ids: input.requestIds,
    reply_email: input.replyEmail,
    created_at: new Date(problemReportDeps.now()).toISOString(),
  };
}

/** True when the control plane took the report. */
export async function sendProblemReport(target: ControlPlaneTarget, report: ProblemReport): Promise<boolean> {
  try {
    const res = await problemReportDeps.fetch(`${target.baseUrl}/v1/cells/telemetry/reports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(report),
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}
