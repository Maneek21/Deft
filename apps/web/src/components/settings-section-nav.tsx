'use client';

/** Section buttons keep each form mounted so switching sections preserves drafts. */
export function SettingsSectionNav<T extends string>({
  label,
  sections,
  value,
  onChange,
}: {
  label: string;
  sections: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <nav aria-label={label} className="mb-6 flex flex-wrap gap-1 rounded-xl border p-1" style={{ borderColor: 'var(--border)', background: 'var(--surface-container-low)' }}>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          aria-pressed={value === section.id}
          onClick={() => onChange(section.id)}
          className="min-h-10 rounded-lg px-3 py-2 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            background: value === section.id ? 'var(--accent-subtle)' : 'transparent',
            color: value === section.id ? 'var(--primary)' : 'var(--foreground-secondary)',
          }}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
