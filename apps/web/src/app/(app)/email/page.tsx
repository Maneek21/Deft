'use client';
import {Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowLeft,ChevronRight,Mail,RefreshCw,Search,Settings2,SquarePen,X} from 'lucide-react';
import {api,isSameWebSession} from '@/lib/api';
import {useAuth} from '@/lib/auth-context';
import {NativeEmailSelection} from '@/components/email/native-email-selection';
import {NativeEmailSearchHelp,nativeSearchUnsupportedReason} from '@/components/email/native-email-search-help';
import {NativeEmailReader} from '@/components/email/native-email-reader';
import {NativeEmailConversation} from '@/components/email/native-email-conversation';
import {NativeEmailDraftSyncSettings} from '@/components/email/native-email-draft-sync-settings';
import {NativeEmailImapSetup} from '@/components/email/native-email-imap-setup';
import {NativeEmailTemplates} from '@/components/email/native-email-templates';
import {NativeEmailSignatures} from '@/components/email/native-email-signatures';
import {NativeEmailSentCopySettings} from '@/components/email/native-email-sent-copy-settings';
import {NativeEmailKnowledgeSettings} from '@/components/email/native-email-knowledge-settings';
import {NativeEmailAgentAccess} from '@/components/email/native-email-agent-access';
import {NativeEmailMessageTimers,NativeEmailTimers,nativeTimerExplanation} from '@/components/email/native-email-timers';
import {NativeEmailComposePresentation,type NativeComposePresentation,type NativeComposePresentationSummary,type NativeComposePresentationHandle} from '@/components/email/native-email-compose-presentation';
import {NativeEmailMessageLink} from '@/components/email/native-email-message-link';
import {nativeMessageUrl,createNativeMessageSummary,readNativeAffectedSummaries,NativeSummaryError} from '@/lib/email-native-message-links';
import {NativeEmailRules} from '@/components/email/native-email-rules';
import {NativeEmailMailto,NativeEmailMailtoSettings} from '@/components/email/native-email-mailto';
import {NativeEmailUnread,NativeEmailNotificationsInfo} from '@/components/email/native-email-unread';
import {NativeEmailTaskAction} from '@/components/email/native-email-task-action';
import {nativeUnreadScopeKey,type NativeUnreadDisplay} from '@/lib/email-native-unread';
import {nativeEmailShortcut,nativeEmailFocusIndex} from '@/lib/email-native-keyboard';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {NativeEmailRetainedConnections} from '@/components/email/native-email-retained-connections';
import {NativeEmailDirectConnections} from '@/components/email/native-email-direct-connections';
import type {DirectEmailReconnect} from '@/lib/email-native-direct-connections';
import {NativeEmailComposer,type NativeComposeSelection} from '@/components/email/native-email-composer';
import {NativeEmailAccountManagement} from '@/components/email/native-email-account-lifecycle';
import {NativeEmailAccountPreferences} from '@/components/email/native-email-account-preferences';
import {NativeEmailDraftLink} from '@/components/email/native-email-draft-link';
import {NativeEmailDrafts} from '@/components/email/native-email-drafts';
import {NativeEmailOutbox} from '@/components/email/native-email-outbox';
import {NativeEmailActions,NativeEmailSecondaryActions,nativeEmailModificationNotice,nativeEmailRecoveryActions} from '@/components/email/native-email-actions';
import {NativeEmailFolderPicker} from '@/components/email/native-email-folder-picker';
import {NativeEmailFolderManagement} from '@/components/email/native-email-folder-management';
import type {NativeFolderManageState} from '@/lib/email-native-folder-management';
import {NativeEmailLabelPicker} from '@/components/email/native-email-label-picker';
import {NativeEmailActionStatus} from '@/components/email/native-email-action-status';
import {createNativeEmailTriage,type NativeTriageKind,type NativeTriageState,type NativeTriageTarget,type NativeTriageSelection} from '@/lib/email-native-triage';
import {createNativeFolderProjection,nativeTriageFeedbackVisible,type NativeFolderAcknowledgement} from '@/lib/email-native-folder-projection';
import {nativeMailboxRefreshBudget} from '@/lib/email-native-mailbox-refresh';
import {createNativeEmailFolders,nativeFolderLabel,type NativeFolder,type NativeFolderState} from '@/lib/email-native-folders';
import {EmailReadingSettings} from '@/components/apps/email-reading-settings';
import {createNativeEmailSearch,parseNativeEmailMessage,reconcileNativeEmailSearchState,nativeSearchUnsupported,type NativeEmailMessage,type NativeSearchState} from '@/lib/email-native-search';
import {useExperienceNavigation} from '@/components/apps/experience-navigation-context';
import Link from 'next/link';
const ignoreBusy=(_busy:boolean)=>{};

type Account={account_id:string;provider:string;primary_address:string;display_label:string;capabilities?:string[]};
type Message=NativeEmailMessage;
type Page={items:Message[];next_cursor:string|null;coverage:'complete'|'partial';count:{exact_total:number|null};checkpoint_revision?:number;sync_state?:'idle'|'queued'|'syncing'|'failed'|'paused';accounts?:{account_id:string;checkpoint_revision:number|null;state:string;sync_state?:'idle'|'queued'|'syncing'|'failed'|'paused';error?:string|null}[]};
const folders=[['inbox','Inbox'],['drafts','Drafts'],['outbox','Outbox'],['snooze','Snoozed'],['follow_up','Follow-ups'],['sent','Sent'],['archive','Archive'],['starred','Starred'],['spam','Spam'],['trash','Trash'],['all','All mail']] as const;
const localView=(folder:string)=>['drafts','outbox','snooze','follow_up'].includes(folder);
class MailAccessChanged extends Error {constructor(){super('Mailbox access changed. Open Email settings to reconnect.');}}
const messageKey=(row:Pick<Message,'account_id'|'logical_message_id'>)=>row.account_id+'/'+row.logical_message_id;
const pause=(signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const aborted=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},2500);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();});

/** First-party owner mailbox host. The App Experience remains separately
 * available while native compose and organization are being integrated. */
