import {parseNativeSafeComposeHtml as parseSafeComposeHtml,plainTextToNativeComposeHtml,type NativeComposeOptions,type SafeComposeDocument} from '../../../../packages/app-kit/src/safe-compose-html';
export const normalizeRichText=(text:string)=>text.replace(/\r\n?/gu,'\n');
/** Opening a draft derives a view only; it never publishes normalized content. */
export function richEditorView(value:SafeComposeDocument,options:NativeComposeOptions={}):SafeComposeDocument|null{
 try{if(parseSafeComposeHtml(value.html,options).plainText!==value.plainText)return null;const next={html:normalizeRichText(value.html),plainText:normalizeRichText(value.plainText)};return next.html===value.html&&next.plainText===value.plainText?value:parseSafeComposeHtml(next.html,options).plainText===next.plainText?next:null;}catch{return null;}
}
/** This conversion is used only for the explicit Add formatting action. */
export function plainToRich(text:string):SafeComposeDocument{
 const plainText=normalizeRichText(text),html=plainTextToNativeComposeHtml(plainText)||'<p></p>';
 if(parseSafeComposeHtml(html).plainText!==plainText)throw Error('RICH_TEXT_CHANGED');return {html,plainText};
}
