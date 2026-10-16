import { AttachmentStageHeaderSchema, RESOURCE_ATTACHMENT_LIMITS } from '@deft/app-kit';

/** Parses only the small header before custody reserves the exact identity and
 * bytes. The binary allocation/read callback runs after that reservation. */
export async function readAttachmentFrame(body: ReadableStream<Uint8Array>|null,
  signal: AbortSignal, declaredLength?: number) {
  if (!body) throw new TypeError('Attachment frame required');
  const maximum=4+RESOURCE_ATTACHMENT_LIMITS.header_bytes+RESOURCE_ATTACHMENT_LIMITS.attachment_bytes;
  if(declaredLength!==undefined && (!Number.isSafeInteger(declaredLength)||declaredLength<4||declaredLength>maximum)) {
    throw new TypeError('Attachment frame length invalid');
  }
  const reader=body.getReader();
  let buffered:Uint8Array=new Uint8Array(0),offset=0,total=0,done=false,closed=false;
  const deadline=performance.now()+RESOURCE_ATTACHMENT_LIMITS.transfer_ms;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  async function next(activeSignal=signal) {
    activeSignal.throwIfAborted(); signal.throwIfAborted();
    const remaining=deadline-performance.now();
    if(remaining<=0) throw new Error('Attachment frame timeout');
    let timer:ReturnType<typeof setTimeout>|undefined;
    let rejectAbort:()=>void=()=>{};
    try {
      const result=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{cancel();reject(new Error('Attachment frame timeout'));},remaining);
        rejectAbort=()=>{cancel();reject(new Error('Attachment frame aborted'));};
        activeSignal.addEventListener('abort',rejectAbort,{once:true});
      })]);
      activeSignal.throwIfAborted(); signal.throwIfAborted();
      if(result.done){done=true;return;}
      total+=result.value.byteLength;
      if(total>maximum) throw new TypeError('Attachment frame too large');
      buffered=result.value;offset=0;
    }finally{
      if(timer) clearTimeout(timer);
      activeSignal.removeEventListener('abort',rejectAbort);
    }
  }
  async function exact(length:number,activeSignal=signal) {
    const value=new Uint8Array(length);let filled=0;
    while(filled<length){
      if(offset===buffered.byteLength){await next(activeSignal);if(done)throw new TypeError('Attachment frame truncated');}
      const count=Math.min(length-filled,buffered.byteLength-offset);
      value.set(buffered.subarray(offset,offset+count),filled);offset+=count;filled+=count;
    }
    return value;
  }
  const close=async()=>{
    if(closed)return;closed=true;signal.removeEventListener('abort',cancel);
    await reader.cancel().catch(()=>{});reader.releaseLock();buffered=new Uint8Array(0);
  };
  try {
    const length=new DataView((await exact(4)).buffer).getUint32(0,false);
    if(length<2||length>RESOURCE_ATTACHMENT_LIMITS.header_bytes)throw new TypeError('Attachment header length invalid');
    const header=AttachmentStageHeaderSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await exact(length))));
    const expected=4+length+header.declared_size_bytes;
    if(declaredLength!==undefined&&declaredLength!==expected)throw new TypeError('Attachment frame length mismatch');
    let consumed=false;
    return {header,close,deadline,async readBytes(activeSignal:AbortSignal){
      if(consumed)throw new TypeError('Attachment frame already consumed');consumed=true;
      let bytes:Uint8Array|undefined;
      try {
        bytes=await exact(header.declared_size_bytes,activeSignal);
        if(offset<buffered.byteLength)throw new TypeError('Attachment frame trailing bytes');
        await next(activeSignal);if(!done)throw new TypeError('Attachment frame trailing bytes');
        if(total!==expected)throw new TypeError('Attachment frame length mismatch');
        return Buffer.from(bytes);
      }finally{bytes?.fill(0);await close();}
    }};
  }catch(error){await close();throw error;}
}
