import type { ExperienceConnectionAction, ExperienceAccountTarget } from '../../../../packages/app-kit/src/experience-account';
import { ExperienceAccountTargetSchema as experienceAccountTargetSchema } from '../../../../packages/app-kit/src/experience-account';

export type ConnectionActionPorts = {
  showSettings: (open?: boolean, section?: string) => void | Promise<void>;
  setResourceTarget: (key: string) => void;
  beginConnection: (targetKey: string) => Promise<void>;
  reestablishBackgroundAccess: (targetKey: string) => Promise<string>;
  openRestore: (targetKey: string | null) => void;
  notice: (message: string) => void;
};

/** Parse one catalog entry, dropping invalid health while keeping the target,
 * and dropping the entry entirely when the target itself is invalid. */
export function parseExperienceAccountTarget(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => parseExperienceAccountTarget(item)).filter((item) => item !== null);
  }
  const item = input;
  // We can't import the schema runtime here without the app-kit path; use a
  // structural check mirroring ExperienceAccountTargetSchema.
  const schema = experienceAccountTargetSchema;
  if (schema.safeParse(item).success) return item;
  if (item && typeof item === 'object' && 'health' in (item as Record<string, unknown>)) {
    const { health: _health, ...rest } = item as Record<string, unknown>;
    if (schema.safeParse(rest).success) return rest;
  }
  return null;
}

/** Decision logic for a connection action. App-neutral: the component supplies
 * ports for the side effects. */
export async function dispatchConnectionAction(
  action: ExperienceConnectionAction,
  currentTarget: string,
  catalogRows: readonly ExperienceAccountTarget[],
  ports: ConnectionActionPorts,
): Promise<void> {
  const targetKey = action.target_key ?? currentTarget;
  if (action.kind === 'restore_access') {
    ports.openRestore(targetKey);
    return;
  }
  if (action.kind === 'reconnect') {
    ports.openRestore(null);
    if (!targetKey) {
      await ports.showSettings(true);
      return;
    }
    const known = catalogRows.some((row) => row?.key === targetKey);
    if (!known) {
      await ports.showSettings(true);
      return;
    }
    const targetHealth = catalogRows.find((row) => row?.key === targetKey)?.health;
    if (targetHealth?.connection === 'connected') {
      try {
        ports.notice(await ports.reestablishBackgroundAccess(targetKey));
      } catch (error) {
        ports.notice(error instanceof Error ? error.message : 'Background access is unavailable.');
        await ports.showSettings(true);
      }
      return;
    }
    if (targetKey !== currentTarget) {
      ports.setResourceTarget(targetKey);
    }
    try {
      await ports.beginConnection(targetKey);
    } catch (error) {
      ports.notice(error instanceof Error ? error.message : 'Account setup is unavailable.');
      ports.setResourceTarget(currentTarget);
      await ports.showSettings(true);
    }
    return;
  }
  // review_consent and any other kind
  ports.openRestore(null);
  await ports.showSettings(true, 'access');
}
