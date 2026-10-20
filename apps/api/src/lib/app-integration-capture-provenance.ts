import { z } from 'zod';

/** Version the existing capture-source association inside its publication JSON.
 * This is Host-authored evidence, never an app-supplied authority grant. Keeping
 * the publication fields and source IDs preserves existing readers and rollback. */
export const AppCaptureAssociationSchema = z.strictObject({
  schema_version: z.literal('deft.app_capture_source.v2'),
  page_id: z.uuid(), page_version: z.number().int().positive(),
  audience: z.discriminatedUnion('scope', [
    z.strictObject({ scope: z.literal('user'), user_id: z.uuid(), space_id: z.null() }),
    z.strictObject({ scope: z.literal('space'), user_id: z.null(), space_id: z.uuid() }),
  ]),
  body_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), captured_at: z.iso.datetime(),
});
export type AppCaptureAssociation = z.infer<typeof AppCaptureAssociationSchema>;

export function appCaptureAssociation(input: {
  page_id: string; page_version: number; owner_user_id: string;
  destination: { scope: 'user' | 'space'; space_id: string | null };
  body_digest: string; captured_at: string;
}): AppCaptureAssociation {
  return AppCaptureAssociationSchema.parse({
    schema_version: 'deft.app_capture_source.v2', page_id: input.page_id, page_version: input.page_version,
    audience: input.destination.scope === 'user'
      ? { scope: 'user', user_id: input.owner_user_id, space_id: null }
      : { scope: 'space', user_id: null, space_id: input.destination.space_id },
    body_digest: input.body_digest, captured_at: input.captured_at,
  });
}

/** Unknown versions and inconsistent records fail closed. An absent association
 * belongs to the bounded v1 reader; it is never reinterpreted as v2 evidence. */
export function readAppCaptureAssociation(source: {
  page_id: string; body_digest: string; publication: Record<string, unknown>;
}): AppCaptureAssociation | null {
  const parsed = AppCaptureAssociationSchema.safeParse(source.publication.association);
  return parsed.success && parsed.data.page_id === source.page_id
    && parsed.data.body_digest === source.body_digest ? parsed.data : null;
}
