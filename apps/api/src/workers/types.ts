export type JobData = {
  id: string;
  name: string;
  data: Record<string, any>;
  attempts: number;
  /** Fences durable scan progress to the currently owned queue delivery. */
  lockToken?: string;
  /** Queue lease boundary for domain claims that must not outlive delivery. */
  leaseExpiresAt?: Date;
  /** Cooperative cancellation; handlers must explicitly pass it to abort-aware I/O. */
  signal?: AbortSignal;
  /** The queue row's own org, when the job was claimed from the queue. */
  orgId?: string | null;
  /** The scheduler key, set only on recurring scheduler jobs. */
  cronKey?: string | null;
};
export type JobHandler = (job: JobData) => Promise<void>;
