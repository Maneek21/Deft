import Link from 'next/link';
import { Logo } from '@/components/brand/logo';

export default function NotFound() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-8 p-4 relative overflow-hidden"
      style={{ background: 'var(--surface-lowest)' }}
    >
      {/* Decorative backdrop */}
      <div className="fixed top-1/3 left-1/3 w-[400px] h-[400px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(100px)', opacity: 0.2 }} />

      <Logo variant="wordmark" className="h-10 w-auto" priority />

      <div className="text-center space-y-2">
        <h1 className="text-[1.5rem] font-semibold" style={{ color: 'var(--on-surface)', letterSpacing: '-0.01em' }}>
          Page not found
        </h1>
        <p className="text-[0.875rem]" style={{ color: 'var(--outline)' }}>
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>

      <Link
        href="/dashboard"
        className="h-10 px-5 flex items-center text-[0.875rem] font-medium text-white active:scale-[0.98]"
        style={{
          background: 'var(--primary-container)',
          borderRadius: '0.5rem',
        }}
      >
        Go to Dashboard
      </Link>
    </div>
  );
}
