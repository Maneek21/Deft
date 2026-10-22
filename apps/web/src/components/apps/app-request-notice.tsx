import type {ReactNode} from 'react';

/** Only the bounded diagnostic suffix produced by Host formatters is folded. */
export function appRequestNoticeParts(value:string):{message:string;details?:string}{
 const suffix=/\s+\((APP_[A-Z0-9_]+(?:: [a-z_]+)?(?:; [A-Z][A-Z0-9_]+)*)\)$/u.exec(value);
 if(!suffix)return {message:value};
 const code=suffix[1].split(/[;:]/u)[0];
 const message=code==='APP_RUNTIME_UNAVAILABLE'?'The app is temporarily unavailable. Try again shortly.'
  :code==='APP_PROVIDER_UNAVAILABLE'?'The app data is temporarily unavailable. Try again shortly.':value.slice(0,suffix.index);
 return {message,details:suffix[1]};
}

export function AppRequestNotice({message,action,role='alert',className=''}:{message:string;action?:ReactNode;role?:'alert'|'status';className?:string}){
 const parts=appRequestNoticeParts(message);
 return <section className={`shrink-0 space-y-2 px-5 py-3 text-sm ${className}`} aria-label="App status">
  <p role={role} className="break-words">{parts.message}</p>
  {action&&<div>{action}</div>}
  {parts.details&&<details className="text-xs text-[var(--text-secondary)]"><summary className="min-h-11 cursor-pointer py-3">Details</summary><p className="break-words pb-2 font-mono [overflow-wrap:anywhere]">{parts.details}</p></details>}
 </section>;
}
