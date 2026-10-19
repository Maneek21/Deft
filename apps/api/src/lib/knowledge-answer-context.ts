import { toPlainText } from './plain-text.js';

export type KnowledgeAnswerSource = {
  index: number; source_id: string; title: string; type: string; scope: string | null;
  confidence: number | null; score: number; summary: string | null; excerpt: string; content: string;
};
export const KNOWLEDGE_SOURCE_CONTEXT_LIMIT = 6000;
export const KNOWLEDGE_TOTAL_CONTEXT_LIMIT = 24000;

export function buildKnowledgeAnswerContext(sources: KnowledgeAnswerSource[]) {
  const parts: string[] = [];
  const coverage: Array<{source_id:string; included_characters:number; total_characters:number; truncated:boolean}> = [];
  let remaining = KNOWLEDGE_TOTAL_CONTEXT_LIMIT;
  for (const [position, source] of sources.entries()) {
    const content = toPlainText(source.content);
    const separator = parts.length ? '\n\n' : '';
    const allocation = Math.min(KNOWLEDGE_SOURCE_CONTEXT_LIMIT - separator.length,
      Math.floor(Math.max(0, remaining - separator.length) / (sources.length - position)));
    const title = toPlainText(source.title).slice(0, 200);
    const summary = toPlainText(source.summary).slice(0, 500);
    const header = [
      `[${source.index}] ${title}`,
      `Type: ${source.type.slice(0, 48)}; Scope: ${(source.scope ?? 'unknown').slice(0, 48)}; Confidence: ${source.confidence ?? 'unknown'}; Score: ${Number.isFinite(source.score) ? source.score.toFixed(3) : 'unknown'}`,
      summary ? `Summary: ${summary}` : null,
    ].filter(Boolean).join('\n') + '\n';
    const label = (included:number, truncated:boolean) =>
      `Content coverage: ${truncated ? 'truncated' : 'full'}; included ${included}/${content.length} characters.\nContent: `;
    // Reserve the longest coverage label as part of the source allocation.
    // Titles/summaries cannot consume the budget reserved for actual content.
    const reservedLabel = label(content.length, true);
    const boundedHeader = header.slice(0, Math.max(0, allocation - reservedLabel.length - Math.min(content.length, 1)));
    const body = content.slice(0, Math.max(0, allocation - boundedHeader.length - reservedLabel.length));
    const truncated = body.length < content.length;
    const part = (boundedHeader + label(body.length, truncated) + body).slice(0, allocation);
    if (part) {
      parts.push(separator + part);
      remaining -= separator.length + part.length;
    }
    coverage.push({source_id:source.source_id, included_characters:body.length,
      total_characters:content.length, truncated});
  }
  return {text:parts.join(''), coverage};
}
