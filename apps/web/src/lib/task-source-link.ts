export type TaskSourceLink={href:string;label:string};
const escape=(value:string)=>value.replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export function taskDescriptionWithSource(text:string,source:TaskSourceLink){
 if(!/^\/(?!\/)/u.test(source.href)||/[\u0000-\u0020\u007f\\]/u.test(source.href)||source.href.length>2048||!source.label||source.label.length>120)throw Error('The source link is unavailable.');
 return (text.trim()?`<p>${escape(text.trim()).replace(/\r?\n/gu,'<br>')}</p>`:'')+`<p><a href="${escape(source.href)}">${escape(source.label)}</a></p>`;
}
