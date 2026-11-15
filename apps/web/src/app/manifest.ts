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
 * Icons: the only brand icon shipped today is 500x400 and is declared at its
 * real size only. Square 192x192 and 512x512 icons (and a maskable variant)
 * do not exist yet; they are missing artwork, not invented here.
 */
export default function manifest(): MetadataRoute.Manifest {
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
        sizes: '500x400',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
