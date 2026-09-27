import { notFound } from 'next/navigation';
import { APP_PRIVATE_MCP_ENABLED } from '@/lib/feature-flags';
import { PrivateResourceMcpReview } from '@/components/apps/private-resource-mcp';

export default async function Page({ params }: { params: Promise<{ registrationId: string; resourceType: string; projectionId: string }> }) {
  if (!APP_PRIVATE_MCP_ENABLED) notFound();
  return <PrivateResourceMcpReview {...await params} />;
}
