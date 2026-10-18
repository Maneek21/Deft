import { notFound } from 'next/navigation';
import { APP_PRIVATE_SHARING_ENABLED } from '@/lib/feature-flags';
import { PrivateResourceMcpInventory } from '@/components/apps/private-resource-mcp';

export default async function Page({ params }: { params: Promise<{ appId: string }> }) {
  if (!APP_PRIVATE_SHARING_ENABLED) notFound();
  return <PrivateResourceMcpInventory appId={(await params).appId} />;
}
