export type JobData = {
  id: string;
  name: string;
  data: Record<string, any>;
  attempts: number;
  /** Queue lease boundary for domain claims that must not outlive delivery. */
  leaseExpiresAt?: Date;
  /** Cooperative cancellation; handlers must explicitly pass it to abort-aware I/O. */
  signal?: AbortSignal;
};
export type JobHandler = (job: JobData) => Promise<void>;
