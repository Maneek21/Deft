'use client';

import { use } from 'react';
import { InviteAccept } from '../invite-accept';

// Legacy invite links (`/invite/<token>`) issued before the token moved after
// `#`. Kept working until those links expire (7 days).
export default function LegacyInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <InviteAccept token={token} />;
}
