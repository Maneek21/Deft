import { ArrowUpRight } from 'lucide-react';

/** Navigation rechecks original access; a retained Knowledge copy is independent. */
export function AppIntegrationKnowledgeCitation(source: { source_url?: string | null; source_label?: string }) {
  const href = typeof source.source_url === 'string'
    && /^\/apps\/source\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(source.source_url)
    ? source.source_url : null;
  return href ? (
    <a href={href} className="inline-flex items-center gap-1 font-medium hover:underline"
      style={{ color: 'var(--accent)' }} title="Opening the original source requires current app access">
      {source.source_label || 'App source'} <ArrowUpRight size={10} />
    </a>
  ) : (
    <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
      {source.source_label || 'App source'} · original access unavailable
    </span>
  );
}
