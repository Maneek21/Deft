'use client';

/**
 * Legacy redirect — the 7-step deploy wizard was retired in Block 0 of the
 * OpenClaw Unlock. The canonical agent-create flow is the 3-step wizard at
 * /settings/agent-employees/create. Kept as a stub so existing bookmarks
 * continue to work.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function DeployRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/settings/agent-employees/create');
  }, [router]);
  return null;
}
