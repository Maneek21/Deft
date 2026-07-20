import type { JobHandler } from '../types.js';
import { sendAttentionDelivery } from '../../lib/web-push.js';

export const handleAttentionDelivery: JobHandler = async (job) => {
  const deliveryId = typeof job.data?.delivery_id === 'string' ? job.data.delivery_id : null;
  if (!deliveryId) throw new Error('attention-delivery requires delivery_id');
  await sendAttentionDelivery(deliveryId, { attempt: job.attempts });
};
