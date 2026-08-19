import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Logo } from '@/components/brand/logo';

export const metadata = { title: 'License and source' };
export const dynamic = 'force-dynamic';

const DEFAULT_SOURCE_URL = 'https://github.com/Maneek21/Deft';

function resolveSourceUrl(value: string | undefined) {
  if (!value) return DEFAULT_SOURCE_URL;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : DEFAULT_SOURCE_URL;
  } catch {
    return DEFAULT_SOURCE_URL;
  }
}

export default function LicensePage() {
  const sourceUrl = resolveSourceUrl(
    process.env.DEFT_SOURCE_CODE_URL || process.env.DEFT_BUILD_SOURCE_URL,
  );

  return (
    <main className="min-h-screen overflow-y-auto px-5 py-10" style={{ background: 'var(--surface-lowest)', color: 'var(--foreground)' }}>
      <div className="mx-auto max-w-2xl">
        <Logo variant="wordmark" className="h-9 w-auto" priority />

        <section className="mt-8 rounded-xl p-6 md:p-8" style={{ background: 'var(--surface-dim)', border: '1px solid var(--ghost-border)' }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--text-tertiary)' }}>Free software</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">License and source</h1>
          <p className="mt-4 text-[14px] leading-6" style={{ color: 'var(--text-secondary)' }}>
            Deft is Copyright © 2026 Maneek Mohan and Deft contributors and is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only).
          </p>
          <p className="mt-3 text-[14px] leading-6" style={{ color: 'var(--text-secondary)' }}>
            Deft is provided without warranty. You may run, study, modify, and redistribute it under the license terms. If this server runs a modified version, the source link below is the operator&apos;s offer of the Corresponding Source required by AGPL section 13.
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="deft-soft-card flex items-center justify-between gap-3 p-4 text-[13px] font-semibold"
            >
              Corresponding source <ExternalLink size={15} aria-hidden="true" />
            </a>
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              target="_blank"
              rel="noreferrer"
              className="deft-soft-card flex items-center justify-between gap-3 p-4 text-[13px] font-semibold"
            >
              GNU AGPL v3 terms <ExternalLink size={15} aria-hidden="true" />
            </a>
          </div>
        </section>

        <Link href="/dashboard" className="mt-6 inline-flex min-h-11 items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--primary)' }}>
          <ArrowLeft size={15} aria-hidden="true" /> Back to Deft
        </Link>
      </div>
    </main>
  );
}
