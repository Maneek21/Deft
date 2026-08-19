import { redirect } from 'next/navigation';
import { MODULE_SETTINGS_HREF } from '@/lib/module-navigation';

export default function ModulesCompatibilityPage() {
  redirect(MODULE_SETTINGS_HREF);
}
