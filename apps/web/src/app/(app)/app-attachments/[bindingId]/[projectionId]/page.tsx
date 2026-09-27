import { AttachmentParentView } from '@/components/apps/attachment-parent-view';
export default async function Page({params}:{params:Promise<{bindingId:string;projectionId:string}>}){return <AttachmentParentView {...await params}/>;}
