import {parseTrustedRichtextHtml as parseBasicRichtextHtml,plainTextToRichtextHtml,type RichtextOptions,type SafeRichtextDocument} from '../../../../packages/app-kit/src/safe-rich-text';
export const normalizeRichText=(text:string)=>text.replace(/\r\n?/gu,'\n');
/** Opening a draft derives a view only; it never publishes normalized content. */
export function richEditorView(value:SafeRichtextDocument,options:RichtextOptions={}):SafeRichtextDocument|null{
 try{if(parseBasicRichtextHtml(value.html,options).plainText!==value.plainText)return null;const next={html:normalizeRichText(value.html),plainText:normalizeRichText(value.plainText)};return next.html===value.html&&next.plainText===value.plainText?value:parseBasicRichtextHtml(next.html,options).plainText===next.plainText?next:null;}catch{return null;}
}
/** This conversion is used only for the explicit Add formatting action. */
export function plainToRich(text:string):SafeRichtextDocument{
 const plainText=normalizeRichText(text),html=plainTextToRichtextHtml(plainText)||'<p></p>';
 if(parseBasicRichtextHtml(html).plainText!==plainText)throw Error('RICH_TEXT_CHANGED');return {html,plainText};
}
