import {notFound} from 'next/navigation';
import {APP_PRIVATE_SHARING_ENABLED} from '@/lib/feature-flags';
import {PrivateSharingInventory} from '@/components/apps/private-resource-sharing';
export default async function Page({params}:{params:Promise<{appId:string}>}) {
  if(!APP_PRIVATE_SHARING_ENABLED)notFound();const {appId}=await params;return <PrivateSharingInventory appId={appId}/>;
}
