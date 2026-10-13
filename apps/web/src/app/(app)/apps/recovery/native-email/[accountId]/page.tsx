import {notFound} from 'next/navigation';
import {APPS_ENABLED} from '@/lib/feature-flags';
import {NativeEmailRecovery} from '@/components/apps/integrations/native-email-recovery';
export default async function RecoveryPage({params,searchParams}:{params:Promise<{accountId:string}>;searchParams:Promise<{message?:string}>}){
 if(!APPS_ENABLED)notFound();const {accountId}=await params;
 if(!/^[A-Za-z0-9_-]{1,256}$/u.test(accountId))notFound();
 const {message}=await searchParams;if(message&&!/^mail_[a-f0-9]{64}$/u.test(message))notFound();
 return <NativeEmailRecovery accountId={accountId} initialMessageId={message}/>;
}
