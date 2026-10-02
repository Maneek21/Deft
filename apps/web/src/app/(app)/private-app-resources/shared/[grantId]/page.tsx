import {notFound} from 'next/navigation';
import {APP_PRIVATE_SHARING_ENABLED} from '@/lib/feature-flags';
import {SharedPrivateResource} from '@/components/apps/private-resource-sharing';
export default async function Page({params}:{params:Promise<{grantId:string}>}) {
  if(!APP_PRIVATE_SHARING_ENABLED)notFound();const {grantId}=await params;return <SharedPrivateResource grantId={grantId}/>;
}
