import { notFound } from 'next/navigation';
import { APP_RESOURCE_SYNC_ENABLED } from '@/lib/feature-flags';
import { PrivateResourcesClient } from './private-resources-client';

export default function PrivateResourcesPage() {
  if (!APP_RESOURCE_SYNC_ENABLED) notFound();
  return <PrivateResourcesClient />;
}
