import {notFound} from 'next/navigation';
import {APPS_ENABLED} from '@/lib/feature-flags';
import Link from 'next/link';
export default async function RecoveryPage({params,searchParams}:{params:Promise<{accountId:string}>;searchParams:Promise<{message?:string}>}){
 if(!APPS_ENABLED)notFound();const {accountId}=await params;
 if(!/^[A-Za-z0-9_-]{1,256}$/u.test(accountId))notFound();
 const {message}=await searchParams;if(message&&!/^mail_[a-f0-9]{64}$/u.test(message))notFound();
 return <section className="space-y-4 p-6"><h1 className="text-xl font-semibold">Historical source unavailable</h1><p>Open the installed connected app to review your current account access. This historical link does not authorize a new connection.</p><Link href="/settings/apps" className="deft-pill inline-flex min-h-11 items-center">Open installed apps</Link></section>;
}
