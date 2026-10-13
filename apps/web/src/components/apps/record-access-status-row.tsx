export function RecordAccessStatusRow({label,storeKey,active,busy,onReview}:{label:string;storeKey:string;active:boolean;busy:boolean;onReview:()=>void}){
 return <div className="flex flex-wrap items-center justify-between gap-2"><span>{label} {'\u00b7'} {storeKey.replaceAll('_',' ')} {active?'access enabled':'access needed to save'}</span>
  {!active&&<button type="button" className="deft-pill min-h-10 px-3" disabled={busy} onClick={onReview}>Review private record access</button>}</div>;
}
