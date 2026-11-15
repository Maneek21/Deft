'use client';

import { useEffect, useRef, useState } from 'react';
import { captureLinkToken } from '@/lib/link-token';
import { InviteAccept } from './invite-accept';

// New invite links: `/invite#token=<token>`. The fragment never reaches a
// server, so the token stays out of web-server and proxy logs. Once read, it
// is removed from the address bar; the ref keeps the first read so
// StrictMode's second mount effect does not see an empty address.
export default function InvitePage() {
  const captured = useRef<string | null | undefined>(undefined);
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setToken(captureLinkToken(captured, window.location, window.history, '/invite'));
  }, []);

  return <InviteAccept token={token} />;
}
