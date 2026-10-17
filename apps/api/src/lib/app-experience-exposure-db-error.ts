/** Expected, transient capacity pressure; never an authorization denial. */
export class ExperienceExposureBusyError extends Error {
  readonly code = 'APP_EXPERIENCE_BUSY';
  readonly retryable = true;
  constructor(readonly reason: 'acquisition' | 'deadline', options?: ErrorOptions) {
    super('App access is busy. Please try again.', options);
    this.name = 'ExperienceExposureBusyError';
  }
}
