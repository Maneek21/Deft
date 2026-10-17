/** Browser nominations only; host reviewed fields and provider compiler remain
 * authoritative. Empty form fields do not silently become query operators. */
export function emailSearchInput(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('EMAIL_SEARCH_INPUT_INVALID');
 const fields=['text','from','to','cc','bcc','subject','filename','has_attachments','received_on','after','before','unread','flagged'],filters={};
 for(const [key,item]of Object.entries(value)){if(!fields.includes(key))throw Error('EMAIL_SEARCH_INPUT_INVALID');if(item===''||item===undefined)continue;if(['has_attachments','unread','flagged'].includes(key)){if(typeof item!=='boolean')throw Error('EMAIL_SEARCH_INPUT_INVALID');filters[key]=item;}else{if(typeof item!=='string'||item.length>500||/["\\\u0000-\u001f\u007f]/.test(item))throw Error('EMAIL_SEARCH_INPUT_INVALID');filters[key]=item.trim();}}
 if(!Object.keys(filters).length)throw Error('EMAIL_SEARCH_INPUT_INVALID');return filters;
}
