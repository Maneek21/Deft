import { z } from 'zod';
import { NativeMentionSourceSchema } from '@deft/shared';
import { handleNativeMentionReconciliation, handleNativeMentionPublication, deliverNativeMention } from '../../lib/native-mentions.js';
import type { JobHandler } from '../types.js';

export const handleNativeMentionReconcile: JobHandler = async job => {
  const data = z.object({ orgId: z.string().min(1), source: NativeMentionSourceSchema, publishOnCreate: z.boolean().optional() }).parse(job.data);
  await handleNativeMentionReconciliation(data);
};
export const handleNativeMentionDeliver: JobHandler = async job => {
  const data = z.object({ orgId: z.string().min(1), deliveryId: z.string().min(1) }).parse(job.data);
  await deliverNativeMention(data.orgId, data.deliveryId);
};
export const handleNativeMentionPublish: JobHandler = async job => {
  const data = z.object({ orgId: z.string().min(1), actorUserId: z.string().min(1),
    source: NativeMentionSourceSchema, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(job.data);
  await handleNativeMentionPublication(data);
};
