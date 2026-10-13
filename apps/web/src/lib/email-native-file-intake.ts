/** Native local-file intake only. Clipboard HTML/URLs never become file fetches. */
export type NativeFileIntake={kind:'none'|'files'|'mixed'|'unsupported';files:File[]};
export function readNativeFileIntake(value:DataTransfer|null,kind:'paste'|'drop'):NativeFileIntake{
 if(!value)return {kind:'none',files:[]};
 const items=Array.from(value.items??[]),files=Array.from(value.files??[]);
 const hasFiles=files.length>0||items.some(item=>item.kind==='file')||Array.from(value.types??[]).includes('Files');
 if(!hasFiles)return {kind:'none',files:[]};
 if(kind==='paste'&&(value.getData('text/plain')||'').length>0)return {kind:'mixed',files:[]};
 if(items.some(item=>item.kind==='file'&&item.webkitGetAsEntry?.()?.isDirectory))return {kind:'unsupported',files:[]};
 if(!files.length||files.length>32)return {kind:'unsupported',files:[]};
 return {kind:'files',files};
}
export const nativeMixedFilePasteNotice='This clipboard also contains files. Paste keeps the text; use file-only paste or Attach files to add the files.';
