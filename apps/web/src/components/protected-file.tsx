'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { fetchProtectedFile } from '@/lib/protected-file';

export type ProtectedFileDescriptor = {
  id: string;
  name: string;
};

type ProtectedImageProps = {
  file: ProtectedFileDescriptor;
  alt?: string;
  className?: string;
  buttonClassName?: string;
  onOpen?: (objectUrl: string) => void;
};

export function ProtectedImage({
  file,
  alt = file.name,
  className,
  buttonClassName,
  onOpen,
}: ProtectedImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let nextObjectUrl: string | null = null;
    setObjectUrl(null);
    setError(null);

    void fetchProtectedFile(file.id, undefined, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        nextObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(nextObjectUrl);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Unable to open attachment');
      });

    return () => {
      controller.abort();
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [file.id]);

  if (error) {
    return (
      <div
        role="alert"
        className="px-3 py-2 text-[12px] rounded-lg"
        style={{ background: 'var(--surface-container)', color: 'var(--on-surface-variant)' }}
      >
        {file.name}: {error}
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div
        role="status"
        aria-label={`Loading ${file.name}`}
        className="h-24 w-40 animate-pulse rounded-lg"
        style={{ background: 'var(--surface-container)' }}
      />
    );
  }

  const image = <img src={objectUrl} alt={alt} className={className} />;
  if (!onOpen) return image;

  return (
    <button type="button" onClick={() => onOpen(objectUrl)} className={buttonClassName}>
      {image}
    </button>
  );
}

type ProtectedDownloadProps = {
  file: ProtectedFileDescriptor;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
};

export function ProtectedDownload({
  file,
  children,
  className,
  style,
  title,
}: ProtectedDownloadProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const blob = await fetchProtectedFile(file.id);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = file.name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to download attachment');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void download()}
        disabled={loading}
        aria-busy={loading}
        className={className}
        style={style}
        title={title}
      >
        {children}
        {loading && <span className="sr-only">Downloading</span>}
        {error && (
          <span role="alert" className="ml-2 text-[11px]" style={{ color: 'var(--error)' }}>
            {error}
          </span>
        )}
      </button>
    </>
  );
}
