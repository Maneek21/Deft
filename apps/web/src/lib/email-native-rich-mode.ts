import {parseNativeSafeComposeHtml as parseSafeComposeHtml,plainTextToNativeComposeHtml,type NativeComposeOptions,type SafeComposeDocument} from '../../../../packages/app-kit/src/safe-compose-html';
export const normalizeNativeRichText=(text:string)=>text.replace(/\r\n?/gu,'\n');
/** Opening a draft derives a view only; it never publishes normalized content. */
export function nativeRichEditorView(value:SafeComposeDocument,options:NativeComposeOptions={}):SafeComposeDocument|null{
 try{if(parseSafeComposeHtml(value.html,options).plainText!==value.plainText)return null;const next={html:normalizeNativeRichText(value.html),plainText:normalizeNativeRichText(value.plainText)};return next.html===value.html&&next.plainText===value.plainText?value:parseSafeComposeHtml(next.html,options).plainText===next.plainText?next:null;}catch{return null;}
}
/** This conversion is used only for the explicit Add formatting action. */
export function nativePlainToRich(text:string):SafeComposeDocument{
 const plainText=normalizeNativeRichText(text),html=plainTextToNativeComposeHtml(plainText)||'<p></p>';
 if(parseSafeComposeHtml(html).plainText!==plainText)throw Error('NATIVE_RICH_TEXT_CHANGED');return {html,plainText};
}
