'use client';

import { useEffect, useRef, useState, useLayoutEffect, useMemo } from 'react';
import { EMOJI_DATA, EMOJI_KEYWORDS } from '@/lib/emoji-data';

// ═══ Expanded emoji set (~500 emoji) ═══

const CORRUPTED_EMOJI_DATA_UNUSED: Record<string, { emoji: string[]; icon: string }> = {
  'Frequent': { icon: '🕐', emoji: [] }, // Populated from localStorage
  'Smileys': { icon: '😀', emoji: [
    '😀','😃','����','😁','😆','😅','🤣','��','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙',
    '����','����','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒',
    '🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','����','🥴','😵','🤯','🥱','😤','😠','😡',
    '🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾',
  ]},
  'People': { icon: '👋', emoji: [
    '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉',
    '👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','🤝','🙏','✍️','💅','🤳','💪',
    '👶','👧','🧒','👦','👩','🧑','👨','👵','🧓','👴','👮','🕵️','💂','🥷','👷','🤴','👸','🧙','🦸','🧑‍💻',
  ]},
  'Nature': { icon: '🌿', emoji: [
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦅','🦆',
    '🦉','🐝','🐛','🦋','🐌','🐞','🐜','🪲','🕷️','🦂','🐢','🐍','🦎','🦕','🐙','🦑','🦐','🦀','🐡','🐠',
    '🌸','💐','🌷','🌹','🥀','🌺','🌻','🌼','🌱','🪴','🌲','🌳','🌴','🌵','🍀','🍁','🍂','🍃','🌍','🌎','🌏',
  ]},
  'Food': { icon: '🍕', emoji: [
    '🍎','��','🍊','��','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦',
    '🌶️','🫑','🥕','🧅','🌽','🥔','🍠','🥐','🍞','🥖','🥨','🧀','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖',
    '🍔','🍟','��','🌭','🥪','🌮','🌯','🫔','🥗','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🍩','🍪','🎂','🍰',
    '☕','🍵','🧃','🥤','🧋','🍺','🍻','🥂','🍷','🍸','🍹','🧉',
  ]},
  'Activity': { icon: '⚽', emoji: [
    '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','���','🏓','🏸','🏒','🥍','🏑','🥅','⛳','🏹','🎣','🤿',
    '🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🏋️','🤸','🤺','🤾','🏌️','🏇','🧘','🏄','🏊',
    '🎪','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🎻','🎲','♟️','🎯','🎳','🎮','🕹️','🧩',
  ]},
  'Travel': { icon: '✈️', emoji: [
    '🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🛺','🚲','🛴','🛹',
    '🚁','🛸','🚀','🛩️','✈️','🚂','🚆','🚇','🚊','🚉','🏠','🏡','🏢','🏣','🏥','🏦','🏨','🏩','🏪','🏫',
    '⛪','🕌','🕍','⛩️','🕋','⛲','⛺','🌁','🌃','🌄','🌅','🌆','🌇','🌉','♨️','🎠','🎡','🎢','🗽','🗼','🏰',
  ]},
  'Objects': { icon: '💡', emoji: [
    '🔥','✨','⭐','🌟','💡','💯','✅','❌','❓','❗','💬','💭','🎉','🎊','🎯','🏆','🥇','🏅','🎖️','🚀',
    '💻','📱','⌨️','🖥️','🖨️','📷','📹','🎥','📺','📻','⏰','⏱️','⏲️','🕰️','📌','📎','✏️','📝','📊','📈',
    '📉','📁','📂','🗂️','📰','🔑','🔒','🔓','🔧','🔨','⚙️','🧲','🔬','🔭','📡','💉','💊','🩹','🪣','🧴',
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','��','💞','💓','💗','����','💘','💝',
  ]},
  'Symbols': { icon: '🔣', emoji: [
    '⚠️','🚫','⛔','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔸','🔹','▪️','▫️','◻️','◼️',
    '♻️','💲','💱','©️','®️','™️','✔️','☑️','✖️','❕','❔','‼️','⁉️','➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️',
    '🔀','🔁','🔂','▶️','⏩','⏭️','⏯️','◀️','⏪','⏮️','🔼','⏫','🔽','⏬','⏸️','⏹️','⏺️','⏏️','🎦','🔅','🔆',
  ]},
};

