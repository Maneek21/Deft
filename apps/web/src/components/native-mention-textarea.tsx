'use client';
import { useRef, useState, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { nativeMentionToken } from '@deft/shared';
import { NativeMentionPopup, type NativeMentionPopupRef } from './editor/native-mention-popup';
import { nativeMentionsAvailable, searchNativeReferences, type NativeProjection } from '@/lib/native-mentions';

export function NativeMentionTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const input = useRef<HTMLTextAreaElement>(null);
  const popup = useRef<NativeMentionPopupRef>(null);
  const request = useRef(0);
  const [menu, setMenu] = useState<{ from: number; to: number; rect: DOMRect; items: NativeProjection[]; loading: boolean; error?: string } | null>(null);
  const close = () => { ++request.current; setMenu(null); };
  return <><textarea {...props} ref={input}
    onChange={e => {
      props.onChange?.(e);
      const field = e.currentTarget;
      const match = nativeMentionsAvailable() && field.value.slice(0, field.selectionStart).match(/(?:^|\s)@([^\s@]*)$/);
      if (!match) { close(); return; }
      const revision = ++request.current;
      const snapshot = { from: field.selectionStart - match[1]!.length - 1, to: field.selectionStart,
        rect: field.getBoundingClientRect(), items: [] as NativeProjection[], loading: true };
      setMenu(snapshot);
      void searchNativeReferences(match[1]!).then(items => {
        if (revision === request.current) setMenu({ ...snapshot, items, loading: false });
      }).catch(error => { if (revision === request.current) setMenu({ ...snapshot, loading: false, error: error.message }); });
    }}
    onBlur={e => { props.onBlur?.(e); close(); }}
    onKeyDown={e => {
      if (menu && !e.nativeEvent.isComposing) {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (popup.current?.onKeyDown(e.nativeEvent)) return;
      }
      props.onKeyDown?.(e);
    }} />
    {menu && createPortal(<div className="fixed z-[100]" style={{
      left: Math.max(8, Math.min(menu.rect.left, window.innerWidth - 328)),
      top: Math.min(menu.rect.top + 32, window.innerHeight - 352) }}>
      <NativeMentionPopup ref={popup} items={menu.items} loading={menu.loading} error={menu.error}
        command={item => {
          const field = input.current;
          if (!field) return;
          const token = nativeMentionToken(item.ref) + ' ';
          const value = field.value.slice(0, menu.from) + token + field.value.slice(menu.to);
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(field, value);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
          close(); field.focus();
          field.setSelectionRange(menu.from + token.length, menu.from + token.length);
        }} />
    </div>, document.body)}
  </>;
}
