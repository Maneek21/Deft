'use client';

import { useEffect, useState } from 'react';
import { readLinkToken } from '@/lib/link-token';
import { InviteAccept } from './invite-accept';

// New invite links: `/invite#token=<token>`. The fragment never reaches a
// server, so the token stays out of web-server and proxy logs.
export default function InvitePage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setToken(readLinkToken(window.location.hash));
  }, []);

  return <InviteAccept token={token} />;
}
