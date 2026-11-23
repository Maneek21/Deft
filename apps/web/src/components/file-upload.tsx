'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '@/lib/api';
import { Upload, X } from 'lucide-react';

type UploadResult = {
  id: string;
  url: string;
  name: string;
  type: string;
  size: number;
};

type Props = {
  onUploadComplete: (file: UploadResult) => void;
  children: React.ReactNode;
  /** The caller's own batch upload, so refusals show where the caller shows its upload errors; default: an upload of its own. */
  uploadFiles?: (files: File[]) => Promise<UploadResult[]>;
};

export function useFileUpload() {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // One file, without touching the error shown: its result, or why it was refused (the server's words when it gives them).
  const send = useCallback(async (file: File): Promise<{ data: UploadResult | null; message: string | null }> => {
    setUploading(true);
    setProgress(0);

    // Simulate progress since fetch doesn't support progress natively
    const progressInterval = setInterval(() => {
      setProgress((prev) => Math.min(prev + 10, 90));
    }, 200);

    try {
      const res = await api.upload('/api/upload', file);
      clearInterval(progressInterval);
      setProgress(100);

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(data.error || 'Upload failed');
      }

      const data = await res.json();
      setUploading(false);
      setProgress(0);
      return { data, message: null };
    } catch (err) {
      clearInterval(progressInterval);
      setUploading(false);
      setProgress(0);
      return { data: null, message: err instanceof Error ? err.message : 'Upload failed' };
    }
  }, []);

  const uploadFile = useCallback(async (file: File): Promise<UploadResult | null> => {
    setError(null);
    const { data, message } = await send(file);
    if (message !== null) setError(message);
    return data;
  }, [send]);

  /** Several files one after another; every refusal is kept, by file name, and shown once the batch is done. */
  const uploadFiles = useCallback(async (files: File[]): Promise<UploadResult[]> => {
    setError(null);
    const done: UploadResult[] = [];
    const refused: string[] = [];
    for (const file of files) {
      const { data, message } = await send(file);
      if (data) done.push(data);
      if (message !== null) refused.push(files.length > 1 ? `${file.name}: ${message}` : message);
    }
    setError(refused.length > 0 ? refused.join(' · ') : null);
    return done;
  }, [send]);

  return { uploadFile, uploadFiles, uploading, progress, error, setError };
}

export function FileDropZone({ onUploadComplete, children, uploadFiles }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const own = useFileUpload();
  const uploadMany = uploadFiles ?? own.uploadFiles;
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      dragCounter.current = 0;

      const files = Array.from(e.dataTransfer.files);
      for (const result of await uploadMany(files)) onUploadComplete(result);
    },
    [uploadMany, onUploadComplete]
  );

  return (
    <div
      className="relative h-full"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {dragOver && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center rounded-xl"
          style={{
            background: 'rgba(0, 0, 0, 0.5)',
            border: '2px dashed var(--accent)',
          }}
        >
          <div className="flex flex-col items-center gap-2 text-white">
            <Upload size={32} strokeWidth={1.5} />
            <span
              className="text-[14px] font-medium"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              Drop files to upload
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function UploadProgress({
  progress,
  uploading,
  error,
  onDismissError,
}: {
  progress: number;
  uploading: boolean;
  error: string | null;
  onDismissError: () => void;
}) {
  if (!uploading && !error) return null;

  return (
    <div className="px-4 py-2">
      {uploading && (
        <div className="flex items-center gap-3">
          <div
            className="flex-1 h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--surface)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ background: 'var(--accent)', width: `${progress}%` }}
            />
          </div>
          <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--muted)' }}>
            {progress}%
          </span>
        </div>
      )}
      {error && (
        <div
          className="flex items-center gap-2 text-[12px] px-2 py-1.5 rounded-md"
          style={{ background: 'var(--danger-bg, rgba(220,38,38,0.1))', color: 'var(--danger)' }}
        >
          <span className="flex-1">{error}</span>
          <button onClick={onDismissError}>
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}
