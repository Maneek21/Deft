export function SettingsSteps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <nav aria-label="Setup progress" className="mb-6">
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {steps.map((label, index) => (
          <li key={label} aria-current={index === current ? 'step' : undefined} className="flex items-center gap-2 text-xs" style={{ color: index === current ? 'var(--accent)' : 'var(--text-secondary)' }}>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-medium" style={{ borderColor: index === current ? 'var(--accent)' : 'var(--border-default)' }}>{index + 1}</span>
            <span className={index === current ? 'font-semibold' : ''}>{label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
