import { redirect } from 'next/navigation';

export default async function AgentEmployeeIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/settings/agent-employees/${id}/developer`);
}
