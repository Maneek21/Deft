/** Shorten passive feedback without suppressing errors or uncertain outcomes. */
export function nativeComposeFeedback(notice:string,originalFileControls=false){
 let text=notice;if(originalFileControls)text=text.replace('Original attachments are not included until you choose Include selected originals.','');
 return text.replace('Review the recipients and message before sending.','Review before sending.').replace(/\s+/gu,' ').trim();
}
export function nativeSignatureFeedback(notice:string){
 if(notice.startsWith('Signature preferences loaded.'))return '';
 return notice==='Saved signature added. Review it before sending.'?'Signature added.':notice;
}
export const nativeSendCancelledNotice='Send cancelled. Your draft is ready to edit.';
