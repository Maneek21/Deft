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
};

export function useFileUpload() {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = useCallback(async (file: File): Promise<UploadResult | null> => {
    setUploading(true);
    setProgress(0);
    setError(null);

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
      return data;
    } catch (err) {
      clearInterval(progressInterval);
      const message = err instanceof Error ? err.message : 'Upload failed';
      setError(message);
      setUploading(false);
      setProgress(0);
      return null;
    }
  }, []);

  return { uploadFile, uploading, progress, error, setError };
}

export function FileDropZone({ onUploadComplete, children }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const { uploadFile } = useFileUpload();
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
      for (const file of files) {
        const result = await uploadFile(file);
        if (result) onUploadComplete(result);
      }
    },
    [uploadFile, onUploadComplete]
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
