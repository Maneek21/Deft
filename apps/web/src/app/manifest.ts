import type { MetadataRoute } from 'next';
import {
  DEFT_APP_NAME,
  DEFT_BACKGROUND_COLOR,
  DEFT_ICON_PATH,
  DEFT_THEME_COLOR,
} from '@/lib/web-app-identity';

/**
 * Web app manifest, served by Next at /manifest.webmanifest. Next adds the
 * <link rel="manifest"> tag to every page because this file exists.
 *
 * Every address here is relative to the page's own origin, so the prebuilt
 * image needs no start-time address injection for it, and the default
 * Content-Security-Policy (`default-src 'self'`) already allows it.
 *
 * Square icons use the existing logo on the app background. The maskable
 * variant keeps the complete logo inside the central safe circle.
 */
export default function manifest(): MetadataRoute.Manifest {
  if (process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL !== 'true') return {};
  return {
    id: '/',
    name: DEFT_APP_NAME,
    short_name: DEFT_APP_NAME,
    description: 'AI-native workspace',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: DEFT_BACKGROUND_COLOR,
    theme_color: DEFT_THEME_COLOR,
    icons: [
      {
        src: DEFT_ICON_PATH,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      { src: '/brand/deft-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/brand/deft-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
