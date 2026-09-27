export type ExperiencePin = Readonly<{
  org_id: string; user_id: string; app_installation_id: string;
  app_version_id: string; grant_snapshot_id: string;
  lifecycle_epoch: number; grant_epoch: number;
  session_id: string; session_epoch: number;
}>;

export type ExperienceNode =
  | Readonly<{ kind: 'text'; id: string; text: string }>
  | Readonly<{ kind: 'button'; id: string; label: string }>
  | Readonly<{ kind: 'input'; id: string; label: string; value: string }>
  | Readonly<{ kind: 'stack'; id: string; title?: string; children: readonly ExperienceNode[] }>
  | Readonly<{ kind: 'grid'; id: string; columns: readonly string[];
      rows: readonly Readonly<{ id: string; cells: readonly string[] }>[]; selected_row_id?: string }>
  | Readonly<{ kind: 'canvas'; id: string;
      strokes: readonly Readonly<{ points: readonly Readonly<{ x: number; y: number }>[] }>[] }>;

export type ExperienceView = Readonly<{ root: ExperienceNode }>;
export type ExperienceIntent = Readonly<{
  kind: 'resource' | 'action' | 'run_status' | 'run_cancel' | 'navigate' | 'dialog';
  key?: string;
  input?: unknown;
}>;

export type ExperienceBroker = Readonly<{
  isLive(pin: ExperiencePin): boolean | Promise<boolean>;
  resource?: (pin: ExperiencePin, key: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  action?: (pin: ExperiencePin, key: string, input: unknown, signal: AbortSignal,
    requestId: string) => Promise<unknown>;
  runStatus?: (pin: ExperiencePin, input: unknown, signal: AbortSignal) => Promise<unknown>;
  runCancel?: (pin: ExperiencePin, input: unknown, signal: AbortSignal) => Promise<unknown>;
  navigate?: (pin: ExperiencePin, key: string, signal: AbortSignal) => Promise<unknown>;
  dialog?: (pin: ExperiencePin, key: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
}>;
export type ExperiencePort = Pick<MessagePort, 'postMessage' | 'close' | 'onmessage'>;

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_NODES = 256;
const MAX_DEPTH = 8;
const MAX_ROWS = 100;
const MAX_COLUMNS = 16;
const MAX_POINTS = 4096;
const MAX_PENDING = 16;
const MAX_PER_SECOND = 100;
const encoder = new TextEncoder();
const id = (x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x);
const text = (x: unknown, max = 4096): x is string => typeof x === 'string' && x.length <= max;
const record = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(x).every((key) => allowed.includes(key));
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

function boundedJson(value: unknown): boolean {
  const seen = new Set<object>();
  let remaining = 2048;
  const visit = (item: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 12) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= 4096;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) return item.length <= 256 && item.every((child) => visit(child, depth + 1));
    return Object.keys(item).length <= 64 && Object.entries(item).every(([key, child]) =>
      key.length <= 64 && key !== '__proto__' && key !== 'constructor' && visit(child, depth + 1));
  };
  if (!visit(value, 0)) return false;
  try { return encoder.encode(JSON.stringify(value)).byteLength <= MAX_MESSAGE_BYTES; }
  catch { return false; }
}

