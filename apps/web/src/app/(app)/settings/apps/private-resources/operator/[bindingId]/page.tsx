import { notFound } from 'next/navigation';
import { APP_RESOURCE_SYNC_ENABLED } from '@/lib/feature-flags';
import { OperatorSessionClient } from './operator-session-client';

export default async function OperatorSessionPage({ params }: { params: Promise<{ bindingId: string }> }) {
  if (!APP_RESOURCE_SYNC_ENABLED) notFound();
  const { bindingId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bindingId)) notFound();
  return <OperatorSessionClient bindingId={bindingId} />;
}
