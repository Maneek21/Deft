// Handler: memory-capture - routes explicit decisions/resources through
// Defty's approval ledger instead of silently writing wiki pages.
import type { JobData } from '../types.js';
import { queueDeftyKnowledgeCapture } from '../../lib/defty-capture.js';
import { toPlainText, truncatePlainText } from '../../lib/plain-text.js';

interface MemoryCaptureJobData {
  messageId: string;
  spaceId: string;
  content: string;
  orgId: string;
  userId: string;
  decision?: string | null;
  facts?: string[];
}

export function extractResourceCandidate(content: string): {
  title: string;
  content: string;
  url?: string;
} | null {
  const plain = toPlainText(content);
  const explicit = plain.match(/\b(?:resource|reference|link|doc|docs|checklist)\s*:\s*(.+)$/i);
  const url = plain.match(/https?:\/\/[^\s<>"')]+/i)?.[0];
  if (!explicit && !url) return null;

  const lower = plain.toLowerCase();
  const hasResourceLanguage =
    !!explicit ||
    /\b(?:save|capture|remember|canonical|reference|resource|checklist|doc|docs|link|source)\b/.test(lower);
  if (!hasResourceLanguage) return null;

  const body = (explicit?.[1] ?? plain).trim();
  const titleSeed = body
    .replace(url ?? '', '')
    .replace(/\s*[-:]\s*$/g, '')
    .trim() || url || 'Resource from chat';
  return {
    title: truncatePlainText(titleSeed, 90) || 'Resource from chat',
    content: plain,
    url,
  };
}

function decisionTitle(decision: string, fallbackContent: string): string {
  const candidate = toPlainText(decision || fallbackContent)
    .replace(/^\s*(?:decision|decided|we decided|we agreed|agreed)\s*:?\s*/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  return truncatePlainText(candidate || 'Decision from chat', 90) || 'Decision from chat';
}

function noteTitle(fact: string): string {
  const candidate = toPlainText(fact)
    .replace(/^\s*(?:fact|preference|policy|note)\s*:?\s*/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  return truncatePlainText(candidate || 'Note from chat', 90) || 'Note from chat';
}

function tokenOverlap(a: string, b: string): number {
  const tokensFor = (value: string) => new Set(
    toPlainText(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
  const left = tokensFor(a);
  const right = tokensFor(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return intersection / union;
}

function dedupeSimilarFacts(facts: string[]): string[] {
  const kept: string[] = [];
  for (const fact of facts) {
    if (!kept.some((existing) => tokenOverlap(existing, fact) >= 0.6)) {
      kept.push(fact);
    }
  }
  return kept;
}

export async function handleMemoryCapture(job: JobData) {
  const data = job.data as MemoryCaptureJobData;
  const {
    messageId,
    spaceId,
    content,
    orgId,
    userId,
    decision,
    facts,
  } = data;

  if (decision?.trim()) {
    const queued = await queueDeftyKnowledgeCapture({
      orgId,
      sourceUserId: userId,
      spaceId,
      messageId,
      content: decision,
      title: decisionTitle(decision, content),
      summary: decision,
      wikiType: 'decision',
      captureKind: 'decision_candidate',
      captureReason: 'Chat classifier found an explicit team decision.',
      extraction: 'classifier',
      tags: ['decision', 'defty-capture'],
      metadata: {
        source: 'memory_capture',
        classifier_decision: decision,
      },
    });
    if (queued.queued) {
      console.log(`[memory-capture] Queued decision capture for message ${messageId}`);
    } else {
      console.log(`[memory-capture] Skipped decision capture for message ${messageId}: ${queued.skippedReason}`);
    }
  }

  const factCandidates = dedupeSimilarFacts([...new Set(
    (Array.isArray(facts) ? facts : [])
      .map((fact) => fact?.trim())
      .filter((fact): fact is string => Boolean(fact)),
  )]);
  if (factCandidates.length > 0) {
    const noteContent = factCandidates.join('\n');
    const firstFact = factCandidates[0] ?? 'Note from chat';
    const queued = await queueDeftyKnowledgeCapture({
      orgId,
      sourceUserId: userId,
      spaceId,
      messageId,
      content: noteContent,
      title: factCandidates.length === 1 ? noteTitle(firstFact) : 'Facts and preferences from chat',
      summary: noteContent,
      wikiType: 'fact',
      captureKind: 'note_candidate',
      captureReason: 'Chat classifier found an explicit fact, preference, or policy worth reviewing.',
      extraction: 'classifier',
      tags: ['fact', 'defty-capture'],
      metadata: {
        source: 'memory_capture',
        classifier_facts: factCandidates,
      },
    });
    if (queued.queued) {
      console.log(`[memory-capture] Queued note capture for message ${messageId}`);
    } else {
      console.log(`[memory-capture] Skipped note capture for message ${messageId}: ${queued.skippedReason}`);
    }
  }

  const resource = extractResourceCandidate(content);
  if (resource) {
    const queued = await queueDeftyKnowledgeCapture({
      orgId,
      sourceUserId: userId,
      spaceId,
      messageId,
      content: resource.content,
      title: resource.title,
      summary: resource.content,
      wikiType: 'resource',
      captureKind: 'resource_candidate',
      captureReason: 'Chat message looked like a resource worth saving to knowledge.',
      extraction: 'deterministic',
      tags: ['resource', 'defty-capture'],
      metadata: {
        source: 'memory_capture',
        url: resource.url ?? null,
      },
    });
    if (queued.queued) {
      console.log(`[memory-capture] Queued resource capture for message ${messageId}`);
    } else {
      console.log(`[memory-capture] Skipped resource capture for message ${messageId}: ${queued.skippedReason}`);
    }
  }
}