function parseNode(input: unknown, depth: number, budget: { nodes: number; points: number }): ExperienceNode | null {
  if (!record(input) || !id(input.id) || depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) return null;
  switch (input.kind) {
    case 'text':
      return exact(input, ['kind', 'id', 'text']) && text(input.text)
        ? { kind: 'text', id: input.id, text: input.text } : null;
    case 'button':
      return exact(input, ['kind', 'id', 'label']) && text(input.label, 128)
        ? { kind: 'button', id: input.id, label: input.label } : null;
    case 'input':
      return exact(input, ['kind', 'id', 'label', 'value']) && text(input.label, 128) && text(input.value)
        ? { kind: 'input', id: input.id, label: input.label, value: input.value } : null;
    case 'stack': {
      if (!exact(input, ['kind', 'id', 'title', 'children'])
        || (input.title !== undefined && !text(input.title, 128))
        || !Array.isArray(input.children) || input.children.length > 64) return null;
      const children = input.children.map((child) => parseNode(child, depth + 1, budget));
      return children.every((child) => child !== null)
        ? { kind: 'stack', id: input.id, ...(input.title ? { title: input.title } : {}),
          children: children as ExperienceNode[] } : null;
    }
    case 'grid': {
      if (!exact(input, ['kind', 'id', 'columns', 'rows', 'selected_row_id'])
        || !Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > MAX_COLUMNS
        || !input.columns.every((column) => text(column, 80))
        || !Array.isArray(input.rows) || input.rows.length > MAX_ROWS
        || (input.selected_row_id !== undefined && !id(input.selected_row_id))) return null;
      const columns = input.columns as string[];
      const rows = input.rows.map((row) => {
        if (!record(row) || !exact(row, ['id', 'cells']) || !id(row.id)
          || !Array.isArray(row.cells) || row.cells.length !== columns.length
          || !row.cells.every((cell) => text(cell, 512))) return null;
        return { id: row.id, cells: row.cells as string[] };
      });
      return rows.every((row) => row !== null)
        ? { kind: 'grid', id: input.id, columns,
          rows: rows as { id: string; cells: string[] }[],
          ...(input.selected_row_id ? { selected_row_id: input.selected_row_id } : {}) } : null;
    }
    case 'canvas': {
      if (!exact(input, ['kind', 'id', 'strokes']) || !Array.isArray(input.strokes)
        || input.strokes.length > 256) return null;
      const strokes = input.strokes.map((stroke) => {
        if (!record(stroke) || !exact(stroke, ['points']) || !Array.isArray(stroke.points)
          || stroke.points.length > 512) return null;
        budget.points += stroke.points.length;
        if (budget.points > MAX_POINTS) return null;
        const points = stroke.points.map((point) =>
          record(point) && exact(point, ['x', 'y'])
          && typeof point.x === 'number' && typeof point.y === 'number'
          && Number.isFinite(point.x) && Number.isFinite(point.y)
          && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
            ? { x: point.x, y: point.y } : null);
        return points.every((point) => point !== null)
          ? { points: points as { x: number; y: number }[] } : null;
      });
      return strokes.every((stroke) => stroke !== null)
        ? { kind: 'canvas', id: input.id,
          strokes: strokes as { points: { x: number; y: number }[] }[] } : null;
    }
    default: return null;
  }
}

export function parseExperienceView(value: unknown): ExperienceView | null {
  if (!record(value) || !exact(value, ['root'])) return null;
  const root = parseNode(value.root, 0, { nodes: 0, points: 0 });
  return root ? { root } : null;
}

