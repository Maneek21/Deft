export type JobData = { id: string; name: string; data: Record<string, any>; attempts: number };
export type JobHandler = (job: JobData) => Promise<void>;
