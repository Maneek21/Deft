import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { DEFT_APP_NAME, DEFT_ICON_PATH, DEFT_THEME_COLOR } from '@/lib/web-app-identity';

export const metadata: Metadata = {
  title: {
    default: 'Deft',
    template: '%s — Deft',
  },
  description: 'AI-native workspace',
  // The <link rel="manifest"> tag comes from app/manifest.ts (Next adds it).
  // appleWebApp emits mobile-web-app-capable, apple-mobile-web-app-title and
  // apple-mobile-web-app-status-bar-style.
  appleWebApp: {
    capable: true,
    title: DEFT_APP_NAME,
    statusBarStyle: 'black',
  },
};

export const viewport: Viewport = {
  themeColor: DEFT_THEME_COLOR,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {/* Older iPhone Safari reads only the apple- prefixed tag for Add to
            Home Screen; Next's appleWebApp emits the unprefixed one. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* Only brand icon shipped is 500x400; no 180x180 touch icon exists yet. */}
        <link rel="apple-touch-icon" href={DEFT_ICON_PATH} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
