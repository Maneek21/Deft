'use client';
import {useParams,useRouter} from 'next/navigation';import {OriginalPreparation} from '@/components/apps/integrations/original-preparation';
export default function OriginalPreparationPage(){const params=useParams<{invocationId:string}>(),router=useRouter();return <OriginalPreparation invocationId={params.invocationId} onClose={()=>router.push('/apps')}/>;}
