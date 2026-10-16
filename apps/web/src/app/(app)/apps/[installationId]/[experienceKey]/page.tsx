import { notFound } from 'next/navigation';
import { InstalledAppExperience } from '@/components/apps/installed-app-experience';
import { APPS_ENABLED } from '@/lib/feature-flags';

export default async function InstalledExperiencePage({ params }: {
  params: Promise<{ installationId: string; experienceKey: string }>;
}) {
  if (!APPS_ENABLED) notFound();
  const { installationId, experienceKey } = await params;
  return <InstalledAppExperience key={`${installationId}/${experienceKey}`}
    installationId={installationId} experienceKey={experienceKey} />;
}