// Emoji keyword search data (partial — covers common emoji)
const CORRUPTED_EMOJI_KEYWORDS_UNUSED: Record<string, string> = {
  '😀': 'grin happy smile', '😂': 'laugh cry joy', '😍': 'love heart eyes', '🤔': 'think hmm',
  '👍': 'thumbs up yes good ok', '👎': 'thumbs down no bad', '❤️': 'heart love red', '���': 'fire hot lit',
  '✨': 'sparkle stars magic', '🎉': 'party celebrate tada', '✅': 'check done yes complete',
  '❌': 'cross no wrong', '🚀': 'rocket launch ship', '💡': 'idea bulb light', '💯': 'hundred perfect',
  '👏': 'clap applause', '🙏': 'pray please thank', '💪': 'muscle strong flex',
  '😊': 'blush shy smile', '🤣': 'rofl rolling laugh', '😢': 'cry sad tear', '😤': 'angry huff',
  '🥰': 'love hearts smiling', '🤝': 'handshake deal agree', '🎯': 'target bullseye goal',
  '☕': 'coffee cup drink', '🍕': 'pizza food', '🍺': 'beer drink cheers', '🏆': 'trophy winner champion',
  '💻': 'laptop computer code', '📱': 'phone mobile', '⏰': 'alarm clock time', '📝': 'memo note write',
  '🔑': 'key password', '🔒': 'lock secure', '⭐': 'star favorite', '💬': 'speech chat message',
  '📊': 'chart graph data', '📈': 'trend up growth', '🐛': 'bug insect', '🤖': 'robot bot ai',
};

const FREQUENT_KEY = 'deft-frequent-emoji';
const MAX_FREQUENT = 16;

function getFrequentEmoji(): string[] {
  try {
    const data = JSON.parse(localStorage.getItem(FREQUENT_KEY) || '{}');
    return Object.entries(data)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, MAX_FREQUENT)
      .map(([emoji]) => emoji);
  } catch { return []; }
}

function recordEmojiUse(emoji: string) {
  try {
    const data = JSON.parse(localStorage.getItem(FREQUENT_KEY) || '{}');
    data[emoji] = (data[emoji] || 0) + 1;
    localStorage.setItem(FREQUENT_KEY, JSON.stringify(data));
  } catch {}
}

const CATEGORY_NAMES = Object.keys(EMOJI_DATA);
const PICKER_WIDTH = 300;
const PICKER_HEIGHT = 400;

type Props = {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
};

