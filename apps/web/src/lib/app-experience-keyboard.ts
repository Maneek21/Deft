import type { DeftExperienceKeyboard } from '../../../../packages/app-kit/src/experience-keyboard';

const pendingFocus = new WeakMap<HTMLElement, () => void>();
const editable = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]';
const modal = '[role="dialog"],[aria-modal="true"],dialog[open],[role="menu"]';
function visible(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0
    && !element.closest('[hidden],[inert],[aria-hidden="true"]');
}
function usable(element: HTMLElement): boolean {
  return visible(element) && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
}
function control(container: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-focus-key]'))
    .find(element => element.dataset.focusKey === id && usable(element));
}
export function cancelExperienceKeyboardFocus(container: HTMLElement): void {
  pendingFocus.get(container)?.();
}
function handoffFocus(container: HTMLElement, id: string): void {
  cancelExperienceKeyboardFocus(container);
  const doc = container.ownerDocument;
  let observer: MutationObserver | undefined;
  const stop = () => {
    clearTimeout(timer); observer?.disconnect();
    doc.removeEventListener('pointerdown', stop, true);
    doc.removeEventListener('keydown', stop, true);
    doc.removeEventListener('focusin', onFocus, true);
    if (pendingFocus.get(container) === stop) pendingFocus.delete(container);
  };
  const onFocus = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement && (event.target.matches(editable) || !container.contains(event.target))) stop();
  };
  const tryFocus = () => {
    if (!container.isConnected) { stop(); return; }
    if (Array.from(doc.querySelectorAll<HTMLElement>(modal)).some(visible)) return;
    const field = control(container, id);
    const form = Array.from(container.querySelectorAll<HTMLElement>('[data-render-key]'))
      .find(element => element.dataset.renderKey === id && element.dataset.keyboardForm === 'true' && visible(element));
    const target = field?.matches(editable) ? field
      : form && Array.from(form.querySelectorAll<HTMLElement>(editable)).find(usable);
    if (target) { stop(); target.focus(); }
  };
  const timer = setTimeout(stop, 8000);
  pendingFocus.set(container, stop);
  doc.addEventListener('pointerdown', stop, true);
  doc.addEventListener('keydown', stop, true);
  doc.addEventListener('focusin', onFocus, true);
  observer = new MutationObserver(tryFocus);
  observer.observe(container, { childList: true, subtree: true, attributes: true });
  queueMicrotask(tryFocus);
}

/** Shortcuts can only activate existing rendered controls. Their normal review and
 * access checks still apply; no shortcut payload crosses the Worker bridge. */
export function bindExperienceKeyboard(container: HTMLElement, profile: DeftExperienceKeyboard,
  current: () => boolean): () => void {
  const doc = container.ownerDocument, win = doc.defaultView;
  if (!win) return () => undefined;
  const listener = (event: KeyboardEvent) => {
    if (!event.isTrusted || !current() || event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !visible(container)) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(`${editable},${modal}`)) return;
    if (target && target !== doc.body && target !== doc.documentElement && !container.contains(target)) return;
    if (Array.from(doc.querySelectorAll<HTMLElement>(modal)).some(visible)) return;
    const binding = profile.bindings.find(candidate => candidate.key === event.key);
    if (binding) {
      const element = control(container, binding.target_id);
      if (!element || binding.behavior === 'activate' && element.tagName !== 'BUTTON') return;
      event.preventDefault();
      if (binding.behavior === 'focus') element.focus();
      else { if (binding.focus_after) handoffFocus(container, binding.focus_after); element.click(); }
      return;
    }
    const nav = profile.navigation;
    if (!nav || event.key !== nav.previous_key && event.key !== nav.next_key) return;
    const list = Array.from(container.querySelectorAll<HTMLElement>('[data-render-key]'))
      .find(element => element.dataset.renderKey === nav.list_id && visible(element));
    if (!list) return;
    const controls = Array.from(list.querySelectorAll<HTMLElement>('button.ex-button-list[data-focus-key]')).filter(usable).slice(0,100);
    if (!controls.length) return;
    const focused = controls.findIndex(element => element === doc.activeElement);
    const selected = controls.findIndex(element => element.getAttribute('aria-pressed') === 'true');
    const index = focused >= 0 ? focused : selected;
    const next = index < 0 ? event.key === nav.next_key ? 0 : controls.length - 1
      : Math.max(0, Math.min(controls.length - 1, index + (event.key === nav.next_key ? 1 : -1)));
    event.preventDefault(); controls[next]!.focus(); controls[next]!.scrollIntoView({ block: 'nearest' });
  };
  // Bubble after the workspace's consumed command shortcuts.
  win.addEventListener('keydown', listener);
  return () => win.removeEventListener('keydown', listener);
}
