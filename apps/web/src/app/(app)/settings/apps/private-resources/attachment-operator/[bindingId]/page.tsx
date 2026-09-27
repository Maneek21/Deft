import { notFound } from 'next/navigation';
import { APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';
import { OperatorSessionClient } from '../../operator/[bindingId]/operator-session-client';

export default async function AttachmentOperatorPage({params}:{params:Promise<{bindingId:string}>}) {
  if (!APP_ATTACHMENT_BROKER_ENABLED) notFound();
  const {bindingId}=await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bindingId)) notFound();
  return <OperatorSessionClient bindingId={bindingId} attachment/>;
}
