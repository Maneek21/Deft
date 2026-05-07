import { redirect } from 'next/navigation';

export default function ApprovalsRedirect() {
  redirect('/inbox?tab=approvals');
}
