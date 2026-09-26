import { sql } from 'drizzle-orm';
import { APP_RUNS_ENABLED, env } from './env.js';
import { createAppRunMaintenanceDatabase, APP_RUN_MAINTENANCE_LIMITS } from './app-run-maintenance-db.js';
import { parseEnvironmentAppRunKeyrings } from './app-run-keyrings.js';
import { AppRunSecretService } from './app-run-secrets.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import { PostgresAppRunRepository } from './app-run-repository.js';
import { AppRunAttemptRunner } from './app-run-attempt-runner.js';
import { PostgresAppRunReceiptWriter } from './app-run-receipts.js';
import { postgresAppRunAttemptQueue } from './app-run-scheduler.js';
import { enqueueRecoveredAppRunAttention } from './app-run-maintenance-attention.js';

type Mode = 'recovery' | 'retention';
type Candidate = { org_id: string; run_id: string };
export type AppRunMaintenanceResult = Readonly<{ state: 'disabled' | 'busy' | 'completed' | 'stopped'; inspected: number; changed: number; failed: number }>;

/** Existing Run/receipt services only. The maintenance executor cannot dispatch. */
export class AppRunMaintenance {
  private database: ReturnType<typeof createAppRunMaintenanceDatabase> | undefined;
  private cursor: Record<Mode, Candidate | null> = { recovery: null, retention: null };
  private pending: Promise<AppRunMaintenanceResult> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private activeMode: Mode | undefined;
  private waitingMode: Mode | undefined;
  constructor(private readonly enabled = () => APP_RUNS_ENABLED, private readonly now = () => new Date(),
    private readonly connectionString = env.DATABASE_URL) {}

  run(mode: Mode): Promise<AppRunMaintenanceResult> {
    if (!this.enabled()) return Promise.resolve({ state: 'disabled', inspected: 0, changed: 0, failed: 0 });
    if (this.stopped) return Promise.resolve({ state: 'stopped', inspected: 0, changed: 0, failed: 0 });
    if (this.pending) {
      if (mode !== this.activeMode) this.waitingMode = mode;
      return Promise.resolve({ state: 'busy', inspected: 0, changed: 0, failed: 0 });
    }
    this.activeMode = mode;
    this.controller = new AbortController();
    const pending = this.pass(mode, this.controller.signal).finally(() => {
      if (this.pending === pending) this.pending = undefined;
      const next = this.waitingMode; this.waitingMode = undefined; this.activeMode = undefined;
      if (next && !this.stopped) void this.run(next).then(result => {
        if (result.failed) console.warn(`[app-runs] queued maintenance ${next}: ${result.failed} item(s) require retry or repair`);
      }).catch(() => console.warn('[app-runs] queued maintenance requires retry'));
    });
    this.pending = pending; return pending;
  }

  private async pass(mode: Mode, signal: AbortSignal): Promise<AppRunMaintenanceResult> {
    const deadline = performance.now() + APP_RUN_MAINTENANCE_LIMITS.budget_ms;
    const database = this.database ??= createAppRunMaintenanceDatabase(this.connectionString);
    const transaction = <T>(work: Parameters<typeof database.transaction<T>>[0]) => database.transaction(work, signal, deadline);
    const now = this.now(); const after = this.cursor[mode];
    // Existing ORM timestamps are UTC fields. A raw pg Date parameter would
    // encode local wall-clock fields before a timestamp-without-zone compare.
    const cutoff = now.toISOString();
    const result = { state: 'completed' as AppRunMaintenanceResult['state'], inspected: 0, changed: 0, failed: 0 };
    const candidates = await transaction(async tx => {
      const rows = mode === 'recovery'
        ? await tx.execute(sql`SELECT r.org_id, r.id AS run_id FROM app_runs r JOIN app_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
          WHERE a.state IN ('claimed','provider_call_started') AND a.lease_expires_at<=${cutoff}::timestamp
          AND (${after?.org_id ?? null}::text IS NULL OR (r.org_id,r.id) > (${after?.org_id ?? null},${after?.run_id ?? null}))
          GROUP BY r.org_id,r.id ORDER BY r.org_id,r.id LIMIT ${APP_RUN_MAINTENANCE_LIMITS.items}`)
        : await tx.execute(sql`SELECT p.org_id,p.run_id FROM app_run_secret_payloads p JOIN app_runs r ON r.org_id=p.org_id AND r.id=p.run_id
          WHERE p.expires_at<=${cutoff}::timestamp AND (${after?.org_id ?? null}::text IS NULL OR (p.org_id,p.run_id) > (${after?.org_id ?? null},${after?.run_id ?? null}))
          GROUP BY p.org_id,p.run_id ORDER BY p.org_id,p.run_id LIMIT ${APP_RUN_MAINTENANCE_LIMITS.items}`);
      return rows.rows as Candidate[];
    });
    if (!candidates.length) { this.cursor[mode] = null; return result; }
    // No bootstrap inventory or provider is constructed. Missing referenced
    // keys fail the exact item transaction and stay observable in failed count.
    const keys = parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
    try {
      const secrets = new AppRunSecretService(keys); const payloads = new AppRunSecretRepository(secrets);
      const runner = new AppRunAttemptRunner(new PostgresAppRunRepository(), payloads, secrets,
        { async execute() { throw new Error('Maintenance cannot dispatch provider effects'); } }, undefined, this.now,
        undefined, undefined, new PostgresAppRunReceiptWriter(secrets, payloads), undefined, postgresAppRunAttemptQueue);
      for (const candidate of candidates) {
        if (signal.aborted || performance.now() >= deadline) { result.state = 'stopped'; break; }
        this.cursor[mode] = candidate; result.inspected++;
        try {
          result.changed += mode === 'recovery'
            ? await runner.recoverRun(candidate.org_id, candidate.run_id, undefined, { transaction, onRecovered: enqueueRecoveredAppRunAttention })
            : await payloads.purgeExpiredRunForMaintenance(candidate.org_id, candidate.run_id, now, transaction);
        } catch {
          result.failed++;
          if (signal.aborted) { result.state = 'stopped'; break; }
        }
      }
      if (result.inspected === candidates.length && candidates.length < APP_RUN_MAINTENANCE_LIMITS.items) this.cursor[mode] = null;
      return result;
    } finally { keys.destroy(); }
  }

  async stop(): Promise<void> {
    this.stopped = true; this.controller?.abort(); await this.pending?.catch(() => {}); await this.database?.close(); this.database = undefined;
  }
}

let maintenance: AppRunMaintenance | undefined;
export async function runAppRunMaintenance(mode: Mode) {
  if (!APP_RUNS_ENABLED) return;
  const result = await (maintenance ??= new AppRunMaintenance()).run(mode);
  if (result.failed) console.warn(`[app-runs] maintenance ${mode}: ${result.failed} item(s) require retry or key/receipt repair`);
}
export async function stopAppRunMaintenance() { await maintenance?.stop(); maintenance = undefined; }
