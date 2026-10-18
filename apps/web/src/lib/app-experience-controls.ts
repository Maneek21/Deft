import { DeftExperienceRichtextFieldNodeSchema, type DeftExperienceRichtextFieldNode,
  type DeftExperienceFileFieldNode } from '../../../../packages/app-kit/src/experience-capabilities';
import { composerFileDigest, composerFileSelectionError, parseComposerPrivateFiles, sameComposerFileCatalog,
  type ComposerFilesPolicy, type ComposerPrivateFiles } from './app-experience-compose-files';

export function validateExperienceRichtextEdit(node: DeftExperienceRichtextFieldNode, value: {html:string;plainText:string}) {
  return DeftExperienceRichtextFieldNodeSchema.parse({...node,value:{html:value.html,plain_text:value.plainText}}).value;
}
/** Profiles can lower the reviewed file limits. No author field can widen them. */
export function selectedExperienceFilePolicy(node: DeftExperienceFileFieldNode, reviewed: ComposerFilesPolicy): ComposerFilesPolicy {
  if (node.profile.purpose !== 'attachment') throw Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');
  return {...reviewed,max_files_per_record:Math.min(reviewed.max_files_per_record,node.profile.max_files),
    max_file_bytes:Math.min(reviewed.max_file_bytes,node.profile.max_file_bytes),
    max_total_bytes_per_record:Math.min(reviewed.max_total_bytes_per_record,node.profile.max_total_bytes)};
}
export function createExperienceFileController(input: {
  node:DeftExperienceFileFieldNode; current:()=>boolean; signal:AbortSignal;
  policy:(signal:AbortSignal)=>Promise<ComposerFilesPolicy>;
  call:(suffix:string,options:RequestInit)=>Promise<unknown>;
}) {
  let manifest:ComposerPrivateFiles|null=null, policy:ComposerFilesPolicy|null=null, busy=false;
  const live=()=>input.current()&&!input.signal.aborted;
  const check=()=>{if(!live())throw Error('File scope changed');};
  const parse=(raw:unknown)=>{check();const next=parseComposerPrivateFiles(raw,input.node.record_id,policy!);
    if(next.draft.revision<input.node.expected_revision)throw Error('Draft revision changed');return next;};
  return {
    async load(){check();policy=selectedExperienceFilePolicy(input.node,await input.policy(input.signal));check();
      const next=parse(await input.call('',{signal:input.signal}));
      if(next.draft.revision!==input.node.expected_revision)throw Error('Draft revision changed');manifest=next;return next;},
    async upload(file:File){check();if(busy||!manifest||!policy||input.node.disabled)throw Error('Files unavailable');
      const error=composerFileSelectionError(file,manifest.files,policy);if(error)throw Error(error);busy=true;
      try{const digest=await composerFileDigest(file);check();const previous=manifest;
        const uploadOperationId=crypto.randomUUID();
        const query=new URLSearchParams({expected_revision:String(previous.draft.revision),upload_operation_id:uploadOperationId,filename:file.name});
        const next=parse(await input.call(`?${query}`,{method:'POST',body:file,headers:{'Content-Type':file.type},signal:input.signal}));
        const added=next.files.filter(row=>!previous.files.some(old=>old.file_id===row.file_id));
        if(next.draft.revision!==previous.draft.revision+1||added.length!==1||added[0].upload_operation_id!==uploadOperationId
          ||!sameComposerFileCatalog(next.files.filter(row=>row.file_id!==added[0].file_id),previous.files)
          ||added[0].digest!==digest||added[0].filename!==file.name
          ||added[0].media_type!==file.type||added[0].byte_length!==file.size)throw Error('File upload not confirmed');
        manifest=next;return next;
      }finally{busy=false;}},
    async remove(fileId:string){check();if(busy||!manifest||!policy||input.node.disabled||!manifest.files.some(row=>row.file_id===fileId))throw Error('Files unavailable');busy=true;
      try{const previous=manifest;const next=parse(await input.call(`/${encodeURIComponent(fileId)}`,{method:'DELETE',
        body:JSON.stringify({expected_revision:previous.draft.revision}),signal:input.signal}));
        if(next.draft.revision!==previous.draft.revision+1||!sameComposerFileCatalog(next.files,previous.files.filter(row=>row.file_id!==fileId)))throw Error('File removal not confirmed');
        manifest=next;return next;
      }finally{busy=false;}},
    get policy(){return policy;},
  };
}