export default function EmailPage(){
 const {sessionCacheScope,user,org}=useAuth();
 return sessionCacheScope?<Mailbox key={sessionCacheScope} sessionScope={sessionCacheScope} recoveryOwner={user&&org?{userId:user.id,orgId:org.id}:null}/>:null;
}
function Mailbox({sessionScope,recoveryOwner}:{sessionScope:string;recoveryOwner:{orgId:string;userId:string}|null}){
 const router=useRouter(),readerSurface=useRef<HTMLElement|null>(null);
 const searchInput=useRef<HTMLInputElement|null>(null),messageButtons=useRef<Map<string,HTMLButtonElement>>(new Map()),focusNewCompose=useRef(false);
 const {publishNativeEmailNavigation,clearNativeEmailNavigation}=useExperienceNavigation();
 const [navigationOwner]=useState(()=>Symbol('native-email-navigation'));
 const [accounts,setAccounts]=useState<Account[]>([]),[account,setAccount]=useState('all'),[folder,setFolder]=useState('inbox');
 const [page,setPage]=useState<Page|null>(null),[selected,setSelected]=useState<Message|null>(null),[settings,setSettings]=useState(false);
 const [conversationAnchor,setConversationAnchor]=useState<Message|null>(null);
 const [timerTarget,setTimerTarget]=useState<{account_id:string;logical_message_id:string}|null>(null),[timerRevision,setTimerRevision]=useState(0);
 const [composer,setComposer]=useState<NativeComposeSelection|null>(null),[draftRevision,setDraftRevision]=useState(0);
 const [composePresentation,setComposePresentation]=useState<NativeComposePresentation>('normal'),[composeSummary,setComposeSummary]=useState<{owner:string;value:NativeComposePresentationSummary}|null>(null),[composeClose,setComposeClose]=useState<{owner:string;value:NativeComposePresentationHandle}|null>(null);const composeOwner=JSON.stringify([sessionScope,composer?.accountId,composer?.draftId??null]),composeOwnerRef=useRef(composeOwner);composeOwnerRef.current=composeOwner;const visibleComposer=!!composer&&composePresentation!=='minimized';
 const [accountReload,setAccountReload]=useState(0);
 const [unread,setUnread]=useState<{key:string;display:NativeUnreadDisplay}|null>(null),[unreadRevision,setUnreadRevision]=useState(0);
 const [reconnect,setReconnect]=useState<DirectEmailReconnect|null>(null);
 const [folderScope,setFolderScope]=useState<{accountId:string;label:string}|null>(null),[folderCatalogue,setFolderCatalogue]=useState<NativeFolderState|null>(null),[folderReload,setFolderReload]=useState(0);
 const folderManagementRecovery=useRef(new Map<string,NativeFolderManageState>());
 const [selectionMode,setSelectionMode]=useState(false);
 const [picked,setPicked]=useState<Set<string>>(()=>new Set()),[triageState,setTriageState]=useState<NativeTriageState|null>(null),[moveTargets,setMoveTargets]=useState<Message[]|null>(null);
 const [labelTargets,setLabelTargets]=useState<{messages:Message[];returnFocus:HTMLElement|null;scope:string}|null>(null);
 const triage=useRef<ReturnType<typeof createNativeEmailTriage>|null>(null),folderController=useRef<ReturnType<typeof createNativeEmailFolders>|null>(null),afterActionRefresh=useRef<(accounts?:string[],targets?:NativeTriageTarget[],acknowledgements?:NativeFolderAcknowledgement[])=>Promise<void>>(async()=>{});
 const [busy,setBusy]=useState(false),[mailboxNotice,setMailboxNotice]=useState<{message:string;kind:'general'|'mutation_pending'|'mutation_success'|'mutation_attention'}>({message:'',kind:'general'}),[discovery,setDiscovery]=useState(true),[refreshing,setRefreshing]=useState(false);
 const setNotice=(message:string,kind:typeof mailboxNotice.kind='general')=>setMailboxNotice({message,kind});
 const notice=mailboxNotice.message;
 const [linkNotice,setLinkNotice]=useState('');
 const [searchOpen,setSearchOpen]=useState(false),[query,setQuery]=useState(''),[searchState,setSearchState]=useState<NativeSearchState|null>(null);
 const searching=!!searchState;
 const searchRowsRef=useRef(searchState);searchRowsRef.current=searchState;
 const searchController=useRef<ReturnType<typeof createNativeEmailSearch>|null>(null),searchGeneration=useRef(0);
 const pending=useRef<AbortController|null>(null),refresh=useRef<AbortController|null>(null),generation=useRef(0);
 const selectedRef=useRef(selected);selectedRef.current=selected;
 const folderProjection=useRef<ReturnType<typeof createNativeFolderProjection>|null>(null),actionView=useRef<string|null>(null),actionOperations=useRef(''),[feedbackView,setFeedbackView]=useState<string|null>(null);
 const readerIdentity=JSON.stringify([settings?'settings':visibleComposer?'compose':'message',composer?.accountId,composer?.draftId??(composer?'new':null),selected?.account_id,selected?.logical_message_id,timerTarget?.account_id,timerTarget?.logical_message_id]);
 useEffect(()=>{readerSurface.current?.scrollTo({top:0});},[readerIdentity]);
 const mailboxAccounts=accounts.filter(row=>account==='all'||row.account_id===account);
 const unreadIds=mailboxAccounts.map(row=>row.account_id),unreadKey=nativeUnreadScopeKey(unreadIds);
 const scopeAccounts=folderScope?mailboxAccounts.filter(row=>row.account_id===folderScope.accountId):mailboxAccounts;
 const ids=scopeAccounts.map(row=>row.account_id),scopeKey=JSON.stringify([ids,folder]);
 const accountScopeKey=JSON.stringify(ids),catalogueScopeKey=JSON.stringify(mailboxAccounts.map(row=>row.account_id));
 const labelScopeKey=JSON.stringify([sessionScope,accountScopeKey,folder,searchState?.query??null,settings,readerIdentity]),labelScope=useRef(labelScopeKey);labelScope.current=labelScopeKey;
 const actionViewKey=JSON.stringify([sessionScope,scopeKey,searchState?.query??null]),viewScope=useRef(actionViewKey);viewScope.current=actionViewKey;
 const publishFolderRow=(row:Message)=>{setPage(previous=>previous?{...previous,items:previous.items.map(old=>messageKey(old)===messageKey(row)?row:old)}:null);if(!searchController.current?.reconcile([row]))setSearchState(previous=>previous?reconcileNativeEmailSearchState(previous,[row]):null);if(selectedRef.current&&messageKey(selectedRef.current)===messageKey(row)){selectedRef.current=row;setSelected(row);}};
 const publishFolderRef=useRef(publishFolderRow);publishFolderRef.current=publishFolderRow;
 const denied=useCallback((accountId:string)=>{folderProjection.current?.revoke(accountId);folderManagementRecovery.current.delete(accountId);searchController.current?.revoke(accountId);if(selectedRef.current?.account_id===accountId)selectedRef.current=null;setSelected(previous=>previous?.account_id===accountId?null:previous);setTimerTarget(previous=>previous?.account_id===accountId?null:previous);setPage(previous=>previous?{...previous,items:previous.items.filter(row=>row.account_id!==accountId)}:null);setSearchState(previous=>previous?{...previous,items:previous.items.filter(row=>row.account_id!==accountId),accounts:previous.accounts.map(row=>row.accountId===accountId?{...row,state:'denied',items:[],nextCursor:null,complete:false,error:'Account access changed.'}:row),complete:false}:null);setComposer(previous=>previous?.accountId===accountId?null:previous);setPicked(new Set());setSelectionMode(false);setMoveTargets(null);setLabelTargets(null);},[]);
 useEffect(()=>{const anchor=api.getAccessToken();let active=true;const current=()=>active&&isSameWebSession(anchor,api.getAccessToken()),summary=createNativeMessageSummary({current,fetch:(path,options)=>api.fetch(path,options)});
  const value=createNativeFolderProjection({current,selected:()=>selectedRef.current,read:(target,signal)=>summary.read(target,signal),publish:row=>publishFolderRef.current(row),denied,
   expired:target=>{if(typeof window!=='undefined'){const params=new URLSearchParams(window.location.search);if(params.get('account')===target.account_id&&params.get('message')===target.logical_message_id)router.replace('/email',{scroll:false});}const chosen=selectedRef.current;if(chosen&&messageKey(chosen)===messageKey(target)){selectedRef.current=null;setSelected(null);setNotice('Folder changed. Reopen the message to load its current state.');}}});folderProjection.current=value;value.setScope(viewScope.current);
  return()=>{active=false;value.dispose();summary.dispose();if(folderProjection.current===value)folderProjection.current=null;};},[accountScopeKey,sessionScope,denied]);
 useEffect(()=>{folderProjection.current?.setScope(actionViewKey);},[actionViewKey]);
 useEffect(()=>{folderProjection.current?.selected();},[selected?.account_id,selected?.logical_message_id]);
 useEffect(()=>{const anchor=api.getAccessToken();let active=true;const value=createNativeEmailTriage({current:()=>active&&isSameWebSession(anchor,api.getAccessToken()),fetch:(path,options)=>api.fetch(path,options),change:state=>{
  const operations=state.groups.map(group=>group.operationId).join('/');if(state.groups.some(group=>group.state==='pending')&&operations!==actionOperations.current){refresh.current?.abort();refresh.current=null;setRefreshing(false);actionOperations.current=operations;actionView.current=viewScope.current;setFeedbackView(viewScope.current);}folderProjection.current?.begin(viewScope.current,state.groups);setTriageState(state);
 },denied,succeeded:(affected,targets,acknowledgements)=>{if(actionView.current!==viewScope.current)return;folderProjection.current?.acknowledge(viewScope.current,acknowledgements);const observe=(row:Message)=>folderProjection.current?.observe(row)??row;setPage(previous=>previous?{...previous,items:previous.items.map(observe)}:null);const search=searchRowsRef.current;if(search&&!searchController.current?.reconcile(search.items.map(observe)))setSearchState(previous=>previous?reconcileNativeEmailSearchState(previous,previous.items.map(observe)):null);const chosen=selectedRef.current;if(chosen){const projected=observe(chosen);if(projected!==chosen){selectedRef.current=projected;setSelected(projected);}}setPicked(new Set());setSelectionMode(false);void afterActionRefresh.current(affected,targets,acknowledgements);}});triage.current=value;setTriageState(null);actionOperations.current='';actionView.current=null;setFeedbackView(null);return()=>{active=false;value.dispose();triage.current=null;};},[accountScopeKey,sessionScope,denied]);
 useEffect(()=>{const selectedIds=JSON.parse(catalogueScopeKey) as string[];if(!selectedIds.length)return;const anchor=api.getAccessToken();let active=true;const value=createNativeEmailFolders({accountIds:selectedIds,current:()=>active&&isSameWebSession(anchor,api.getAccessToken()),fetch:(path,options)=>api.fetch(path,options),change:setFolderCatalogue,denied});folderController.current=value;void value.start();return()=>{active=false;value.dispose();folderController.current=null;};},[catalogueScopeKey,sessionScope,denied,folderReload]);
 useEffect(()=>{
  const controller=new AbortController(),anchor=api.getAccessToken();let active=true;
  const current=()=>active&&!controller.signal.aborted&&isSameWebSession(anchor,api.getAccessToken());
  void api.fetch('/api/email/accounts',{signal:controller.signal}).then(async response=>{
   if(!response.ok)throw Error(response.status===404?'Native Email is not enabled on this instance yet.':'Accounts could not be loaded.');
   const value=await response.json();if(!current())return;
   if(!Array.isArray(value.accounts)||value.accounts.length>16||value.accounts.some((row:Account)=>typeof row.account_id!=='string'||typeof row.primary_address!=='string'||(row.capabilities!==undefined&&(!Array.isArray(row.capabilities)||row.capabilities.length>32||row.capabilities.some(capability=>typeof capability!=='string')))))throw Error('Accounts could not be loaded.');
   setAccounts(value.accounts);if(value.has_more)setNotice('Only the first 16 connected accounts are shown.');else if(value.unavailable_count)setNotice('Some account connections need attention in Email settings.');
  }).catch(error=>{if(current())setNotice(error instanceof Error?error.message:'Accounts could not be loaded.');}).finally(()=>{if(current())setDiscovery(false);});
  return()=>{active=false;controller.abort();pending.current?.abort();refresh.current?.abort();searchController.current?.dispose();};
 },[sessionScope,accountReload]);
 const read=useCallback(async(cursor:string|null,signal:AbortSignal):Promise<Page>=>{
  const selectedIds=JSON.parse(scopeKey)[0] as string[];
  const response=selectedIds.length>1
   ?await api.fetch('/api/email/messages/query',{method:'POST',signal,body:JSON.stringify({account_ids:selectedIds,folder,limit:50,cursor,include_total:false})})
   :await api.fetch(`/api/email/accounts/${encodeURIComponent(selectedIds[0])}/messages?folder=${encodeURIComponent(folder)}&limit=50&include_total=false${cursor?'&cursor='+encodeURIComponent(cursor):''}`,{signal});
  if([401,403].includes(response.status))throw new MailAccessChanged();
  if(!response.ok)throw Error('Messages could not be loaded. Try Refresh.');
  const value=await response.json();signal.throwIfAborted();
  if(!Array.isArray(value.items)||value.items.length>50||!['complete','partial'].includes(value.coverage)||!(value.next_cursor===null||typeof value.next_cursor==='string'))throw Error('Messages could not be loaded.');
  const items=value.items.map((row:Message)=>parseNativeEmailMessage(row,row.account_id??selectedIds[0]));
  if(items.some((row:Message)=>!selectedIds.includes(row.account_id)))throw Error('Messages could not be loaded.');
  return {...value,items};
 },[scopeKey,folder]);
 const load=useCallback(async(cursor:string|null=null)=>{
  if(localView(folder)||!(JSON.parse(scopeKey)[0] as string[]).length)return;
  pending.current?.abort();const controller=new AbortController();pending.current=controller;const ticket=++generation.current,anchor=api.getAccessToken();setBusy(true);
  const current=()=>generation.current===ticket&&!controller.signal.aborted&&isSameWebSession(anchor,api.getAccessToken());
  try{const result=await read(cursor,controller.signal);if(!current())return;result.items=result.items.map(row=>folderProjection.current?.observe(row,true)??row);
   setPage(previous=>cursor&&previous?{...result,items:[...previous.items,...result.items.filter(row=>!previous.items.some(old=>messageKey(old)===messageKey(row)))]}:result);
   const chosen=selectedRef.current;if(chosen){if(result.accounts?.some(row=>row.account_id===chosen.account_id&&row.error==='access_denied'))setSelected(null);const next=result.items.find(row=>messageKey(row)===messageKey(chosen));if(next)setSelected(next);}
   setNotice(result.coverage==='partial'?'Mailbox sync is still catching up.':'');
  }catch(error){if(current()){if(error instanceof MailAccessChanged){setSelected(null);setPage(null);}setNotice(error instanceof Error?error.message:'Messages could not be loaded.');}}finally{if(current())setBusy(false);}
 },[read,scopeKey,folder]);
 useEffect(()=>{setNotice('');setPage(null);setSelected(null);setTimerTarget(null);setConversationAnchor(null);setPicked(new Set());setSelectionMode(false);setMoveTargets(null);refresh.current?.abort();setRefreshing(false);searchController.current?.dispose();searchGeneration.current++;
  setSearchState(null);setSearchOpen(false);setQuery('');void load();return()=>{pending.current?.abort();refresh.current?.abort();searchController.current?.dispose();};},[load]);
 useEffect(()=>{
  const custom=folderCatalogue?.accounts.flatMap(row=>row.items.filter(value=>/^(label|folder):/.test(value.folder_id)).map(value=>({accountId:row.accountId,...value,label:nativeFolderLabel(value,row.items),disabled:row.state!=='available'||folderCatalogue.busy})))??[];
  const customItems=custom.slice(0,20).map(value=>({kind:'button' as const,id:'folder/'+JSON.stringify([value.accountId,value.folder_id]),label:(mailboxAccounts.length>1?(accounts.find(row=>row.account_id===value.accountId)?.primary_address??'Account')+' · ':'')+value.label,variant:'ghost' as const,disabled:value.disabled,selected:folder===value.folder_id&&folderScope?.accountId===value.accountId&&!settings&&!searching}));
  publishNativeEmailNavigation({owner:navigationOwner,pathname:'/email',scope:sessionScope,unread:unread?.key===unreadKey?{inbox:unread.display}:undefined,items:[
    ...folders.map(([key,label])=>({kind:'button' as const,id:key,label,variant:'ghost' as const,selected:folder===key&&!folderScope&&!settings&&!searching})),...customItems,
    {kind:'button',id:'folder-catalogue',label:'Other folders',variant:'ghost',selected:false},
    {kind:'button',id:'settings',label:'Email settings',variant:'ghost',selected:settings}],
    select:id=>{if(id==='settings'||id==='folder-catalogue'){setSettings(true);return;}const customFolder=custom.find(value=>'folder/'+JSON.stringify([value.accountId,value.folder_id])===id);if(folders.some(([key])=>key===id)||customFolder){
      folderProjection.current?.reset();actionView.current=null;setFeedbackView(null);router.replace('/email',{scroll:false});searchGeneration.current++;searchController.current?.dispose();setNotice('');setSearchState(null);setSearchOpen(false);setQuery('');setSelected(null);setTimerTarget(null);selectedRef.current=null;
      pending.current?.abort();refresh.current?.abort();setRefreshing(false);setFolderScope(customFolder?{accountId:customFolder.accountId,label:customFolder.label}:null);setFolder(customFolder?.folder_id??id);setSettings(false);
    }}});
  return()=>clearNativeEmailNavigation(navigationOwner);
 },[folder,folderScope,folderCatalogue,accounts,mailboxAccounts.length,settings,searching,sessionScope,navigationOwner,publishNativeEmailNavigation,clearNativeEmailNavigation,router,unread,unreadKey]);
 const runSearch=async(originalQuery=query,retain=false)=>{
  if(!ids.length)return;if(!retain||originalQuery!==searchState?.query){folderProjection.current?.reset();actionView.current=null;setFeedbackView(null);}searchController.current?.dispose();pending.current?.abort();refresh.current?.abort();setRefreshing(false);setBusy(false);
  if(!retain)router.replace('/email',{scroll:false});
  const ticket=++searchGeneration.current,anchor=api.getAccessToken();setNotice('');setSearchOpen(true);if(!retain)setSelected(null);
  const current=()=>ticket===searchGeneration.current&&isSameWebSession(anchor,api.getAccessToken());
  try{
   const controller=createNativeEmailSearch({accountIds:ids,query:originalQuery,previous:retain?searchState:null,current,fetch:(path,options)=>api.fetch(path,options),
    denied:accountId=>{if(current())denied(accountId);},
    change:incoming=>{if(!current())return;const value=reconcileNativeEmailSearchState(incoming,incoming.items.map(row=>folderProjection.current?.observe(row)??row));setSearchState(value);const chosen=selectedRef.current;
      if(retain&&chosen){const next=value.items.find(row=>messageKey(row)===messageKey(chosen));if(next)setSelected(next);
        else if(value.accounts.some(row=>row.accountId===chosen.account_id&&row.state==='available'&&row.complete&&!row.limited))setSelected(null);}}});
   searchController.current=controller;await controller.start();
  }catch(error){if(current())setNotice(error instanceof Error?error.message:'Search is unavailable.');}
 };
 const closeSearch=()=>{folderProjection.current?.reset();actionView.current=null;setFeedbackView(null);router.replace('/email',{scroll:false});searchGeneration.current++;searchController.current?.dispose();searchController.current=null;setSearchState(null);setSearchOpen(false);setQuery('');setSelected(null);setNotice('');};
 const refreshMailbox=async(afterMutation=false,affectedAccounts=ids,affectedTargets:NativeTriageTarget[]=[],folderAcknowledgements:NativeFolderAcknowledgement[]=[])=>{
  const refreshIds=afterMutation?ids.filter(id=>affectedAccounts.includes(id)):ids;
  setUnreadRevision(value=>value+1);
  if(localView(folder)){setDraftRevision(value=>value+1);setTimerRevision(value=>value+1);if(!afterMutation)return;}
  if(!refreshIds.length)return;
  if(searchState&&!afterMutation){await runSearch(searchState.query,true);return;}
  if(afterMutation){pending.current?.abort();setBusy(false);refresh.current?.abort();}else if(refreshing||refresh.current&&!refresh.current.signal.aborted)return;const controller=new AbortController(),anchor=api.getAccessToken(),ownedView=viewScope.current,budget=nativeMailboxRefreshBudget(controller.signal);refresh.current=controller;setRefreshing(true);setNotice(afterMutation?'Updating message details…':'Requesting mailbox refresh…',afterMutation&&affectedTargets.length?'mutation_pending':'general');
  const current=()=>refresh.current===controller&&!controller.signal.aborted&&ownedView===viewScope.current&&isSameWebSession(anchor,api.getAccessToken());
  try{
   if(afterMutation){
    // The acknowledged action already requested durable provider sync. Current
    // cache metadata is independently readable even when that job failed.
    const result=localView(folder)?null:await budget.run(signal=>read(null,signal));if(!current())return;if(result)result.items=result.items.map(row=>folderProjection.current?.observe(row,true)??row);
    const deniedAccounts=new Set<string>();for(const row of result?.accounts??[])if(row.error==='access_denied'){deniedAccounts.add(row.account_id);denied(row.account_id);}
    let chosen=selectedRef.current,next=result?.items.find(row=>chosen&&messageKey(row)===messageKey(chosen)),summaryFailed=false;
    if(chosen&&!folderAcknowledgements.some(ack=>messageKey(ack)===messageKey(chosen!))&&refreshIds.includes(chosen.account_id)&&(!affectedTargets.length||affectedTargets.some(target=>target.account_id===chosen?.account_id&&target.logical_message_id===chosen?.logical_message_id))){
     const summary=createNativeMessageSummary({current,fetch:(path,init)=>api.fetch(path,init)});
     try{const target=chosen;next=await budget.run(signal=>summary.read(target,signal));next=folderProjection.current?.observe(next,true)??next;const observed=selectedRef.current;
      if(current()&&observed&&observed!==target&&messageKey(observed)===messageKey(target)){chosen=observed;next=await budget.run(signal=>summary.read(observed,signal));next=folderProjection.current?.observe(next,true)??next;}
     }catch(error){if(!current())return;if(error instanceof NativeSummaryError&&[401,403].includes(error.status)){denied(chosen.account_id);return;}summaryFailed=true;}
     finally{summary.dispose();}
    }
    if(!current())return;const fresh=next?folderProjection.current?.observe(next)??next:next,details:Message[]=[];
    const targets=affectedTargets.filter(target=>!folderAcknowledgements.some(ack=>messageKey(ack)===messageKey(target))&&refreshIds.includes(target.account_id)&&!deniedAccounts.has(target.account_id)
      &&searchState?.accounts.some(row=>row.accountId===target.account_id&&row.state!=='denied')
      &&searchState.items.some(row=>messageKey(row)===messageKey(target))
      &&!result?.items.some(row=>messageKey(row)===messageKey(target))&&(!chosen||messageKey(chosen)!==messageKey(target)));
    if(targets.length){const summaries=createNativeMessageSummary({current,fetch:(path,init)=>api.fetch(path,init)});
      try{const batch=await readNativeAffectedSummaries(targets,{current,signal:budget.signal,denied:accountId=>{deniedAccounts.add(accountId);denied(accountId);},read:(target,signal)=>budget.run(requestSignal=>summaries.read(target,AbortSignal.any([signal,requestSignal])))});
        details.push(...batch.items.map(row=>folderProjection.current?.observe(row,true)??row));summaryFailed=summaryFailed||batch.incomplete;}
      finally{summaries.dispose();}
    }
    if(!current())return;
    const updated=[...(result?.items??[]),...details,...(fresh?[fresh]:[])].filter(row=>!deniedAccounts.has(row.account_id)).map(row=>folderProjection.current?.observe(row)??row);
    const byId=new Map(updated.map(row=>[messageKey(row),row]));
    if(result)setPage({...result,items:result.items.filter(row=>!deniedAccounts.has(row.account_id)).map(row=>byId.get(messageKey(row))??row)});
    if(searchState&&!searchController.current?.reconcile(updated))setSearchState(previous=>previous?reconcileNativeEmailSearchState(previous,updated):previous);
    if(fresh&&!deniedAccounts.has(fresh.account_id)&&selectedRef.current===chosen)setSelected(fresh);setUnreadRevision(value=>value+1);
    const syncFailed=result?.sync_state==='failed'||result?.sync_state==='paused'||result?.accounts?.some(row=>row.sync_state==='failed'||row.sync_state==='paused'||row.error&&row.error!=='access_denied');
    const groups=triage.current?.snapshot().groups,labelChange=groups?.some(group=>group.kind==='labels'),recoveryChange=groups?.some(group=>['spam','not_spam','restore'].includes(group.kind));setNotice(summaryFailed?'Some message details could not refresh. Loaded results are kept. Try Refresh.':deniedAccounts.size?'Account access changed. Details from other accounts were updated.':syncFailed?'Message details updated. Mailbox sync needs attention. Check Email settings.':labelChange?'Confirmed label changes may take a moment to appear in mailbox views.':recoveryChange?'Confirmed folder changes may take a moment to appear in mailbox views.':'Loaded message details updated.',summaryFailed||deniedAccounts.size||syncFailed?'mutation_attention':labelChange||recoveryChange?'general':affectedTargets.length?'mutation_success':'general');return;
   }
   const baseline=new Map(page?.accounts?.map(row=>[row.account_id,row.checkpoint_revision??0])??ids.map(id=>[id,page?.checkpoint_revision??0]));
   const responses=await budget.run(signal=>Promise.all(refreshIds.map(async id=>{const response=await api.fetch(`/api/email/accounts/${encodeURIComponent(id)}/refresh`,{method:'POST',signal,body:'{}'});if(current()&&response.status===401)throw new MailAccessChanged();if(current()&&response.status===403){denied(id);throw Error('An account connection needs attention. Loaded messages from other accounts remain available.');}const value=response.status===202?await response.json():null;if(response.status!==202)await response.body?.cancel();return {status:response.status,value};})));
   if(!current())return;if(responses.some(response=>response.status===401))throw new MailAccessChanged();
   const deniedAccounts=refreshIds.filter((_id,index)=>responses[index].status===403);for(const id of deniedAccounts)denied(id);
   if(deniedAccounts.length)throw Error('Some account connections need attention. Loaded messages from other accounts remain available.');
   if(responses.some(response=>response.status!==202))throw Error('Some mailboxes could not refresh. Try again.');
   const acknowledgements=responses.map(response=>response.value);if(!current())return;
   if(acknowledgements.some((row,index)=>!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='account_id,state'||row.account_id!==refreshIds[index]||!['queued','syncing','needs_attention'].includes(row.state)))throw Error('Mailbox refresh acknowledgement could not be confirmed.');
   setRefreshing(false);if(acknowledgements.some(row=>row.state==='needs_attention')){setNotice('Mailbox sync needs attention. Check Email settings. Loaded messages remain available.');return;}
   setNotice(acknowledgements.some(row=>row.state==='queued')?'Refresh queued. Checking for new mail…':'Mailbox sync is running. Checking for new mail…');
   for(let attempt=0;attempt<6;attempt++){
    await pause(budget.signal);const result=await budget.run(signal=>read(null,signal));if(!current())return;result.items=result.items.map(row=>folderProjection.current?.observe(row,true)??row);
    if(result.accounts?.some(row=>row.account_id===selectedRef.current?.account_id&&row.error==='access_denied'))setSelected(null);
    const states=result.accounts??[{account_id:ids[0],checkpoint_revision:result.checkpoint_revision??0,state:'available'}];
    for(const row of states)if(row.error==='access_denied')denied(row.account_id);
    if(result.sync_state==='failed'||result.sync_state==='paused'||states.some(row=>row.sync_state==='failed'||row.sync_state==='paused'||row.error&&row.error!=='access_denied')){setNotice('Mailbox sync needs attention. Check Email settings. Loaded messages remain available.');return;}
    if(states.some(row=>row.state==='available'&&(row.checkpoint_revision??0)>(baseline.get(row.account_id)??0))){
     const chosen=selectedRef.current,next=result.items.find(row=>chosen&&messageKey(row)===messageKey(chosen));
     if(!current())return;setPage(result);setUnreadRevision(value=>value+1);
     if(next&&selectedRef.current===chosen)setSelected(next);
     setNotice(result.coverage==='complete'?'Loaded mailbox updates.':'Loaded mailbox updates. Sync may still be catching up.');return;
    }
   }
   setNotice('Refresh did not confirm new mailbox updates. Check Email settings if your inbox stays empty.');
  }catch(error){if(current()){if(error instanceof MailAccessChanged){setSelected(null);setPage(null);}setNotice(error instanceof Error?error.message:'Refresh could not finish.');}}finally{budget.dispose();if(current()){setRefreshing(false);refresh.current=null;}}
 };
 useEffect(()=>{afterActionRefresh.current=(affected,targets,acknowledgements)=>refreshMailbox(true,affected,targets,acknowledgements);});
 const timersChanged=()=>{setTimerRevision(value=>value+1);setUnreadRevision(value=>value+1);if(!localView(folder))void load();};
 const openComposer=useCallback((value?:NativeComposeSelection)=>{setSettings(false);if(composer){if(value&&value.draftId!==composer.draftId)setNotice('Save and close the current draft before opening another.');else setComposePresentation('normal');return;}const accountId=value?.accountId??(JSON.parse(accountScopeKey) as string[])[0];if(accountId){router.replace('/email',{scroll:false});setComposePresentation('normal');setComposeSummary(null);setComposeClose(null);setComposer(value??{accountId});}},[composer,accountScopeKey,router]);
 useEffect(()=>{if(!composer||!focusNewCompose.current)return;focusNewCompose.current=false;const frame=requestAnimationFrame(()=>{if(sessionScope===getActiveSessionCacheScope())readerSurface.current?.querySelector<HTMLInputElement>('input[role="combobox"]:not([disabled])')?.focus();});return()=>cancelAnimationFrame(frame);},[composer,sessionScope]);
 const title=searchState?'Search results':folderScope?.label??folders.find(row=>row[0]===folder)?.[1]??'Inbox';
 const rows=searchState?.items??page?.items??[],unsupportedSearch=searchState?nativeSearchUnsupported(searchState):false;
 const keyboardRowsKey=JSON.stringify(rows.map(row=>[row.account_id,row.logical_message_id]));
 useEffect(()=>{const anchor=api.getAccessToken(),keys=(JSON.parse(keyboardRowsKey) as [string,string][]).map(([accountId,logicalId])=>accountId+'/'+logicalId);let active=true,focusFrame:number|null=null;
  const current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  const handler=(event:KeyboardEvent)=>{
   if(!current()||settings||composer||moveTargets)return;const action=nativeEmailShortcut(event,{dialog:!!document.querySelector('[aria-modal="true"]'),menu:!!document.querySelector('[data-email-reader-menu][open], [data-email-menu-open="true"]')});
   if(action==='compose'&&accountScopeKey!=='[]'){event.preventDefault();focusNewCompose.current=true;openComposer();return;}
   if(action==='search'&&!localView(folder)&&accountScopeKey!=='[]'){event.preventDefault();setSearchOpen(true);focusFrame=requestAnimationFrame(()=>{if(current())searchInput.current?.focus();});return;}
   if(action==='next'||action==='previous'){const index=keys.findIndex(key=>messageButtons.current.get(key)===document.activeElement),next=nativeEmailFocusIndex(index,action,keys.length),button=next===null?null:messageButtons.current.get(keys[next]);if(button){event.preventDefault();button.focus();}return;}
   if(action==='open'){const target=(event.target as HTMLElement|null)?.closest<HTMLButtonElement>('[data-email-message]');if(target&&keys.some(key=>messageButtons.current.get(key)===target)){event.preventDefault();target.click();}}
  };window.addEventListener('keydown',handler);return()=>{active=false;window.removeEventListener('keydown',handler);if(focusFrame!==null)cancelAnimationFrame(focusFrame);};
 },[sessionScope,settings,composer,moveTargets,labelTargets,folder,accountScopeKey,keyboardRowsKey,openComposer]);
 useEffect(()=>{setLabelTargets(null);},[accountScopeKey,sessionScope,folder,searchState?.query,settings,composer,selected?.account_id,selected?.logical_message_id]);
 useEffect(()=>{setPicked(new Set());setSelectionMode(false);},[searchState?.query]);
 useEffect(()=>{if(!selectionMode)return;const escape=(event:KeyboardEvent)=>{if(event.key!=='Escape'||event.defaultPrevented||document.querySelector('[aria-modal="true"], [data-email-reader-menu][open], [data-email-menu-open="true"]'))return;setPicked(new Set());setSelectionMode(false);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[selectionMode]);
 const pickedRows=rows.filter(row=>picked.has(messageKey(row))),unconfirmed=!!triageState?.groups.some(group=>group.state==='uncertain'||group.result?.items.some(item=>['prepared','unknown'].includes(item.state)));
 const actionBusy=!!triageState?.busy||refreshing||unconfirmed;
 const showActionFeedback=nativeTriageFeedbackVisible(triageState,feedbackView,actionViewKey),visibleTriageState=showActionFeedback?triageState:null;
 const visibleNotice=visibleTriageState?.groups.length&&['mutation_pending','mutation_success'].includes(mailboxNotice.kind)?'':notice;
 const applyAction=(kind:NativeTriageKind,targets:Message[],destination?:NativeTriageSelection)=>{if(['spam','not_spam','restore'].includes(kind)&&(labelScope.current!==labelScopeKey||actionBusy||!nativeEmailRecoveryActions(accounts,targets).includes(kind)))return;const unavailable=nativeEmailModificationNotice(accounts,targets);if(unavailable){setNotice(unavailable);return;}setNotice('');void triage.current?.apply(kind,targets,destination).catch(error=>setNotice(error instanceof Error?error.message:'The action is unavailable.'));};
 const labelsAvailable=(targets:readonly Message[])=>targets.length>0&&new Set(targets.map(row=>row.account_id)).size===1&&accounts.find(row=>row.account_id===targets[0].account_id)?.provider==='gmail';
 const openLabels=(targets:Message[])=>{if(labelScope.current!==labelScopeKey||actionBusy||!labelsAvailable(targets)||nativeEmailModificationNotice(accounts,targets))return;const focused=document.activeElement instanceof HTMLElement?document.activeElement:null,returnFocus=focused?.closest('details')?.querySelector<HTMLElement>('summary')??focused;setMoveTargets(null);setLabelTargets({messages:[...targets],returnFocus,scope:labelScopeKey});};
 const chooseFolder=(accountId:string,value:NativeFolder)=>{folderProjection.current?.reset();actionView.current=null;setFeedbackView(null);router.replace('/email',{scroll:false});searchGeneration.current++;searchController.current?.dispose();pending.current?.abort();refresh.current?.abort();setRefreshing(false);setNotice('');setSearchState(null);setSearchOpen(false);setQuery('');setSelected(null);setTimerTarget(null);selectedRef.current=null;setFolderScope({accountId,label:nativeFolderLabel(value,folderCatalogue?.accounts.find(row=>row.accountId===accountId)?.items??[])});setFolder(value.folder_id);setSettings(false);};
 return <div className="relative flex h-full min-h-0 flex-col bg-[var(--surface)] text-[var(--text-primary)] lg:flex-row">
  <section aria-label="Mailbox" className={`${visibleComposer&&composePresentation==='expanded'?'hidden':selected||timerTarget||settings||visibleComposer||moveTargets||labelTargets||linkNotice?'hidden lg:flex':'flex'} ${composer&&composePresentation==='minimized'?'min-h-0 flex-1 lg:flex-none':''} w-full shrink-0 flex-col lg:w-[360px] xl:w-[400px]`}>
   <header className="space-y-2 px-5 pb-3 pt-5">
    <div className="flex items-center justify-between gap-3"><h1 className="min-w-0 truncate text-lg font-semibold" title={title}>{title}</h1><div className="flex shrink-0 items-center gap-0.5">
     <button type="button" aria-label="Compose email" title="Compose email" disabled={!accounts.length} onClick={()=>openComposer()} className="rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"><SquarePen size={17}/></button>
     {!localView(folder)&&<button type="button" aria-label="Search mail" title="Search mail" aria-expanded={searchOpen} onClick={()=>setSearchOpen(value=>!value)} className={`rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${searchOpen?'bg-[var(--accent-light)] text-[var(--primary)]':''}`}><Search size={17}/></button>}
     {!localView(folder)&&<button aria-label="Refresh mailbox" title="Refresh mailbox" disabled={refreshing||searchState?.busy||!ids.length} onClick={()=>void refreshMailbox()} className="rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"><RefreshCw size={17} className={refreshing||searchState?.busy?'animate-spin':''}/></button>}
     {!localView(folder)&&<NativeEmailSelection active={selectionMode} count={pickedRows.length} loaded={rows.length} busy={actionBusy} onStart={()=>setSelectionMode(true)} onAll={()=>{setSelectionMode(true);setPicked(new Set(rows.slice(0,100).map(messageKey)));}} onClear={()=>setPicked(new Set())} onDone={()=>{setPicked(new Set());setSelectionMode(false);}}/>}
     <button aria-label="Email settings" title="Email settings" onClick={()=>setSettings(true)} className="rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><Settings2 size={17}/></button>
    </div></div>
    <NativeEmailMailto key={sessionScope} accounts={accounts} composerOpen={!!composer} onCompose={(accountId,initialContent)=>openComposer({accountId,initialContent})}/>
    <div className="sr-only"><NativeEmailUnread key={sessionScope+'/'+unreadKey} accountIds={unreadIds} sessionScope={sessionScope} revision={unreadRevision} onChange={display=>setUnread({key:unreadKey,display})} onDenied={id=>{if(id)denied(id);setAccountReload(value=>value+1);}}/></div>
    {folderScope&&<p className="text-xs text-[var(--muted)]">{accounts.find(row=>row.account_id===folderScope.accountId)?.primary_address}</p>}
    {searchOpen&&<form onSubmit={event=>{event.preventDefault();void runSearch();}} className="space-y-2">
      <div className="flex gap-1 rounded-full bg-[var(--surface-container-low)] p-1"><input ref={searchInput} aria-label="Search query" value={query} onChange={event=>setQuery(event.target.value)} maxLength={2048} placeholder="Search mail" className="min-w-0 flex-1 rounded-full bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"/>
        <button type="submit" aria-label="Run search" disabled={searchState?.busy||!query.trim()||!ids.length} className="rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)] disabled:opacity-50"><Search size={16}/></button>
        <button type="button" aria-label="Close search" onClick={closeSearch} className="rounded-full p-2 hover:bg-[var(--hover-tint)]"><X size={16}/></button></div>
      <div className="flex items-center justify-between gap-2 text-[var(--text-secondary)]"><p className="text-xs">Searches the accounts selected in Email settings.</p><NativeEmailSearchHelp/></div>
    </form>}
    {searchState&&<div className="text-xs text-[var(--text-secondary)]">{(!searchOpen||query!==searchState.query)&&<p className="truncate" title={searchState.query}>“{searchState.query}”</p>}
      <p role="status" title={`Results for ${searchState.query}`}>{searchState.busy?searchState.loading==='refresh'?'Refreshing search…':searchState.loading==='more'?'Loading more matches…':'Searching mail…':unsupportedSearch?'Search not supported':`${rows.length} matches loaded${searchState.complete?' · search complete':' · results may be partial'}`}</p>{!unsupportedSearch&&searchState.accounts.some(row=>row.limited)&&<p>Some account providers cap search results. No exact total is available.</p>}</div>}
    {visibleNotice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{visibleNotice}</p>}
    <NativeEmailActionStatus state={visibleTriageState} accounts={accounts} refreshing={refreshing} onCheck={()=>void triage.current?.check()} onUndo={()=>void triage.current?.undo()}/>
    {!!pickedRows.length&&<div className="flex items-center justify-between gap-2"><p className="min-w-0 text-xs text-[var(--muted)]" title={ids.map(id=>({address:accounts.find(row=>row.account_id===id)?.primary_address,count:pickedRows.filter(row=>row.account_id===id).length})).filter(row=>row.count).map(row=>`${row.address}: ${row.count}`).join(' · ')}>{pickedRows.length} selected{new Set(pickedRows.map(row=>row.account_id)).size>1?` · ${new Set(pickedRows.map(row=>row.account_id)).size} accounts`:''}</p><NativeEmailActions accounts={accounts} messages={pickedRows} busy={actionBusy} unavailableReason={nativeEmailModificationNotice(accounts,pickedRows)} onAction={kind=>applyAction(kind,pickedRows)} onMove={()=>{setLabelTargets(null);setMoveTargets(pickedRows);}} onLabels={labelsAvailable(pickedRows)?()=>openLabels(pickedRows):undefined}/></div>}

   </header>
   <div className={`min-h-0 flex-1 overflow-y-auto px-2 ${composer&&composePresentation==='minimized'?'pb-28 lg:pb-4':'pb-4'}`}>
    {folder==='drafts'?<NativeEmailDrafts accounts={scopeAccounts} sessionScope={sessionScope} revision={draftRevision} recoveryOwner={recoveryOwner} onOpen={openComposer}/>:folder==='outbox'?<NativeEmailOutbox accounts={scopeAccounts} sessionScope={sessionScope} revision={draftRevision} onOpenDraft={openComposer}/>:['snooze','follow_up'].includes(folder)?<div className="space-y-5 px-3"><p className="text-xs leading-5 text-[var(--muted)]">{nativeTimerExplanation(folder as 'snooze'|'follow_up')}</p>{scopeAccounts.map(row=><NativeEmailTimers key={row.account_id+'/'+timerRevision} accountId={row.account_id} accountLabel={row.primary_address} compact sessionScope={sessionScope} kind={folder as 'snooze'|'follow_up'} onChanged={timersChanged} onDenied={()=>denied(row.account_id)} onOpen={timer=>{router.push(nativeMessageUrl(timer),{scroll:false});setSettings(false);}}/>)}</div>:<>
    {(discovery||busy&&!page)&&!searchState&&<p role="status" className="px-3 py-8 text-sm text-[var(--muted)]">Loading inbox…</p>}
    {!discovery&&!busy&&!searchState?.busy&&!rows.length&&<div className="px-3 py-10 text-sm text-[var(--muted)]">{accounts.length?searchState?(unsupportedSearch?'Edit this query using Search help, then search again.':searchState.complete?'No messages match this query.':'No matches have been loaded. Search may be partial.'):'No messages in this view.':'Connect an account in Email settings to begin.'}</div>}
    {rows.map(row=><div key={messageKey(row)} className={`mb-1 flex items-center rounded-xl ${selected&&messageKey(selected)===messageKey(row)?'bg-[var(--accent-light)]':'hover:bg-[var(--hover-tint)]'}`}>{selectionMode&&<input type="checkbox" aria-label={`Select ${String(row.data.subject||'message without subject')}`} checked={picked.has(messageKey(row))} onChange={event=>{const next=new Set(picked);if(event.target.checked){if(next.size>=100){setNotice('Select up to 100 messages at a time.');return;}next.add(messageKey(row));}else next.delete(messageKey(row));setPicked(next);}} disabled={actionBusy} className="ml-3 h-4 w-4 shrink-0 cursor-pointer appearance-none rounded border border-[var(--muted)] bg-transparent checked:border-[var(--primary)] checked:bg-[var(--primary)] checked:shadow-[inset_0_0_0_3px_var(--surface)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"/>}<button data-email-message ref={button=>{if(button)messageButtons.current.set(messageKey(row),button);else messageButtons.current.delete(messageKey(row));}} onClick={()=>{const reopening=folderProjection.current?.isExpired(row);router.push(nativeMessageUrl(row),{scroll:false});setConversationAnchor(null);setSelected(reopening?null:folderProjection.current?.observe(row)??row);setSettings(false);}} aria-current={!!selected&&messageKey(selected)===messageKey(row)?'true':undefined} className="min-w-0 flex-1 rounded-xl px-3 py-3 text-left focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
     <div className="mb-1 flex items-center gap-3"><span className={`min-w-0 flex-1 truncate text-sm ${row.flags.seen?'':'font-semibold'}`}>{String(row.data.sender||'Unknown sender')}</span><time className="shrink-0 text-[11px] text-[var(--muted)]">{row.received_at?new Date(row.received_at).toLocaleDateString(undefined,{month:'short',day:'numeric'}):''}</time></div>
     <p className={`truncate text-sm ${row.flags.seen?'text-[var(--text-secondary)]':'font-medium'}`}>{String(row.data.subject||'(No subject)')}</p>
     {ids.length>1&&<p className="mt-1 truncate text-[11px] text-[var(--muted)]">{accounts.find(value=>value.account_id===row.account_id)?.primary_address}</p>}
    </button></div>)}
    {!searchState&&page?.next_cursor&&<button disabled={busy} onClick={()=>void load(page.next_cursor)} className="mx-3 mt-3 flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)]">{busy?'Loading…':'More messages'}<ChevronRight size={14}/></button>}
    {searchState&&<div className="mt-3 space-y-3 px-3">{searchState.accounts.map(row=><div key={row.accountId} className="space-y-1 text-xs text-[var(--text-secondary)]">
      <p className="break-words font-medium">{accounts.find(value=>value.account_id===row.accountId)?.primary_address}</p>
      {row.error&&<p role="status">{row.error}</p>}
      {!!row.unsupported.length&&<div role="status"><ul className="space-y-1">{[...new Set(row.unsupported.map(nativeSearchUnsupportedReason))].map(message=><li key={message}>{message}</li>)}</ul></div>}
      {!!row.failureCount&&<p>Some matching messages could not be loaded.</p>}
      {row.nextCursor&&<button disabled={searchState.busy} aria-label={`More search matches for ${accounts.find(value=>value.account_id===row.accountId)?.primary_address??'this account'}`}
        onClick={()=>void searchController.current?.more(row.accountId)} className="flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)] disabled:opacity-50">More matches<ChevronRight size={14}/></button>}
    </div>)}</div>}
    </>}
   </div>
  </section>
  <Suspense fallback={null}><NativeEmailDraftLink accountIds={accounts.map(row=>row.account_id)} ready={!discovery} sessionScope={sessionScope} onOpen={openComposer} onNotice={setLinkNotice}/><NativeEmailMessageLink selected={selected} accountIds={accounts.map(row=>row.account_id)} ready={!discovery} sessionScope={sessionScope} onDenied={denied} onOpening={target=>folderProjection.current?.reopen(target)} onChange={(row,message)=>{if(row&&folderProjection.current?.isExpired(row))return;const projected=row?folderProjection.current?.observe(row,true)??row:null;setSelected(projected);selectedRef.current=projected;setTimerTarget(null);setConversationAnchor(null);setLinkNotice(message);if(row){setSettings(false);}}}/></Suspense>
  <section ref={readerSurface} aria-label={settings?'Email settings':visibleComposer?'Email composer':'Message reader'} className={`${!selected&&!timerTarget&&!settings&&!visibleComposer&&!moveTargets&&!labelTargets&&!linkNotice?'hidden lg:block':''} min-h-0 min-w-0 flex-1 overflow-y-auto ${composer&&composePresentation==='minimized'?'pb-28':''}`}>
   {!settings&&!visibleComposer&&(selected||moveTargets||labelTargets)&&<div className="space-y-1 px-5 pt-3 lg:hidden"><NativeEmailActionStatus state={visibleTriageState} accounts={accounts} refreshing={refreshing} onCheck={()=>void triage.current?.check()} onUndo={()=>void triage.current?.undo()}/>{visibleNotice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{visibleNotice}</p>}</div>}
   {moveTargets?.length&&!settings&&!visibleComposer&&<NativeEmailFolderPicker key={moveTargets[0].account_id} accountId={moveTargets[0].account_id} address={accounts.find(row=>row.account_id===moveTargets[0].account_id)?.primary_address??'Account'} sessionScope={sessionScope} onClose={()=>setMoveTargets(null)} onDenied={denied} onChoose={destination=>{const targets=moveTargets;setMoveTargets(null);applyAction('move',targets,destination);}}/>}
   {labelTargets?.scope===labelScopeKey&&labelTargets.messages.length&&!settings&&!visibleComposer&&<NativeEmailLabelPicker key={labelTargets.scope} accountId={labelTargets.messages[0].account_id} address={accounts.find(row=>row.account_id===labelTargets.messages[0].account_id)?.primary_address??'Account'} messageCount={labelTargets.messages.length} sessionScope={sessionScope} returnFocus={labelTargets.returnFocus} onClose={()=>setLabelTargets(null)} onDenied={denied} onApply={selection=>{const targets=labelTargets.messages;if(labelTargets.scope!==labelScope.current||!labelsAvailable(targets)||selection.accountId!==targets[0].account_id)return;setLabelTargets(null);applyAction('labels',targets,selection);}}/>}
   {composer&&<div className={settings?'hidden':''}><NativeEmailComposer key={composer.accountId+'/'+(composer.draftId??'new')} accounts={accounts} selection={composer} sessionScope={sessionScope} recoveryOwner={recoveryOwner} presentation={composePresentation} onPresentation={value=>{if(composeOwnerRef.current===composeOwner&&sessionScope===getActiveSessionCacheScope()){setSettings(false);setComposePresentation(value);}}} onPresentationSummary={value=>{if(composeOwnerRef.current===composeOwner)setComposeSummary({owner:composeOwner,value});}} onPresentationHandle={value=>{if(composeOwnerRef.current===composeOwner)setComposeClose({owner:composeOwner,value});}} onClose={()=>{setComposer(null);setComposePresentation('normal');setComposeSummary(null);setComposeClose(null);}} onSaved={()=>setDraftRevision(value=>value+1)} onAccepted={()=>void refreshMailbox(true)} onSettings={()=>setSettings(true)}/></div>}
   {settings?<div className="mx-auto max-w-2xl space-y-7 px-6 py-6"><div className="flex items-center gap-3"><button aria-label="Back to mail" onClick={()=>setSettings(false)} className="rounded-full p-2 hover:bg-[var(--hover-tint)]"><ArrowLeft size={18}/></button><h2 className="text-lg font-semibold">Email settings</h2></div>
    <NativeEmailMailtoSettings/>
    <NativeEmailNotificationsInfo/>
    <NativeEmailDirectConnections sessionScope={sessionScope} reconnect={reconnect} navigationBlocked={!!composer} onCancelReconnect={()=>setReconnect(null)} onConnected={()=>setAccountReload(value=>value+1)}/>
    <NativeEmailRetainedConnections key={sessionScope} sessionScope={sessionScope} activeAccountIds={accounts.map(row=>row.account_id)} onAdopted={()=>setAccountReload(value=>value+1)}/>
    <NativeEmailAccountManagement sessionScope={sessionScope} knownAccounts={accounts} onDenied={denied} onProviderReconnect={value=>{setReconnect(value);readerSurface.current?.scrollTo({top:0,behavior:'smooth'});}} onAccessEnded={()=>{accounts.forEach(row=>denied(row.account_id));setAccounts([]);setReconnect(null);}} onChanged={value=>{if(value.state!=='active'){denied(value.account_id);setAccounts(previous=>previous.filter(row=>row.account_id!==value.account_id));setAccount(previous=>previous===value.account_id?'all':previous);}else setAccounts(previous=>previous.map(row=>row.account_id===value.account_id?{...row,capabilities:value.capabilities}:row));setAccountReload(previous=>previous+1);}}/>
    <fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">Accounts in this mailbox</legend>{[{account_id:'all',primary_address:'All connected accounts',display_label:''},...accounts].map(row=><label key={row.account_id} className="flex cursor-pointer items-center gap-3 rounded-xl bg-[var(--surface-container-low)] px-4 py-3 text-sm"><input type="radio" name="mail-account" checked={account===row.account_id} onChange={()=>{
      folderProjection.current?.reset();actionView.current=null;setFeedbackView(null);router.replace('/email',{scroll:false});searchGeneration.current++;searchController.current?.dispose();pending.current?.abort();refresh.current?.abort();setNotice('');setSelected(null);setTimerTarget(null);setConversationAnchor(null);selectedRef.current=null;setSearchState(null);setFolderScope(null);setFolder('inbox');setAccount(row.account_id);
    }}/><span>{row.display_label||row.primary_address}{row.display_label&&<span className="block text-xs text-[var(--muted)]">{row.primary_address}</span>}</span></label>)}</fieldset>
    <NativeEmailFolderManagement accounts={mailboxAccounts} catalogue={folderCatalogue} sessionScope={sessionScope} recovery={folderManagementRecovery.current} onChoose={chooseFolder} onMore={accountId=>void folderController.current?.more(accountId)} onReload={()=>setFolderReload(value=>value+1)} onDenied={denied} onConfirmed={(accountId,result)=>{setFolderReload(value=>value+1);if(folderScope?.accountId===accountId&&folder===result.folder_id){const items=folderCatalogue?.accounts.find(row=>row.accountId===accountId)?.items??[],existing=items.find(row=>row.folder_id===result.folder_id);if(existing)setFolderScope(previous=>previous?.accountId===accountId?{...previous,label:nativeFolderLabel({...existing,label:result.label!},items)}:previous);}}}/>
    <section className="space-y-3"><h3 className="text-sm font-medium">Account preferences</h3>{mailboxAccounts.map(row=><NativeEmailAccountPreferences key={sessionScope+'/'+row.account_id} accountLabel={row.primary_address}><EmailReadingSettings accountId={row.account_id} setupState="connected" disabled={false} onBusy={ignoreBusy}/><NativeEmailKnowledgeSettings accountId={row.account_id} sessionScope={sessionScope}/><NativeEmailAgentAccess accountId={row.account_id} sessionScope={sessionScope}/><NativeEmailDraftSyncSettings accountId={row.account_id} provider={row.provider} sessionScope={sessionScope}/>{row.provider==='imap_smtp'&&<NativeEmailSentCopySettings accountId={row.account_id} sessionScope={sessionScope}/>}<NativeEmailTemplates accountId={row.account_id} sessionScope={sessionScope}/><NativeEmailSignatures accountId={row.account_id} primaryAddress={row.primary_address} sessionScope={sessionScope}/><NativeEmailRules accountId={row.account_id} sessionScope={sessionScope} onDenied={()=>denied(row.account_id)} onApplied={()=>void afterActionRefresh.current()}/></NativeEmailAccountPreferences>)}</section><NativeEmailImapSetup sessionScope={sessionScope} onConnected={()=>setAccountReload(value=>value+1)}/><Link href="/settings/apps" className="inline-flex rounded-full bg-[var(--accent-light)] px-4 py-2 text-sm text-[var(--primary)]">Manage account connections</Link>
   </div>:visibleComposer?null:timerTarget?<><button onClick={()=>setTimerTarget(null)} className="m-3 flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)] lg:hidden"><ArrowLeft size={16}/>Back to timers</button><NativeEmailReader toolbar={<div className="flex flex-wrap items-center gap-1"><NativeEmailMessageTimers key={timerTarget.account_id+'/'+timerTarget.logical_message_id} accountId={timerTarget.account_id} logicalMessageId={timerTarget.logical_message_id} sessionScope={sessionScope} onChanged={timersChanged} onDenied={()=>denied(timerTarget.account_id)}/></div>} accountId={timerTarget.account_id} logicalMessageId={timerTarget.logical_message_id} sessionScope={sessionScope} onCompose={selection=>{if(selection.accountId===timerTarget.account_id&&selection.initialContent.reply_record_id===timerTarget.logical_message_id)openComposer(selection);}}/></>:selected?<>
    <button onClick={()=>{router.replace('/email',{scroll:false});setConversationAnchor(null);setSelected(null);}} className="m-3 flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)] lg:hidden"><ArrowLeft size={16}/>Back to inbox</button>
    <NativeEmailReader toolbar={<div className="flex flex-wrap items-center gap-1"><NativeEmailConversation key={JSON.stringify([sessionScope,selected.account_id,conversationAnchor?.account_id===selected.account_id?conversationAnchor.logical_message_id:selected.logical_message_id])}
     accountId={selected.account_id} anchorId={conversationAnchor?.account_id===selected.account_id?conversationAnchor.logical_message_id:selected.logical_message_id}
     sessionScope={sessionScope} address={accounts.find(row=>row.account_id===selected.account_id)?.primary_address??'Email account'} selectedId={selected.logical_message_id}
     supported={['gmail','microsoft','imap_smtp'].includes(accounts.find(row=>row.account_id===selected.account_id)?.provider??'')} headerRelated={accounts.find(row=>row.account_id===selected.account_id)?.provider==='imap_smtp'}
     open={conversationAnchor?.account_id===selected.account_id} onOpen={()=>setConversationAnchor(selected)} onClose={()=>setConversationAnchor(null)}
     onSelect={row=>{if(row.account_id===selected.account_id){router.push(nativeMessageUrl(row),{scroll:false});setSelected(folderProjection.current?.isExpired(row)?null:folderProjection.current?.observe(row)??row);}}} onDenied={()=>denied(selected.account_id)}/>
    <NativeEmailMessageTimers key={selected.account_id+'/'+selected.logical_message_id} accountId={selected.account_id} logicalMessageId={selected.logical_message_id} sessionScope={sessionScope} onChanged={timersChanged} onDenied={()=>denied(selected.account_id)}/></div>} accountId={selected.account_id} logicalMessageId={selected.logical_message_id} sessionScope={sessionScope} revision={selected.revision}
     onCompose={selection=>{if(selection.accountId===selected.account_id&&selection.initialContent.reply_record_id===selected.logical_message_id){focusNewCompose.current=true;openComposer(selection);}}}
     actions={<NativeEmailActions accounts={accounts} primaryOnly messages={[selected]} busy={actionBusy} unavailableReason={nativeEmailModificationNotice(accounts,[selected])} onAction={kind=>applyAction(kind,[selected])} onMove={()=>{setLabelTargets(null);setMoveTargets([selected]);}} onLabels={labelsAvailable([selected])?()=>openLabels([selected]):undefined}/>}
     moreActions={<><NativeEmailTaskAction key={JSON.stringify([sessionScope,selected.account_id,selected.logical_message_id])} target={{account_id:selected.account_id,logical_message_id:selected.logical_message_id}} sessionScope={sessionScope}/><NativeEmailSecondaryActions accounts={accounts} messages={[selected]} busy={actionBusy} unavailableReason={nativeEmailModificationNotice(accounts,[selected])} onAction={kind=>applyAction(kind,[selected])} onMove={()=>{setLabelTargets(null);setMoveTargets([selected]);}} onLabels={labelsAvailable([selected])?()=>openLabels([selected]):undefined}/></>} />
   </>:<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-[var(--muted)]"><Mail size={28} strokeWidth={1.3}/><p role={linkNotice?'status':undefined} className="text-sm">{linkNotice||'Select a message to read'}</p>{linkNotice&&<button className="rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)]" onClick={()=>router.replace('/email',{scroll:false})}>Back to mail</button>}</div>}
  </section>
 {composer&&composePresentation==='minimized'&&composeSummary?.owner===composeOwner&&<NativeEmailComposePresentation value={composeSummary.value} closeDisabled={composeClose?.owner!==composeOwner||composeClose.value.disabled} onRestore={()=>{if(composeOwnerRef.current===composeOwner&&sessionScope===getActiveSessionCacheScope()){setSettings(false);setComposePresentation('normal');}}} onExpand={()=>{if(composeOwnerRef.current===composeOwner&&sessionScope===getActiveSessionCacheScope()){setSettings(false);setComposePresentation('expanded');}}} onClose={()=>{if(composeOwnerRef.current===composeOwner&&sessionScope===getActiveSessionCacheScope()&&composeClose?.owner===composeOwner){setSettings(false);setComposePresentation('normal');composeClose.value.close();}}}/>}
 </div>;
}
