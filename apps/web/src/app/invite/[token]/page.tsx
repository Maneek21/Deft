'use client';

import { use, useEffect, useRef, useState } from 'react';
import { captureLinkToken } from '@/lib/link-token';
import { InviteAccept } from '../invite-accept';

// Legacy invite links (`/invite/<token>`) issued before the token moved after
// `#`. Kept working until those links expire (7 days). The address is
// replaced with `/invite` straight away, so the token leaves the address bar
// and history and is not carried in a later Referer.
export default function LegacyInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: pathToken } = use(params);
  const captured = useRef<string | null | undefined>(undefined);
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setToken(captureLinkToken(captured, window.location, window.history, '/invite', pathToken));
  }, [pathToken]);

  return <InviteAccept token={token} />;
}
