export const PILOT_PROOF_MESSAGE_SEED = 'pilot-polish';

export const PILOT_SIMULATED_HISTORY_METADATA = {
  simulated_history: true,
  simulation_source: 'seed-pilot-workspace',
  simulation_note:
    'Synthetic pilot history created for a repeatable product walkthrough; it was not emitted by the live observation runtime.',
} as const;

export type PilotMessageRef = {
  id: string;
  org_id: string;
  space_id: string;
  user_id: string;
  content: string;
  is_deleted: boolean;
  metadata: unknown;
  created_at: Date;
};

export type PilotKnowledgePageRef = {
  id: string;
  slug: string;
  title: string;
  type: string;
};

type PilotReceiptSource =
  | 'pilotProof'
  | 'marketingDecision'
  | 'blockerMessage'
  | 'opsUpdate'
  | 'buyerUpdate'
  | 'fieldUpdate';

type PilotKnowledgeReceiptDefinition = {
  source: PilotReceiptSource;
  kind: 'decision_candidate' | 'resource_candidate';
  title: string;
  slug: string;
  action: 'wiki_create' | 'wiki_update';
  summary: string;
};

const PILOT_KNOWLEDGE_RECEIPT_DEFINITIONS = [
  {
    source: 'pilotProof',
    kind: 'decision_candidate',
    title: 'Company Memory Proof Protocol',
    slug: 'company-memory-proof-protocol',
    action: 'wiki_create',
    summary: 'The clean pilot assigns clear agent ownership and defines the shared-memory proof marker.',
  },
  {
    source: 'marketingDecision',
    kind: 'decision_candidate',
    title: 'Sun Gold Trial Launch Decision',
    slug: 'sun-gold-trial-launch-decision',
    action: 'wiki_create',
    summary: 'Launch copy can proceed while delivery language remains gated by route confirmation.',
  },
  {
    source: 'blockerMessage',
    kind: 'decision_candidate',
    title: 'Tuesday Route Promise Gate',
    slug: 'tuesday-route-promise-gate',
    action: 'wiki_create',
    summary: 'Buyer-facing Tuesday delivery language remains blocked until route capacity is confirmed.',
  },
  {
    source: 'opsUpdate',
    kind: 'resource_candidate',
    title: 'Update knowledge: Tuesday Route Promise Gate',
    slug: 'tuesday-route-promise-gate',
    action: 'wiki_update',
    summary: 'The northern route remains the constraint and requires the 11:30 operating check.',
  },
  {
    source: 'buyerUpdate',
    kind: 'resource_candidate',
    title: 'Update knowledge: Chef Amara Account Brief',
    slug: 'chef-amara-account-brief',
    action: 'wiki_update',
    summary: 'Chef Amara values practical prep notes while route promises remain conditional.',
  },
  {
    source: 'fieldUpdate',
    kind: 'resource_candidate',
    title: 'Update knowledge: Cold-room Handoff SOP',
    slug: 'cold-room-handoff-sop',
    action: 'wiki_update',
    summary: 'The credible launch image is the harvest bin beside the cold-room handoff.',
  },
] as const satisfies readonly PilotKnowledgeReceiptDefinition[];

export const PILOT_KNOWLEDGE_PAGE_SLUGS = [...new Set(
  PILOT_KNOWLEDGE_RECEIPT_DEFINITIONS.map((definition) => definition.slug),
)];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pilotProofMessageMetadata(proofPhrase: string): Record<string, unknown> {
  return {
    seed: PILOT_PROOF_MESSAGE_SEED,
    knowledge_marker: proofPhrase,
    ...PILOT_SIMULATED_HISTORY_METADATA,
  };
}

export function isReusablePilotProofMessage(
  candidate: PilotMessageRef,
  expected: {
    orgId: string;
    spaceId: string;
    userId: string;
    content: string;
    proofPhrase: string;
  },
): boolean {
  if (
    candidate.org_id !== expected.orgId ||
    candidate.space_id !== expected.spaceId ||
    candidate.user_id !== expected.userId ||
    candidate.content !== expected.content ||
    candidate.is_deleted
  ) {
    return false;
  }

  return isRecord(candidate.metadata) &&
    candidate.metadata.seed === PILOT_PROOF_MESSAGE_SEED &&
    candidate.metadata.knowledge_marker === expected.proofPhrase;
}

export function pilotCitationIdentity(citation: {
  page_id: string;
  source_type: string;
  source_id: string;
}): string {
  return `${citation.page_id}:${citation.source_type}:${citation.source_id}`;
}

export function buildPilotKnowledgeReceiptPlan(params: {
  orgId: string;
  convertedBy: string;
  sources: Record<PilotReceiptSource, PilotMessageRef>;
  pages: PilotKnowledgePageRef[];
}) {
  const pageBySlug = new Map(params.pages.map((page) => [page.slug, page]));
  const missingSlugs = [...new Set(
    PILOT_KNOWLEDGE_RECEIPT_DEFINITIONS
      .filter((definition) => !pageBySlug.has(definition.slug))
      .map((definition) => definition.slug),
  )];

  const resolved = PILOT_KNOWLEDGE_RECEIPT_DEFINITIONS.flatMap((definition) => {
    const page = pageBySlug.get(definition.slug);
    if (!page) return [];
    return [{ definition, message: params.sources[definition.source], page }];
  });

  const intentRows = resolved.map(({ definition, message, page }) => ({
    org_id: params.orgId,
    space_id: message.space_id,
    source_message_id: message.id,
    source_user_id: message.user_id,
    kind: definition.kind,
    status: 'converted' as const,
    title: definition.title,
    summary: definition.summary,
    proposed_action: definition.action,
    proposed_params: {
      source_message_id: message.id,
      source_space_id: message.space_id,
      source_user_id: message.user_id,
      target_wiki_page_id: page.id,
      target_wiki_slug: page.slug,
      target_wiki_title: page.title,
    },
    dedupe_key: `pilot_seed:knowledge_receipt:${message.id}:${page.slug}`,
    converted_by: params.convertedBy,
    // The timestamp is intentionally backdated to the simulated source event so
    // the demo reads as a coherent history rather than a just-seeded data dump.
    converted_at: message.created_at,
    metadata: {
      seed: 'pilot-living',
      extraction: 'seeded_episode',
      batch_capture: true,
      episode_capture: true,
      batch_message_ids: [message.id],
      converted_wiki_slug: page.slug,
      converted_wiki_page_id: page.id,
      converted_wiki_title: page.title,
      converted_wiki_type: page.type,
      ...PILOT_SIMULATED_HISTORY_METADATA,
      ...(definition.action === 'wiki_update' ? { update_kind: 'wiki_content' } : {}),
    },
    created_at: message.created_at,
    updated_at: message.created_at,
  }));

  const citationRows = resolved.map(({ definition, message, page }) => ({
    org_id: params.orgId,
    page_id: page.id,
    source_type: 'message',
    source_id: message.id,
    source_space_id: message.space_id,
    source_user_id: message.user_id,
    excerpt: definition.summary,
    created_at: message.created_at,
  }));

  return {
    missingSlugs,
    intentRows,
    citationRows,
  };
}
