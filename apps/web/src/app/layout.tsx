import type { Metadata, Viewport } from 'next';
// Inter and JetBrains Mono are served from this app (fonts bundled by Next
// under /_next/static/media), never from Google: no page, the signup and
// setup pages included, makes a request outside the app's origin for fonts.
// Same faces, weights and subsets the Google Fonts link loaded.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
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
  appleWebApp: process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL === 'true' ? {
    capable: true,
    title: DEFT_APP_NAME,
    statusBarStyle: 'black',
  } : undefined,
};

export const viewport: Viewport = {
  themeColor: process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL === 'true' ? DEFT_THEME_COLOR : undefined,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {/* Older iPhone Safari reads only the apple- prefixed tag for Add to
            Home Screen; Next's appleWebApp emits the unprefixed one. */}
        {process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL === 'true' && <>
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <link rel="apple-touch-icon" href={DEFT_ICON_PATH} />
        </>}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
