/** Reviewed reuse and active requests are distinct from an uncertain outcome.
 * This presentation never changes connection authority or recovery semantics. */
export function ExperienceConnectionStatus({label,state,reviewAvailable,reusePending,working}:{label:string;state?:string;reviewAvailable:boolean;reusePending:boolean;working:'review'|'activate'|'status'|null}){
 const uncertain=!working&&!reviewAvailable&&(reusePending||state==='indeterminate');
 const status=working==='activate'?'Connecting\u2026':working==='review'?'Reviewing account\u2026':working==='status'?'Checking status\u2026':reviewAvailable?'Review needed':uncertain?'Outcome uncertain':state==='connected'?'Connected':state==='awaiting_callback'?'Setup pending':state==='disconnected'?'Disconnected':'Not connected';
 return <><p className="break-words text-sm">{label} {'\u00b7'} {status}</p>{uncertain&&<p className="text-sm">The previous attempt has an uncertain outcome. It will not be started again automatically.</p>}</>;
}
