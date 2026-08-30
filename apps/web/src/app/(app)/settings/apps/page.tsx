import { notFound } from 'next/navigation';
import { APPS_ENABLED } from '@/lib/feature-flags';
import { AppsClient } from './apps-client';

export default function AppsPage() {
  if (!APPS_ENABLED) notFound();
  return <AppsClient />;
}
