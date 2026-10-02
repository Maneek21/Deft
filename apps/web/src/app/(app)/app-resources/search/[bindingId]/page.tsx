import { notFound } from 'next/navigation';
import { APP_RESOURCE_SYNC_ENABLED } from '@/lib/feature-flags';
import { PrivateResourceSearch } from '@/components/apps/private-resource-search';
export default async function PrivateResourceSearchPage({ params }: { params: Promise<{ bindingId: string }> }) {
  if (!APP_RESOURCE_SYNC_ENABLED) notFound();
  return <PrivateResourceSearch bindingId={(await params).bindingId} />;
}
