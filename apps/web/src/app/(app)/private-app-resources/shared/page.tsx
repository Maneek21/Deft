import {notFound} from 'next/navigation';
import {APP_PRIVATE_SHARING_ENABLED} from '@/lib/feature-flags';
import {PrivateSharingInventory} from '@/components/apps/private-resource-sharing';
export default function Page() {if(!APP_PRIVATE_SHARING_ENABLED)notFound();return <PrivateSharingInventory/>;}
