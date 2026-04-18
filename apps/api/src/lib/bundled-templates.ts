/**
 * First-class bundled task templates. Replaces the nested `task_templates`
 * jsonb that previously lived inside `skills.project_config`.
 *
 * Re-extracted from the former Marketing Campaign and Sales Pipeline
 * bundled skills so day-one users still get the same starting bundles
 * they had before the simplification.
 */

export type TemplateTask = {
  title: string;
  status?: string;        // defaults to 'todo' at apply time
  priority?: string;      // defaults to 'p2' at apply time
  due_offset_days?: number;
  description?: string;
  labels?: string[];
};

export type BundledTemplate = {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  version: string;
  tasks: TemplateTask[];
};

const DEFAULT_VERSION = '1.0.0';

const launchCampaign: BundledTemplate = {
  id: 'template_bundled_launch-campaign',
  slug: 'launch-campaign',
  name: 'Launch Campaign',
  description:
    '7-task marketing launch bundle: brief, assets, announcement copy, social teasers, day-of blast, follow-up, retro.',
  icon: null,
  version: DEFAULT_VERSION,
  tasks: [
    { title: 'Draft launch brief', due_offset_days: 0 },
    { title: 'Design launch assets', due_offset_days: 3 },
    { title: 'Write announcement copy', due_offset_days: 4 },
    { title: 'Schedule social teasers', due_offset_days: 5 },
    { title: 'Publish launch announcement', due_offset_days: 7 },
    { title: 'Send follow-up newsletter', due_offset_days: 9 },
    { title: 'Launch retrospective', due_offset_days: 14 },
  ],
};

const reEngageSequence: BundledTemplate = {
  id: 'template_bundled_re-engage-sequence',
  slug: 're-engage-sequence',
  name: 'Re-engage Sequence',
  description:
    '14-day cadence for warming up cold deals: outreach touches, personalized follow-ups, hand-off checkpoints.',
  icon: null,
  version: DEFAULT_VERSION,
  tasks: [
    { title: 'Research account history', due_offset_days: 0 },
    { title: 'Send initial re-engage email', due_offset_days: 1 },
    { title: 'LinkedIn touch', due_offset_days: 2 },
    { title: 'Follow-up email with value offer', due_offset_days: 4 },
    { title: 'Phone call attempt', due_offset_days: 5 },
    { title: 'Share relevant case study', due_offset_days: 6 },
    { title: 'Loop in champion / exec sponsor', due_offset_days: 7 },
    { title: 'Second phone attempt', due_offset_days: 9 },
    { title: 'Personalized video message', due_offset_days: 10 },
    { title: 'Final email — breakup note', due_offset_days: 12 },
    { title: 'Log disposition + notes', due_offset_days: 13 },
    { title: 'Hand off to AE or archive', due_offset_days: 14 },
    { title: 'Schedule 30-day re-touch', due_offset_days: 14 },
    { title: 'Write retro / what worked', due_offset_days: 14 },
  ],
};

export const BUNDLED_TEMPLATES: BundledTemplate[] = [launchCampaign, reEngageSequence];
