'use client';

import { Image } from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { ProtectedImage, type ProtectedFileDescriptor } from '@/components/protected-file';

type UploadedNoteImage = ProtectedFileDescriptor;

export function noteImageAttributes(file: UploadedNoteImage) {
  return {
    fileId: file.id,
    alt: file.name,
    title: file.name,
  };
}

function fileIdFromLegacyUrl(value: string | null): string | false {
  if (!value) return false;
  try {
    const url = new URL(value, 'http://deft.invalid');
    const match = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : false;
  } catch {
    return false;
  }
}

function ProtectedNoteImageView({ node }: NodeViewProps) {
  const fileId = typeof node.attrs.fileId === 'string' ? node.attrs.fileId : '';
  const name = typeof node.attrs.alt === 'string' && node.attrs.alt ? node.attrs.alt : 'Note image';

  return (
    <NodeViewWrapper className="deft-protected-note-image">
      {fileId ? (
        <ProtectedImage file={{ id: fileId, name }} alt={name} className="max-w-full rounded-lg" />
      ) : (
        <span role="alert" className="text-[12px]" style={{ color: 'var(--error)' }}>
          Image is unavailable
        </span>
      )}
    </NodeViewWrapper>
  );
}

export const ProtectedNoteImage = Image.extend({
  name: 'protectedNoteImage',

  addAttributes() {
    return {
      fileId: {
        default: null,
        parseHTML: element => element.getAttribute('data-file-id')
          || fileIdFromLegacyUrl(element.getAttribute('src')),
        renderHTML: attributes => attributes.fileId
          ? { 'data-file-id': attributes.fileId, 'data-protected-note-image': '' }
          : {},
      },
      alt: {
        default: null,
        parseHTML: element => element.getAttribute('alt'),
        renderHTML: attributes => attributes.alt ? { alt: attributes.alt } : {},
      },
      title: {
        default: null,
        parseHTML: element => element.getAttribute('title'),
        renderHTML: attributes => attributes.title ? { title: attributes.title } : {},
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'img[data-file-id]' },
      { tag: 'img[src*="/api/files/"]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', HTMLAttributes];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ProtectedNoteImageView);
  },
});