export function createExperienceBridge(input: Readonly<{
  port: ExperiencePort;
  pin: ExperiencePin;
  resourceKeys: readonly string[];
  actionKeys: readonly string[];
  navigationKeys?: readonly string[];
  dialogKeys?: readonly string[];
  broker: ExperienceBroker;
  onView(view: ExperienceView): void;
  now?: () => number;
}>) {
  const pin = Object.freeze({ ...input.pin });
  const resourceKeys = new Set(input.resourceKeys);
  const actionKeys = new Set(input.actionKeys);
  const navigationKeys = new Set(input.navigationKeys ?? []);
  const dialogKeys = new Set(input.dialogKeys ?? []);
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  let active = true;
  let sequence = 0;
  let latestViewSequence = 0;
  let pending = 0;
  let queuedUiEvents = 0;
  let uiTail = Promise.resolve();
  let windowStart = now();
  let inWindow = 0;
  const revoke = () => {
    if (!active) return;
    active = false;
    controller.abort();
    input.port.onmessage = null;
    input.port.close();
  };
  const send = (message: unknown) => { if (active) input.port.postMessage(message); };
  input.port.onmessage = (event: MessageEvent) => {
    let value: unknown = event.data;
    // Published SDK requests may retain absent optional fields through
    // structured clone. Normalize only these envelope fields, never input JSON.
    if (record(value) && value.kind === 'request') {
      const envelope = { ...value };
      if (Object.hasOwn(envelope, 'key') && envelope.key === undefined) delete envelope.key;
      if (Object.hasOwn(envelope, 'input') && envelope.input === undefined) delete envelope.input;
      value = envelope;
    }
    if (!active || !boundedJson(value) || !record(value)
      || value.version !== 'deft.experience_bridge.v1'
      || value.session_id !== pin.session_id || !integer(value.sequence)
      || value.sequence !== sequence + 1) { revoke(); return; }
    const at = now();
    if (at < windowStart || at - windowStart >= 1000) { windowStart = at; inWindow = 0; }
    if (++inWindow > MAX_PER_SECOND) { revoke(); return; }
    sequence = value.sequence;
    if (value.kind === 'view') {
      if (!exact(value, ['version', 'session_id', 'sequence', 'kind', 'view'])) { revoke(); return; }
      const view = parseExperienceView(value.view);
      if (!view) { revoke(); return; }
      const viewSequence = sequence;
      latestViewSequence = viewSequence;
      void Promise.resolve(input.broker.isLive(pin)).then((live) => {
        if (!live) revoke();
        else if (active && viewSequence === latestViewSequence) input.onView(view);
      }).catch(revoke);
      return;
    }
    if (value.kind !== 'request'
      || !exact(value, ['version', 'session_id', 'sequence', 'kind', 'request_id', 'operation', 'key', 'input'])
      || !id(value.request_id) || value.request_id !== `request_${value.sequence}`
      || pending >= MAX_PENDING
      || !['resource', 'action', 'run_status', 'run_cancel', 'navigate', 'dialog'].includes(String(value.operation))
      || (value.input !== undefined && !boundedJson(value.input))) { revoke(); return; }
    const requestId = value.request_id;
    const operation = value.operation;
    const key = value.key;
    if ((operation === 'resource' && (!id(key) || !resourceKeys.has(key)))
      || (operation === 'action' && (!id(key) || !actionKeys.has(key)))
      || (operation === 'navigate' && (!id(key) || !navigationKeys.has(key)))
      || (operation === 'dialog' && (!id(key) || !dialogKeys.has(key)))
      || (['run_status', 'run_cancel'].includes(String(operation)) && key !== undefined)) {
      revoke(); return;
    }
    pending += 1;
    void (async () => {
      try {
        if (!await input.broker.isLive(pin) || !active) { revoke(); return; }
        let output: unknown;
        if (operation === 'resource') output = await input.broker.resource?.(pin, key as string, value.input, controller.signal);
        else if (operation === 'action') output = await input.broker.action?.(
          pin, key as string, value.input, controller.signal, requestId);
        else if (operation === 'run_status') output = await input.broker.runStatus?.(pin, value.input, controller.signal);
        else if (operation === 'run_cancel') output = await input.broker.runCancel?.(pin, value.input, controller.signal);
        else if (operation === 'navigate') output = await input.broker.navigate?.(pin, key as string, controller.signal);
        else output = await input.broker.dialog?.(pin, key as string, value.input, controller.signal);
        if (!active || !await input.broker.isLive(pin)) { revoke(); return; }
        if (output === undefined) {
          send({ version: 'deft.experience_bridge.v1', kind: 'response',
            session_id: pin.session_id, request_id: requestId, ok: false, code: 'UNAVAILABLE' });
        } else if (boundedJson(output)) {
          const response = { version: 'deft.experience_bridge.v1', kind: 'response',
            session_id: pin.session_id, request_id: requestId, ok: true, output };
          if (operation === 'resource' && (!boundedJson(response)
            || encoder.encode(JSON.stringify(response)).byteLength > 60 * 1024)) {
            send({ version: 'deft.experience_bridge.v1', kind: 'response', session_id: pin.session_id,
              request_id: requestId, ok: false, code: 'RESOURCE_PAYLOAD_TOO_LARGE' });
          } else if (boundedJson(response)) send(response);
          else revoke();
        } else {
          revoke();
        }
      } catch (reason) {
        const code = reason instanceof Error && ['RESOURCE_PAYLOAD_TOO_LARGE', 'RESOURCE_CURSOR_STALE'].includes(reason.message)
          ? reason.message : 'UNAVAILABLE';
        if (active) send({ version: 'deft.experience_bridge.v1', kind: 'response',
          session_id: pin.session_id, request_id: requestId, ok: false, code });
      } finally { pending -= 1; }
    })();
  };
  const sendUiEvent = (uiEvent: unknown): Promise<boolean> => {
    if (!active || !boundedJson(uiEvent) || queuedUiEvents >= MAX_PENDING) return Promise.resolve(false);
    queuedUiEvents += 1;
    const task = uiTail.then(async () => {
      if (!active) return false;
      try {
        if (!await input.broker.isLive(pin)) { revoke(); return false; }
      } catch { revoke(); return false; }
      if (!active) return false;
      send({ version: 'deft.experience_bridge.v1', kind: 'ui_event',
        session_id: pin.session_id, event: uiEvent });
      return true;
    });
    uiTail = task.then(() => { queuedUiEvents -= 1; }, () => { queuedUiEvents -= 1; });
    return task;
  };
  return Object.freeze({ revoke, sendUiEvent, get active() { return active; } });
}
