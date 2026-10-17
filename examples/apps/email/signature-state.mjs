const valid=value=>typeof value==='string'&&value.length<=2048&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
/** One encrypted account-scoped preference, with no automatic content edits. */
export function createSignatureState(sdk,{uuid}){
 let id=null,revision=0,value='',status='Loading signature…',available=false;
 return {
  get current(){return {value,status,available};},
  async load(){
   try{const rows=(await sdk.listPrivateState('preferences')).items;
    if(rows.length>1)throw Error('AMBIGUOUS_PREFERENCE');
    if(rows.length){const row=(await sdk.readPrivateState('preferences',rows[0].record_id)).item;
     if(!row||row.record_id!==rows[0].record_id||Object.keys(row.value).join(',')!=='signature'||!valid(row.value.signature))throw Error('INVALID_PREFERENCE');
     id=row.record_id;revision=row.revision;value=row.value.signature;
    }else{id=null;revision=0;value='';}
    available=true;status='Saved signature is inserted only when you choose it.';
   }catch{available=false;status='Signature could not be loaded. Reload before editing.';}
  },
  edit(text){if(available&&valid(text)){value=text;status='Unsaved changes';}},
  async save(){if(!available||!valid(value))throw Error('INVALID_PREFERENCE');
   try{id??=uuid();const row=(await sdk.putPrivateState('preferences',id,revision,{signature:value})).item;
    if(row.record_id!==id||!Number.isSafeInteger(row.revision)||row.revision<=revision)throw Error('INVALID_PREFERENCE');
    revision=row.revision;status='Signature saved. Retained privately for up to 30 days.';
   }catch{available=false;status='Save is unconfirmed. Reload the saved signature before editing again.';}
  },
 };
}