export function EmojiPicker({ onSelect, onClose, anchorRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [activeCategory, setActiveCategory] = useState(CATEGORY_NAMES[0]);
  const [search, setSearch] = useState('');

  // Load frequent emoji on mount
  const [frequent, setFrequent] = useState<string[]>([]);
  useEffect(() => { setFrequent(getFrequentEmoji()); }, []);

  // Update the Frequent category
  EMOJI_DATA['Frequent']!.emoji = frequent;

  // Search results
  const searchResults = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    const results: string[] = [];
    // Search all categories
    for (const cat of Object.values(EMOJI_DATA)) {
      for (const emoji of cat.emoji) {
        if (results.length >= 50) break;
        const keywords = EMOJI_KEYWORDS[emoji] || '';
        if (emoji.includes(q) || keywords.includes(q)) {
          results.push(emoji);
        }
      }
    }
    return results;
  }, [search]);

  // Position
  useLayoutEffect(() => {
    const anchor = anchorRef?.current || ref.current?.parentElement;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    let top = rect.top - PICKER_HEIGHT - 8;
    let left = rect.left;
    if (top < 8) top = rect.bottom + 8;
    const isMobile = window.innerWidth < 480;
    if (isMobile) {
      top = Math.max(8, (window.innerHeight - PICKER_HEIGHT) / 2);
      left = Math.max(8, (window.innerWidth - Math.min(PICKER_WIDTH, window.innerWidth - 16)) / 2);
    } else {
      if (top + PICKER_HEIGHT > window.innerHeight - 8) top = window.innerHeight - PICKER_HEIGHT - 8;
      if (top < 8) top = 8;
      if (left + PICKER_WIDTH > window.innerWidth - 8) left = window.innerWidth - PICKER_WIDTH - 8;
      if (left < 8) left = 8;
    }
    setPos({ top, left });
  }, [anchorRef]);

  // Auto-focus search
  useEffect(() => { setTimeout(() => searchRef.current?.focus(), 50); }, []);

  // Close handlers
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const rafId = requestAnimationFrame(() => document.addEventListener('mousedown', handleClick));
    document.addEventListener('keydown', handleEscape);
    return () => { cancelAnimationFrame(rafId); document.removeEventListener('mousedown', handleClick); document.removeEventListener('keydown', handleEscape); };
  }, [onClose]);

  const handleSelect = (emoji: string) => {
    recordEmojiUse(emoji);
    onSelect(emoji);
  };

  const displayEmoji = searchResults || EMOJI_DATA[activeCategory!]?.emoji || [];
  const showFrequentTab = frequent.length > 0;

  return (
    <div ref={ref}
      className="fixed rounded-xl z-[9999] flex flex-col"
      style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)',
        width: `min(${PICKER_WIDTH}px, calc(100vw - 1rem))`,
        maxHeight: `${PICKER_HEIGHT}px`,
        top: pos ? `${pos.top}px` : '-9999px',
        left: pos ? `${pos.left}px` : '-9999px',
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {/* Search input */}
      <div className="px-2 pt-2 flex-shrink-0">
        <input ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji..."
          className="w-full px-2.5 py-1.5 rounded-lg text-[12px] outline-none"
          style={{
            background: 'var(--surface-container-highest, var(--bg-surface))',
            border: '1px solid var(--border)',
            color: 'var(--on-surface)',
          }}
        />
      </div>

      {/* Category tabs (hidden during search) */}
      {!searchResults && (
        <div className="flex items-center gap-0.5 px-1.5 pt-1.5 pb-1 flex-shrink-0 overflow-x-auto"
          style={{ borderBottom: '1px solid var(--border)' }}>
          {CATEGORY_NAMES.map((cat) => {
            if (cat === 'Frequent' && !showFrequentTab) return null;
            return (
              <button key={cat}
                onClick={(e) => { e.stopPropagation(); setActiveCategory(cat); }}
                className="px-1.5 py-1 rounded-md text-[14px] transition-colors flex-shrink-0"
                style={{
                  background: activeCategory === cat ? 'var(--accent-subtle)' : 'transparent',
                  opacity: activeCategory === cat ? 1 : 0.5,
                }}
                title={cat}
              >
                {EMOJI_DATA[cat]?.icon}
              </button>
            );
          })}
        </div>
      )}

      {/* Emoji grid */}
      <div className="overflow-y-auto p-2 flex-1">
        {searchResults && searchResults.length === 0 && (
          <div className="text-center py-4 text-[11px]" style={{ color: 'var(--muted)' }}>No emoji found</div>
        )}
        <div className="grid grid-cols-8 gap-0.5">
          {displayEmoji.map((emoji, i) => (
            <button key={`${emoji}-${i}`}
              onClick={(e) => { e.stopPropagation(); handleSelect(emoji); }}
              className="w-8 h-8 flex items-center justify-center rounded-md text-[18px] hover:scale-110 transition-transform"
              style={{ background: 'transparent' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
