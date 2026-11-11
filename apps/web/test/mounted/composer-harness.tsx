'use client';

import { createRoot } from 'react-dom/client';
import { RichComposer } from '@/components/rich-composer';
import { api } from '@/lib/api';

// A JWT-shaped token: the mention popup only shows members loaded for the
// same web session, and the native-mention capability check keys on it. The
// mocked capability read returns no `enabled`, so native mentions stay off.
const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const SESSION_TOKEN = `${encode({ alg: 'none' })}.${encode({ id: 'u-priya', org_id: 'org-1', sid: 'mounted' })}.sig`;

/** The production chat composer with the network boundary replaced. Sent HTML lands in window.__deftSent. */
declare global {
  interface Window {
    __deftSent?: string[];
  }
}

function Harness() {
  return (
    <RichComposer
      placeholder="Message #launch"
      onSend={async (html) => { window.__deftSent!.push(html); }}
      pendingFiles={[]}
      onRemovePendingFile={() => {}}
      onFileSelect={() => {}}
      onPaste={() => {}}
      uploading={false}
      uploadProgress={0}
    />
  );
}

if (typeof window !== 'undefined') {
  window.__deftSent = [];
  localStorage.setItem('deft-access-token', SESSION_TOKEN);
  (api as { getAccessToken: () => string }).getAccessToken = () => SESSION_TOKEN;
  createRoot(document.getElementById('root')!).render(<Harness />);
}
