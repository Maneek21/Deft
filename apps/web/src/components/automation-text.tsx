import type { ReactNode } from 'react';

function inlineParts(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index} className="rounded px-1 py-0.5 text-[0.92em]" style={{ background: 'var(--surface-container-highest)' }}>{part.slice(1, -1)}</code>;
    }
    return <span key={index}>{part}</span>;
  });
}

export function plainAutomationText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function AutomationText({ text, className = '' }: { text: string; className?: string }) {
  const lines = text.split('\n');
  return (
    <div className={`space-y-1.5 ${className}`}>
      {lines.map((rawLine, index) => {
        const line = rawLine.trim();
        if (!line) return null;
        const heading = line.match(/^\*\*([^*]+)\*\*$/);
        if (heading) {
          return <p key={index} className="pt-1 text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{heading[1]}</p>;
        }
        const bullet = line.match(/^[-*]\s+(.+)$/);
        if (bullet) {
          return (
            <div key={index} className="flex gap-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              <span aria-hidden="true" style={{ color: 'var(--accent)' }}>•</span>
              <span>{inlineParts(bullet[1]!)}</span>
            </div>
          );
        }
        return <p key={index} className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{inlineParts(line)}</p>;
      })}
    </div>
  );
}
