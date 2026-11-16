'use client';

import { useLinkToken } from '@/lib/use-link-token';
import { InviteAccept } from './invite-accept';

// New invite links: `/invite#token=<token>`. The fragment never reaches a
// server, so the token stays out of web-server and proxy logs. Once read, it
// is removed from the address bar. A newly supplied fragment replaces the
// captured token and resets the acceptance form.
export default function InvitePage() {
  const token = useLinkToken();
  return <InviteAccept key={token} token={token} />;
}
