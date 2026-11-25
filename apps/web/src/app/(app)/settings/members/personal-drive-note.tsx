/**
 * The remove-member dialog's line about the person's personal drive (spec
 * 5.2): it goes to the replacement chosen for their work, or, with no
 * replacement, it is frozen until the workspace owner hands it on.
 */
export function personalDriveOutcome(replacementName: string | null): string {
  const name = replacementName?.trim();
  return name ? `Their personal drive goes to ${name}.` : 'Their personal drive will be frozen until an owner hands it on.';
}

export function PersonalDriveNote({ replacementName }: { replacementName: string | null }) {
  return (
    <p data-testid="offboarding-personal-drive" className="rounded-md px-2 py-2 text-[11px]" style={{ background: 'var(--card-bg)', color: 'var(--muted)' }}>
      {personalDriveOutcome(replacementName)}
    </p>
  );
}
