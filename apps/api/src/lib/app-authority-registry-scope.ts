import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppConnectionSessionRegistry, AppConnectionSessionRegistryStatIdentity } from './app-connection-session-registry.js';
import type { AppRunTransaction } from './app-run-repository.js';

/** Per-HTTP-request reuse of the parsed deployment registry object. The file is
 * still `lstat`-ed on every lookup so a replaced/removed/symlinked/oversized
 * file revokes access on the very next call; only `readFile` + `JSON.parse` +
 * `trustedUpgradeRegistryEntries` are reused while the file identity is
 * unchanged. Never retained across requests and never shared with a
 * transaction-bound caller (a supplied transaction owns its own committed-state
 * proof read). The registry object holds data-only deployment entries; no
 * authority decision, profile lookup or provider content is ever memoised.
 *
 * The loader is imported lazily inside the function: this module is itself
 * imported by the registry module, and keeping the value imports out of the
 * module top-level avoids a load-time cycle (and keeps the registry module
 * independently mockable in unit tests). */
type MemoEntry = { identity: AppConnectionSessionRegistryStatIdentity; registry: AppConnectionSessionRegistry };
type ScopeState = { memo: Map<string, MemoEntry> };

const storage = new AsyncLocalStorage<ScopeState>();

const identityKey = (identity: AppConnectionSessionRegistryStatIdentity) =>
  `${identity.path}\0${identity.dev}\0${identity.ino}\0${identity.size}\0${identity.mtimeMs}`;

export function withAuthorityRegistryScope<T>(work: () => Promise<T>): Promise<T> {
  const state: ScopeState = { memo: new Map() };
  return storage.run(state, work);
}

export async function getScopedAppConnectionSessionRegistry(transaction?: AppRunTransaction): Promise<AppConnectionSessionRegistry> {
  const path = process.env.DEFT_APP_CONNECTION_HTTP_CONFIG;
  const state = storage.getStore();
  // Transaction-bound reads always join the caller's own transaction and can
  // never be shared across call sites or with a transactionless read.
  if (transaction !== undefined || !state || !path) {
    const { loadAppConnectionSessionRegistry } = await import('./app-connection-session-registry.js');
    return loadAppConnectionSessionRegistry(path, transaction);
  }
  // The stat is performed on every lookup; a changed identity drops the memo and
  // reloads (revocation parity). Identical path bytes are not enough — device,
  // inode, size and mtime must all match so a replaced file is observed.
  const { statAppConnectionSessionRegistryFile, loadAppConnectionSessionRegistry } = await import('./app-connection-session-registry.js');
  const identity = await statAppConnectionSessionRegistryFile(path);
  const key = identityKey(identity);
  const entry = state.memo.get(key);
  if (entry) return entry.registry;
  const registry = await loadAppConnectionSessionRegistry(path);
  state.memo.set(key, { identity, registry });
  return registry;
}
