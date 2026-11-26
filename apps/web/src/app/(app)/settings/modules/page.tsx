import { redirect } from 'next/navigation';

// Settings → Modules became part of the one Apps page.
export default function ModulesSettingsRedirect() {
  redirect('/settings/apps');
}
