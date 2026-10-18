const maxPayload=25*1024*1024,maxOverhead=131072;
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let n=0;n<8;n++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
const crc32=(bytes:Uint8Array)=>{let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;};
function safeName(value:string){
  let name=value.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/gu,'_').replace(/[. ]+$/gu,'');
  if(!name||name==='.'||name==='..')name='Attachment';
  if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))name='_'+name;
  return name;
}
export function attachmentArchiveFilename(subject:string){return safeName(subject.trim().slice(0,120)||'Attachments')+'.zip';}

/** Store-only ZIP: at most 32 root entries / 25 MiB received bytes. UTF-8 names,
 * CRC32 and a central directory keep ordinary unzip tools interoperable. */
export function createAttachmentZip(files:ReadonlyArray<{filename:string;bytes:Uint8Array}>):Uint8Array{
  if(!files.length||files.length>32||files.some(f=>!f.filename||f.filename.length>200||!(f.bytes instanceof Uint8Array))
    ||files.reduce((size,f)=>size+f.bytes.length,0)>maxPayload)throw Error('Attachments exceed the archive limit.');
  const used=new Set<string>(),encoder=new TextEncoder();
  const entries=files.map(file=>{
    const base=safeName(file.filename),dot=base.lastIndexOf('.'),stem=dot>0?base.slice(0,dot):base,extension=dot>0?base.slice(dot):'';
    let name=base,index=2;while(used.has(name.normalize('NFC').toLowerCase()))name=`${stem} (${index++})${extension}`;
    used.add(name.normalize('NFC').toLowerCase());return {name:encoder.encode(name),bytes:file.bytes,crc:crc32(file.bytes),offset:0};
  });
  const payload=entries.reduce((size,f)=>size+f.bytes.length,0),overhead=22+entries.reduce((size,f)=>size+76+f.name.length*2,0);
  if(overhead>maxOverhead)throw Error('Attachments exceed the archive limit.');
  const zip=new Uint8Array(payload+overhead),view=new DataView(zip.buffer);let offset=0;
  const u16=(n:number)=>{view.setUint16(offset,n,true);offset+=2;},u32=(n:number)=>{view.setUint32(offset,n,true);offset+=4;};
  for(const entry of entries){entry.offset=offset;u32(0x04034b50);u16(20);u16(0x800);u16(0);u16(0);u16(33);u32(entry.crc);u32(entry.bytes.length);u32(entry.bytes.length);u16(entry.name.length);u16(0);
    zip.set(entry.name,offset);offset+=entry.name.length;zip.set(entry.bytes,offset);offset+=entry.bytes.length;}
  const directoryOffset=offset;
  for(const entry of entries){u32(0x02014b50);u16(20);u16(20);u16(0x800);u16(0);u16(0);u16(33);u32(entry.crc);u32(entry.bytes.length);u32(entry.bytes.length);u16(entry.name.length);u16(0);u16(0);u16(0);u16(0);u32(0);u32(entry.offset);
    zip.set(entry.name,offset);offset+=entry.name.length;}
  const directorySize=offset-directoryOffset;u32(0x06054b50);u16(0);u16(0);u16(entries.length);u16(entries.length);u32(directorySize);u32(directoryOffset);u16(0);
  return zip;
}
