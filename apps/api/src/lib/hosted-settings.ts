/**
 * Startup guard around the hosted-mode switch (see hosted-mode.ts).
 *
 * Hosted mode is on only when DEFT_HOSTED is exactly "true". On its own that
 * rule has a trap: a hosted cell whose switch is mistyped ("1", "TRUE",
 * "true " with a trailing space, or empty) would start as a self-hosted
 * install, and the first visitor would become its owner with no setup token.
 * So the API refuses to start when:
 *
 *   1. DEFT_HOSTED is set to anything other than exactly "true" or "false".
 *      Unset is allowed and means self-hosted.
 *   2. A hosted-only setting is present while hosted mode is off.
 *
 * People who self-host never set any of these, so they are unaffected.
 */

import { SEAT_SETTING_NAMES, SEATS_PURCHASE_URL_SETTING } from './seat-settings.js';
import { WORKSPACE_LIMIT_SETTING_NAMES } from './workspace-limits.js';

/**
 * Settings that only mean something on a hosted cell. A lane that adds a
 * hosted-only setting adds its name here, and rule 2 then covers it.
 */
export const HOSTED_ONLY_SETTINGS: readonly string[] = [
  'DEFT_SETUP_TOKEN_SHA256',
  'DEFT_SETUP_TOKEN_EXPIRES_AT',
  ...SEAT_SETTING_NAMES,
  SEATS_PURCHASE_URL_SETTING,
  ...WORKSPACE_LIMIT_SETTING_NAMES,
];

/**
 * The hosted-only settings present in the environment. A name that is
 * defined counts even when its value is empty: an empty value is what a
 * provisioning template leaves behind when a variable was not filled in.
 */
export function presentHostedOnlySettings(source: NodeJS.ProcessEnv = process.env): string[] {
  return HOSTED_ONLY_SETTINGS.filter((name) => source[name] !== undefined);
}

/**
 * Startup check, called from env.ts. `hostedMode` is isHostedMode(); this
 * function never decides hosted mode itself. Error text names settings and
 * never includes the value of a hosted-only setting.
 */
export function validateHostedModeEnvironment(
  hostedMode: boolean,
  source: NodeJS.ProcessEnv = process.env,
): void {
  const hostedSwitch = source.DEFT_HOSTED;
  if (hostedSwitch !== undefined && hostedSwitch !== 'true' && hostedSwitch !== 'false') {
    throw new Error(
      `DEFT_HOSTED must be exactly "true" or "false" when it is set, but it is ${JSON.stringify(hostedSwitch)}. ` +
      'Leave it unset on a self-hosted install.',
    );
  }
  if (hostedMode) return;
  const present = presentHostedOnlySettings(source);
  if (present.length > 0) {
    throw new Error(
      `${present.join(' and ')} ${present.length === 1 ? 'is a hosted-only setting' : 'are hosted-only settings'}, ` +
      'but DEFT_HOSTED is not "true". Set DEFT_HOSTED=true on a hosted cell, or remove ' +
      `${present.length === 1 ? 'it' : 'them'} on a self-hosted install.`,
    );
  }
}
