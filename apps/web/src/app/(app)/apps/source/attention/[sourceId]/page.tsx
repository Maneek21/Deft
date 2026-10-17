import {notFound} from 'next/navigation';
import {APPS_ENABLED} from '@/lib/feature-flags';
import {AppIntegrationSourceOpen} from '@/components/apps/integrations/source-open';
export default async function SourcePage({params}:{params:Promise<{sourceId:string}>}){
 if(!APPS_ENABLED)notFound();const {sourceId}=await params;return <AppIntegrationSourceOpen sourceId={sourceId} kind="attention"/>;
}
