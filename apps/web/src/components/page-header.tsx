import { ReactNode } from 'react';

type Props = {
  /** Page title. Hidden on mobile if `compact` (the AppHeader pageContext slot will carry it). */
  title: string;
  /** Optional 1-line description. Hidden on mobile to save vertical space. */
  description?: string;
  /** Primary action(s) — render in the right of the title row. ≤2 buttons recommended on mobile. */
  primary?: ReactNode;
  /** Secondary row — typically a TabStrip or filter set. Renders below the title. */
  secondary?: ReactNode;
  /** When true, hides title+description on mobile. Use when the page wires AppHeader pageContext slot. */
  compact?: boolean;
};

/**
 * Standard page header. Use for every top-level route under (app).
 * On mobile, pair with AppHeader.pageContext to avoid duplicating the title.
 */
export function PageHeader({ title, description, primary, secondary, compact }: Props) {
  return (
    <div className="flex flex-col gap-2 px-4 pt-2 pb-3">
      <div className={compact ? 'hidden md:flex items-center gap-3' : 'flex items-center gap-3'}>
        <h1 className="text-[1.5rem] font-semibold flex-1 truncate" style={{ color: 'var(--on-surface)' }}>
          {title}
        </h1>
        {primary && <div className="flex items-center gap-2">{primary}</div>}
      </div>
      {description && (
        <p className="hidden md:block text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
          {description}
        </p>
      )}
      {secondary && <div className="-mx-1">{secondary}</div>}
    </div>
  );
}
