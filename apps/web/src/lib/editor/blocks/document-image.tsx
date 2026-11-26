'use client';

// A document's block image, drawn (plan Task F12). The node and its
// attributes are @deft/doc-schema's DocumentImage, so the editor and the API
// share one schema; this adds only the view. An image that names a Deft file
// (`fileId`) is fetched with the viewer's own token into a blob URL
// (ProtectedImage), as notes do, so it shows only to someone the file route
// lets read it. An image from another site (`src`, https only) is drawn as
// is. Uploading into a document (F10, `?document_id=`) is wired separately.

import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { DocumentImage } from '@deft/doc-schema/nodes/document-image';
import { ProtectedImage } from '@/components/protected-file';

/** An outside image is drawn only from an https address. */
export function outsideImageSrc(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  try {
    return new URL(src).protocol === 'https:' ? src : null;
  } catch {
    return null;
  }
}

function DocumentImageView({ node }: NodeViewProps) {
  const fileId = typeof node.attrs.fileId === 'string' ? node.attrs.fileId : '';
  const name = typeof node.attrs.alt === 'string' && node.attrs.alt ? node.attrs.alt : 'Image';
  const src = fileId ? null : outsideImageSrc(node.attrs.src);
  return (
    <NodeViewWrapper className="my-2" data-document-image="">
      {fileId ? (
        <ProtectedImage file={{ id: fileId, name }} alt={name} className="max-w-full rounded-lg" />
      ) : src ? (
        // eslint-disable-next-line @next/next/no-img-element -- an outside image the document links to; next/image would proxy it
        <img src={src} alt={name} loading="lazy" referrerPolicy="no-referrer" className="max-w-full rounded-lg" />
      ) : (
        <span role="alert" className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Image is unavailable</span>
      )}
    </NodeViewWrapper>
  );
}

/** DocumentImage with the view above; same name (`image`), attributes and HTML. */
export const DocumentImageWithView = DocumentImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentImageView);
  },
});
