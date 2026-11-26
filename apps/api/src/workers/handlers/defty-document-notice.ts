// Sends the asker's private notice of the documents left out of a Defty
// reply in a shared chat (plan Task M3, fix round 1; lib/document-audience.ts).
// The reply's own transaction queues this job, so it runs only for a reply
// that was written. The notice names each item as the asker can see it when
// the job runs, and is sent once per reply whatever the retries.
import { documentNoticeJobData, sendWithheldDocumentNotice } from '../../lib/document-audience.js';
import type { JobData } from '../types.js';

export async function handleDeftyDocumentNotice(job: JobData): Promise<void> {
  const notice = documentNoticeJobData(job.data);
  if (!notice) return;
  // The queue row's own workspace, when known, must be the notice's.
  if (job.orgId && job.orgId !== notice.orgId) return;
  await sendWithheldDocumentNotice(notice);
}
