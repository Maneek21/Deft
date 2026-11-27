// What one awareness state may carry on /collab (plan Task F12 fix round 1,
// rule C4). Awareness is relayed to everyone with the document open, and the
// people rule (a guest sees only the people they share a chat with) can't be
// applied per recipient to a broadcast. So a state carries no name, nothing a
// person typed and nothing a client made up: only
// - `user.id`: the connection's authenticated user, set here (a client can't
//   claim someone else's id);
// - `user.color`: `#RRGGBB`, the caret colour, or nothing;
// - `cursor`: `{ anchor, head }` as Yjs relative positions in the document's
//   fragment (what CollaborationCaret's cursor plugin reads), or null.
// Everything else (a name, an email, y-tiptap's `lastSelection`, which only
// the client itself reads, any field of a client's own) is dropped before the
// state is applied or re-broadcast. Each viewer's editor resolves the id to a
// name through the members list, which applies the people rule, and shows "A
// collaborator" for anyone it doesn't list.
import { DOCUMENT_FRAGMENT } from '@deft/doc-schema';

const COLOR = /^#[0-9a-fA-F]{6}$/;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A Yjs ID (`{ client, clock }`), or null. */
function idOf(value: unknown): { client: number; clock: number } | null {
  if (!isObject(value)) return null;
  const { client, clock } = value;
  return Number.isSafeInteger(client) && Number.isSafeInteger(clock) && (client as number) >= 0 && (clock as number) >= 0
    ? { client: client as number, clock: clock as number }
    : null;
}

/** Y.relativePositionToJSON's shape, rebuilt from known keys only; null when it points at nothing. */
export function relativePositionOf(value: unknown): Json | null {
  if (!isObject(value)) return null;
  const out: Json = {};
  const type = idOf(value.type);
  if (type) out.type = type;
  if (value.tname === DOCUMENT_FRAGMENT) out.tname = DOCUMENT_FRAGMENT;
  const item = idOf(value.item);
  if (item) out.item = item;
  if (!type && !item && !out.tname) return null;
  if (Number.isSafeInteger(value.assoc)) out.assoc = value.assoc;
  return out;
}

/** The state relayed for a client of `userId`'s connection: the fields above, nothing else. */
export function relayedAwarenessState(state: unknown, userId: string): Json {
  const claimed = isObject(state) ? state : {};
  const user: Json = { id: userId };
  if (isObject(claimed.user) && typeof claimed.user.color === 'string' && COLOR.test(claimed.user.color)) user.color = claimed.user.color;
  const out: Json = { user };
  if (claimed.cursor === null) {
    out.cursor = null;
  } else if (isObject(claimed.cursor)) {
    const anchor = relativePositionOf(claimed.cursor.anchor);
    const head = relativePositionOf(claimed.cursor.head);
    if (anchor && head) out.cursor = { anchor, head };
  }
  return out;
}
