import type { AppRunActor } from '@deft/shared';
import type { AppRunSafeView } from './app-run-repository.js';

export type AppRunAccessAction = 'inspect' | 'result' | 'cancel' | 'reconcile';

export interface AppRunAuthorizer {
  authorize(input: Readonly<{
    action: AppRunAccessAction;
    org_id: string;
    actor: AppRunActor;
    run: AppRunSafeView;
  }>): Promise<boolean>;
}

export const denyAllAppRunAuthorizer: AppRunAuthorizer = Object.freeze({
  async authorize() {
    return false;
  },
});

export interface AppRunExecutionAuthorizer {
  authorizeExecution(input: Readonly<{
    org_id: string;
    run: AppRunSafeView;
  }>): Promise<boolean>;
}

export const denyAllAppRunExecutionAuthorizer: AppRunExecutionAuthorizer = Object.freeze({
  async authorizeExecution() {
    return false;
  },
});
