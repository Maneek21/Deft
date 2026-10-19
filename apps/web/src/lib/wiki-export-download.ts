type ExportResponse = Pick<Response, 'ok' | 'blob' | 'headers'>;
type DownloadAnchor = { href: string; download: string; rel: string; click: () => void; remove: () => void };
type DownloadEnvironment = { createUrl: (blob: Blob) => string; revokeUrl: (url: string) => void; anchor: () => DownloadAnchor; append: (anchor: DownloadAnchor) => void; defer: (callback: () => void) => void };
export function createWikiExportDownload(input: {
  get: (path: string) => Promise<ExportResponse>;
  currentSession: () => string | null;
  state: (busy: boolean, error: string | null) => void;
  environment?: DownloadEnvironment;
}) {
  let busy = false;
  const environment = input.environment ?? {
    createUrl: (blob: Blob) => URL.createObjectURL(blob), revokeUrl: (url: string) => URL.revokeObjectURL(url),
    anchor: () => document.createElement('a'), append: (anchor: DownloadAnchor) => document.body.appendChild(anchor as HTMLAnchorElement),
    defer: (callback: () => void) => { window.setTimeout(callback, 0); },
  };
  return async () => {
    if (busy) return false;
    const session = input.currentSession();
    if (!session) { input.state(false, 'Sign in to export Knowledge.'); return false; }
    const current = () => input.currentSession() === session;
    busy = true; input.state(true, null);
    let failure: string | null = null;
    let objectUrl: string | null = null;
    let anchor: DownloadAnchor | null = null;
    try {
      const response = await input.get('/api/wiki/export?format=md');
      if (!current()) return false;
      if (!response.ok || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/markdown') throw new Error('Export unavailable');
      const blob = await response.blob();
      if (!current()) return false;
      objectUrl = environment.createUrl(blob);
      anchor = environment.anchor(); anchor.href = objectUrl; anchor.download = 'wiki-export.md'; anchor.rel = 'noopener';
      environment.append(anchor); anchor.click();
      return true;
    } catch {
      if (current()) failure = 'Knowledge could not be exported. Please try again.';
      return false;
    } finally {
      anchor?.remove();
      if (objectUrl) { const ownedUrl = objectUrl; environment.defer(() => environment.revokeUrl(ownedUrl)); }
      busy = false; input.state(false, current() ? failure : null);
    }
  };
}
