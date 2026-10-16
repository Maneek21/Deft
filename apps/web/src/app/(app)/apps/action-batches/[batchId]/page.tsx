import { notFound } from 'next/navigation';
import { APPS_ENABLED } from '@/lib/feature-flags';
import { ActionBatchReview } from '@/components/apps/action-batch-review';

export default async function ActionBatchPage({ params }: {
  params: Promise<{ batchId: string }>;
}) {
  if (!APPS_ENABLED) notFound();
  const { batchId } = await params;
  return <ActionBatchReview key={batchId} batchId={batchId} />;
}
