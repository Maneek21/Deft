'use client';

// /d/<documentId>: one document (plan Task F12). Drive pages, chat cards and
// notifications link here.
import { useParams } from 'next/navigation';
import { DocumentPage } from '@/components/documents/document-page';

export default function DocumentRoute() {
  const { documentId } = useParams<{ documentId: string }>();
  return <DocumentPage key={documentId} documentId={documentId} />;
}
