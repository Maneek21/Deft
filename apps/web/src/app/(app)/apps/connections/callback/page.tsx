'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { getActiveSessionCacheScope } from '@/lib/session-cache';
import { APP_CONNECTION_PENDING_KEY, pendingAppConnection, connectionCallback } from '@/lib/app-connection-flow';
import {APP_CONNECTION_UPGRADE_PENDING_KEY,completeConnectionUpgrade} from '@/lib/app-connection-upgrade';
import {APP_CONNECTION_REPAIR_PENDING_KEY,completeConnectionRepair} from '@/lib/app-connection-repair';
import { APP_CONNECTION_SESSION_PENDING_KEY, appConnectionCallbackUsesGeneric, appConnectionSessionTag, completeAppConnectionSession } from '@/lib/app-connection-session-flow';

type Result = { href: string; message: string; success: boolean };
export default function AppConnectionCallbackPage() {
  const {sessionCacheScope,user,org}=useAuth();
  const query=useRef<string|undefined>(undefined);
  const requestAnchor=useRef<{scope:string;token:string|null}|null>(null);
  const request = useRef<Promise<Result> | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    let current = true;
    if(query.current===undefined){query.current=window.location.search;window.history.replaceState(null,'',window.location.pathname);}
    if(!sessionCacheScope||!user||!org)return;
    if (!request.current) {
      const search = query.current;
      const scope=sessionCacheScope,token=api.getAccessToken();
      requestAnchor.current={scope,token};
      const sameSession=()=>scope===getActiveSessionCacheScope()&&isSameWebSession(token,api.getAccessToken());
      request.current = (async () => {
        let href = '/settings/apps';
        let callbackSessionId: string | null = null;
        try {
          // Generic custody uses a connection UUID, never an Experience UUID.
          // Its own nonce never falls back to a legacy adapter. An independent
          // exact native/legacy pending nonce may coexist with an unknown attempt.
          const genericStored=sessionStorage.getItem(APP_CONNECTION_SESSION_PENDING_KEY);
          const nativeMatches=false;
          let legacyMatches=false;
          try{const stored=sessionStorage.getItem(APP_CONNECTION_PENDING_KEY);if(stored){connectionCallback(search,pendingAppConnection(JSON.parse(stored)));legacyMatches=true;}}catch{/* No independent validated legacy nonce. */}
          const upgradeStored=sessionStorage.getItem(APP_CONNECTION_UPGRADE_PENDING_KEY);
          let genericMatches=false;try{if(genericStored&&genericStored.length<=8192)genericMatches=new URLSearchParams(search).get('state')===JSON.parse(genericStored).state;}catch{/* No independent generic nonce. */}
          const repairStored=sessionStorage.getItem(APP_CONNECTION_REPAIR_PENDING_KEY);
          let upgradeMatches=false;try{if(upgradeStored&&upgradeStored.length<=16384)upgradeMatches=new URLSearchParams(search).get('state')===JSON.parse(upgradeStored).state;}catch{/* No independent upgrade nonce. */}
          if(repairStored&&appConnectionCallbackUsesGeneric(search,repairStored,nativeMatches,legacyMatches||genericMatches||upgradeMatches)){
            if(repairStored.length>16384)throw Error('Account reconnection is invalid.');
            const pointer=JSON.parse(repairStored) as {identity?:{installationId?:unknown;experienceKey?:unknown}};
            if(typeof pointer.identity?.installationId!=='string'||typeof pointer.identity.experienceKey!=='string')throw Error('Account reconnection is invalid.');
            const identity={installationId:pointer.identity.installationId,experienceKey:pointer.identity.experienceKey,orgId:org.id,ownerId:user.id,sessionTag:await appConnectionSessionTag(scope)};
            href=`/apps/${encodeURIComponent(identity.installationId)}/${encodeURIComponent(identity.experienceKey)}`;
            const completed=await completeConnectionRepair({search,identity,storage:sessionStorage,current:sameSession,fetch:(path,init)=>api.fetch(path,init)});
            return {href,message:completed.state==='connected'?'Your account is reconnected. Return to the app to continue.':'Account reconnection is not confirmed. Return to the app and check status.',success:completed.state==='connected'};
          }
          if(upgradeStored&&appConnectionCallbackUsesGeneric(search,upgradeStored,nativeMatches,legacyMatches||genericMatches)){
            if(upgradeStored.length>16384)throw Error('Account update is invalid.');
            const pointer=JSON.parse(upgradeStored) as {identity?:{installationId?:unknown;experienceKey?:unknown}};
            if(typeof pointer.identity?.installationId!=='string'||typeof pointer.identity.experienceKey!=='string')throw Error('Account update is invalid.');
            const identity={installationId:pointer.identity.installationId,experienceKey:pointer.identity.experienceKey,orgId:org.id,ownerId:user.id,sessionTag:await appConnectionSessionTag(scope)};
            href=`/apps/${encodeURIComponent(identity.installationId)}/${encodeURIComponent(identity.experienceKey)}`;
            const completed=await completeConnectionUpgrade({search,identity,storage:sessionStorage,current:sameSession,fetch:(path,init)=>api.fetch(path,init)});
            return {href,message:completed.state==='connected'?'Your account access is updated. Return to the app to continue.':'Account update is not confirmed. Return to the app and check status; this attempt will not be repeated.',success:completed.state==='connected'};
          }
          if(genericStored&&appConnectionCallbackUsesGeneric(search,genericStored,nativeMatches,legacyMatches)){
            if(genericStored.length>8192)throw Error('Account setup is invalid.');
            const pointer=JSON.parse(genericStored) as {installationId?:unknown;experienceKey?:unknown};
            if(typeof pointer.installationId!=='string'||typeof pointer.experienceKey!=='string')throw Error('Account setup is invalid.');
            const identity={installationId:pointer.installationId,experienceKey:pointer.experienceKey,orgId:org.id,ownerId:user.id,sessionTag:await appConnectionSessionTag(scope)};
            const completed=await completeAppConnectionSession({search,identity,storage:sessionStorage,current:sameSession,fetch:(path,init)=>api.fetch(path,init)});
            href=`/apps/${encodeURIComponent(identity.installationId)}/${encodeURIComponent(identity.experienceKey)}`;
            return {href,message:completed.state==='connected'?'Your account is connected. Return to the app to continue.':completed.state==='indeterminate'?'Account setup has an uncertain outcome. Return to the app and check connection status; this attempt will not be repeated.':'Account setup was not completed. Return to the app to check its status.',success:completed.state==='connected'};
          }
          const stored = sessionStorage.getItem(APP_CONNECTION_PENDING_KEY);
          sessionStorage.removeItem(APP_CONNECTION_PENDING_KEY);
          const pending = pendingAppConnection(stored ? JSON.parse(stored) : null);
          callbackSessionId = pending.sessionId;
          href = `/apps/${encodeURIComponent(pending.installationId)}/${encodeURIComponent(pending.experienceKey)}`;
          const body = connectionCallback(search, pending);
          const response = await api.fetch(`/api/app-experiences/sessions/${encodeURIComponent(pending.sessionId)}/connections/callback`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          if (!response.ok) throw Error('Account setup was not confirmed. Return to the app to check its status or reconnect.');
          const completed = await response.json() as { state?: string; account?: { health?: string } };
          if (completed.state !== 'connected' || completed.account?.health !== 'connected') throw Error('Account setup was not confirmed. Return to the app to check its status.');
          return { href, message: 'Your account is connected. Return to the app to continue.', success: true };
        } catch (error) {
          return { href, message: error instanceof Error ? error.message : 'Account setup was not confirmed.', success: false };
        } finally {
          // The originating page revoked its Worker but kept this exact bounded
          // session for one callback. Retire it after success, denial or failure.
          if (callbackSessionId) await api.fetch(`/api/app-experiences/sessions/${encodeURIComponent(callbackSessionId)}`, {
            method: 'DELETE', keepalive: true,
          }).catch(() => undefined);
        }
      })();
    }
    // Strict-mode replays subscribe to the same promise; the code is never
    // exchanged twice because an effect or response was interrupted.
    void request.current.then(value => { if (current&&requestAnchor.current?.scope===getActiveSessionCacheScope()&&isSameWebSession(requestAnchor.current.token,api.getAccessToken())) setResult(value); });
    return () => { current = false; };
  }, [sessionCacheScope,user,org]);
  return <main className="mx-auto w-full max-w-xl p-6 sm:p-10">
    <section className="deft-soft-card space-y-4 p-6">
      <h1 className="text-xl font-semibold">Account setup</h1>
      <p role="status" className="text-sm text-[var(--on-surface-variant)]">{result?.message ?? 'Checking your account connection…'}</p>
      {result && <Link className="deft-pill inline-flex items-center" style={{ minHeight: 44 }} href={result.href}>Back to app</Link>}
    </section>
  </main>;
}