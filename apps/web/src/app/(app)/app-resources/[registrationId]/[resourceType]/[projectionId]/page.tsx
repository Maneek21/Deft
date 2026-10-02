import { notFound } from 'next/navigation';
import { APP_RESOURCE_SYNC_ENABLED } from '@/lib/feature-flags';
import { PrivateResourceReference } from '@/components/apps/private-resource-reference';

export default async function PrivateResourceReferencePage({ params }: {
  params: Promise<{ registrationId: string; resourceType: string; projectionId: string }>;
}) {
  if (!APP_RESOURCE_SYNC_ENABLED) notFound();
  const ref = await params;
  return <PrivateResourceReference {...ref} />;
}
