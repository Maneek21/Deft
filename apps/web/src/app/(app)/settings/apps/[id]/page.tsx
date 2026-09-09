import { notFound } from 'next/navigation';
import { APPS_ENABLED } from '@/lib/feature-flags';
import { AppsClient } from '../apps-client';

export default async function AppSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  if (!APPS_ENABLED) notFound();
  const { id } = await params;
  return <AppsClient selectedId={id} />;
}
