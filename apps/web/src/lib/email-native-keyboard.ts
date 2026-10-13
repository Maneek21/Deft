export type NativeEmailShortcut='compose'|'search'|'next'|'previous'|'open'|'reply';
type KeyEvent={key:string;defaultPrevented:boolean;isComposing?:boolean;keyCode?:number;repeat?:boolean;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean;target:EventTarget|null};
/** Called on window after Deft's document-level navigation chords. Never
 * consumes typing, modifiers, IME events, dialogs or open menus. */
export function nativeEmailShortcut(event:KeyEvent,blocked:{dialog?:boolean;menu?:boolean}={}):NativeEmailShortcut|null{
 if(event.defaultPrevented||event.isComposing||event.keyCode===229||event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||blocked.dialog||blocked.menu)return null;
 const target=event.target as HTMLElement|null;
 if(target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="textbox"], [role="dialog"], [aria-modal="true"]'))return null;
 if(event.key==='Enter')return target?.closest?.('[data-email-message]')?'open':null;
 return ({c:'compose','/':'search',j:'next',k:'previous',r:'reply'} as const)[event.key.toLowerCase() as 'c'|'/'|'j'|'k'|'r']??null;
}
export function nativeEmailFocusIndex(current:number,direction:'next'|'previous',length:number):number|null{
 if(!Number.isSafeInteger(length)||length<1||!Number.isSafeInteger(current)||current<-1||current>=length)return null;
 if(current===-1)return direction==='next'?0:length-1;
 return Math.max(0,Math.min(length-1,current+(direction==='next'?1:-1)));
}
/** Escape belongs to the currently open reader menu, never an active dialog. */
export function dismissNativeReaderMenu(event:{key:string;defaultPrevented:boolean;preventDefault:()=>void;stopPropagation:()=>void;currentTarget:EventTarget|null},dialogOpen:boolean):boolean{
 const menu=event.currentTarget as HTMLDetailsElement|null;
 if(event.key!=='Escape'||event.defaultPrevented||dialogOpen||!menu?.open)return false;
 event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus();return true;
}
