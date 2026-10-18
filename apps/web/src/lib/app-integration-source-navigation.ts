export function appIntegrationSourceHref(value:unknown):string|null{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1)return null;
 const href=(value as {href?:unknown}).href;if(typeof href!=='string'||href.length>2048||/[\\\u0000-\u001f\u007f]/u.test(href))return null;
 const url=new URL(href,'https://deft.invalid');
 if(!href.startsWith('/')||href.startsWith('//')||url.origin!=='https://deft.invalid'||url.hash)return null;
 if(/^\/apps\/recovery\/native-email\/[A-Za-z0-9_-]{1,256}$/u.test(url.pathname)){if([...url.searchParams.keys()].join(',')!=='message'||!/^mail_[a-f0-9]{64}$/u.test(url.searchParams.get('message')??'')||url.search!=='?message='+url.searchParams.get('message'))return null;return url.pathname+url.search;}
 if(!/^\/apps\/[0-9a-f-]{36}\/[a-z][a-z0-9_]{0,47}$/u.test(url.pathname))return null;
 if([...url.searchParams.keys()].sort().join(',')!=='account_ref,source_digest,source_record_id,source_resource_key,source_store_key')return null;
 if(!/^[A-Za-z0-9_-]{1,512}$/u.test(url.searchParams.get('account_ref')??'')||!/^sha256:[a-f0-9]{64}$/u.test(url.searchParams.get('source_digest')??'')||! /^[0-9a-f-]{36}$/u.test(url.searchParams.get('source_record_id')??''))return null;
 for(const field of ['source_store_key','source_resource_key']){const key=url.searchParams.get(field)??'';if(!/^[a-z][a-z0-9_]{0,47}$/u.test(key)||['constructor','prototype','__proto__'].includes(key))return null;}
 return url.pathname+url.search;
}
