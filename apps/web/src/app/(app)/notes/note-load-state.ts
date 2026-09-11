export type NoteLoadState = 'unavailable' | 'error';

/** Map note fetch failures to the least revealing user-facing state. */
export function noteLoadFailureState(status: number): NoteLoadState {
  return status === 403 || status === 404 ? 'unavailable' : 'error';
}
