import {notFound} from 'next/navigation';
import {APP_PRIVATE_SHARING_ENABLED} from '@/lib/feature-flags';
import {PrivateResourceShareReview} from '@/components/apps/private-resource-sharing';
export default async function Page({params}:{params:Promise<{registrationId:string;resourceType:string;projectionId:string}>}) {
  if(!APP_PRIVATE_SHARING_ENABLED)notFound();const identity=await params;return <PrivateResourceShareReview {...identity}/>;
}
