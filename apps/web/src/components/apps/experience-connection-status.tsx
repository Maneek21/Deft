/** Reviewed reuse and active requests are distinct from an uncertain outcome.
 * This presentation never changes connection authority or recovery semantics. */
import type { AppNextStep, AppNextStepKind } from '@/lib/app-request-error';

const NEXT_STEP_LABEL: Readonly<Record<AppNextStepKind, string>> = {
  restore_access: 'Restore access',
  reconnect: 'Reconnect',
  review_consent: 'Review access',
};

export function ExperienceConnectionStatus({label,state,reviewAvailable,reusePending,working,nextStep}:{label:string;state?:string;reviewAvailable:boolean;reusePending:boolean;working:'review'|'activate'|'status'|'close'|null;nextStep?:AppNextStep}){
  const reviewUnconfirmed=reusePending&&!state;
  const uncertain=!working&&!reviewAvailable&&!nextStep&&(reusePending||state==='indeterminate');
  const status=working==='close'?'Closing unstarted review\u2026':working==='activate'?'Connecting\u2026':working==='review'?'Reviewing account\u2026':working==='status'?'Checking status\u2026':reviewAvailable?'Review needed':nextStep?NEXT_STEP_LABEL[nextStep.kind]:reviewUnconfirmed?'Review status unconfirmed':uncertain?'Outcome uncertain':state==='connected'?'Connected':state==='awaiting_callback'?'Setup pending':state==='disconnected'?'Disconnected':'Not connected';
  return <><p className="break-words text-sm">{label} {'\u00b7'} {status}</p>{uncertain&&<p className="text-sm">{reviewUnconfirmed?'The account reuse review could not be confirmed. Check status before continuing. No new setup will start automatically.':'The previous attempt has an uncertain outcome. It will not be started again automatically.'}</p>}</>;
}
