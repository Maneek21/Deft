/** Trusted scoped ports have already verified frame identity/input and byte
 * digest. Bound UI ownership as well, including ports that settle after abort. */
export async function readExperienceScopedBinary(options:{signal:AbortSignal;current:()=>boolean;read:(signal:AbortSignal)=>Promise<{bytes:Uint8Array;media_type:string;filename:string}>;mediaType:string;maxBytes:number;size?:number;filename?:string}){
 const timeout=new AbortController(),signal=AbortSignal.any([options.signal,timeout.signal]);const timer=setTimeout(()=>timeout.abort(),30000);let removeAbort=()=>{},value:{bytes:Uint8Array;media_type:string;filename:string}|undefined;
 const current=()=>!signal.aborted&&options.current();
 try{if(!current())throw Error('File access ended');const request=options.read(signal);void request.then(value=>{if(!current())value.bytes.fill(0);},()=>{});
  const cancelled=new Promise<never>((_resolve,reject)=>{const abort=()=>reject(Error('File access ended'));signal.addEventListener('abort',abort,{once:true});removeAbort=()=>signal.removeEventListener('abort',abort);if(signal.aborted)abort();});
  value=await Promise.race([request,cancelled]);
  if(!current()||value.media_type!==options.mediaType||value.bytes.length>options.maxBytes||options.size!==undefined&&value.bytes.length!==options.size||options.filename!==undefined&&value.filename!==options.filename||!value.filename||value.filename.length>255||/[\/\\\u0000-\u001f\u007f]/u.test(value.filename))throw Error('File changed');
  return value;
 }catch(error){value?.bytes.fill(0);throw error;}finally{clearTimeout(timer);removeAbort();}
}
