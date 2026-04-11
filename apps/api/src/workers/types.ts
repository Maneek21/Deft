export type JobData = { id: string; name: string; data: Record<string, any> };
export type JobHandler = (job: JobData) => Promise<void>;
