import { createBoundedAppRunDatabase, APP_RUN_TRANSACTION_LIMITS } from './app-run-bounded-db.js';
import { env, isAppNativeCalendarEnabled } from './env.js';
import { nativeStale } from './app-native-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';

let database: ReturnType<typeof createBoundedAppRunDatabase> | undefined;
export function nativeExecutionTransaction<T>(work: (tx: AppRunTransaction) => Promise<T>, signal?: AbortSignal) {
  if (!isAppNativeCalendarEnabled()) throw nativeStale();
  database ??= createBoundedAppRunDatabase(env.DATABASE_URL, { max: 2, application_name: 'deft-app-native-calendar' });
  return database.transaction(work, signal ?? new AbortController().signal, performance.now() + APP_RUN_TRANSACTION_LIMITS.budget_ms);
}
export async function closeNativeExecutionDatabase() {
  const prior = database; database = undefined;
  await prior?.close();
}
