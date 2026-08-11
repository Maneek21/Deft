'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { openDeftyDm } from '@/lib/quick-actions';
import { sanitizeHtml } from '@/lib/sanitize';
import { getSocket } from '@/lib/socket';
import { subscribeToSpace } from '@/lib/space-socket';
import { useAuth } from '@/lib/auth-context';
import { useChatContext } from '@/lib/chat-context';
import { HUDDLES_ENABLED } from '@/lib/feature-flags';
import { setCurrentSpaceMuted } from '@/lib/editor/chat-commands';
import {
  Pencil,
  Trash2,
  Check,
  X,
  Smile,
  MessageSquare,
  Pin,
  MoreHorizontal,
  Copy,
  Hash,
  Image as ImageIcon,
  BookOpen,
  FileText,
  Users,
  CheckSquare,
  Clock,
  Bookmark,
  Mic,
  ChevronDown,
  ChevronRight,
  Bell,
  BellOff,
  MailOpen,
  Forward,
  Sparkles,
} from 'lucide-react';
import { formatMessageTime, formatDayLabel, isSameDay, formatTimeWithSenderZone } from '@/lib/time';
import { TabStrip } from './tab-strip';
import { EmojiPicker } from './emoji-picker';
import { FileDropZone, useFileUpload, UploadProgress } from './file-upload';
import { Lightbox } from './lightbox';
import { EmptyState } from './empty-state';
import { RichComposer } from './rich-composer';
import { SpaceMembersPanel } from './space-members-panel';
import { TaskQuickCreate } from './task-quick-create';
import { PinnedBar } from './pinned-messages';
import { ScheduledPanel } from './scheduled-panel';
import { KnowledgePanel } from './knowledge-panel';
import { MobileActionSheet } from './mobile-action-sheet';
import { ClipCard } from './clip-card';
import { AgentMessageBlocks, type AgentBlock, type AgentCitation } from './agent-message-blocks';
import { AgentActionCard, type AgentAction } from './agent-action-card';
import useSWR, { mutate as swrMutate } from 'swr';
import { ClipRecorder } from './clip-recorder';
import { UserProfileCard } from './user-profile-card';
import { parseReminderTime } from './slash-command-autocomplete';
import ConfirmDialog from './confirm-dialog';
import { normalizeInlineApprovalCopy } from '@/lib/agent-approval-copy';
import { stripHtml } from '@/lib/strip-html';
import { isTrustedSystemMessage, serializeQuotedMessage } from '@/lib/message-presentation';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';

type Reaction = {
  emoji: string;
  count: number;
  users: string[];
};

type FileAttachment = {
  id: string;
  url: string;
  name: string;
  type: string;
  size: number;
};

type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
  siteName: string | null;
};

async function apiErrorMessage(res: Response, fallback: string) {
  const body = await res.json().catch(() => null);
  if (body && typeof body.error === 'string' && body.error.trim()) return body.error;
  if (body && typeof body.message === 'string' && body.message.trim()) return body.message;
  return fallback;
}

type Message = {
  id: string;
  content: string;
  user_id: string;
  user_name: string;
  user_avatar: string | null;
  is_deleted: boolean;
  is_pinned?: boolean;
  edited_at: string | null;
  created_at: string;
  reactions: Reaction[];
  user_timezone?: string | null;
  reply_count: number;
  latest_reply_at: string | null;
  file_ids: string[];
  files?: FileAttachment[];
};

type WorkIntentReceipt = {
  id: string;
  kind: string;
  status: 'proposed' | 'converted' | 'dismissed' | 'expired' | 'failed';
  title: string | null;
  source_message_id: string | null;
  proposed_action: string | null;
  converted_task_id: string | null;
  failure_reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

// formatTime, formatDayLabel, isSameDay imported from @/lib/time

function renderSimpleMarkdown(text: string): string {
  if (!text) return '';

  // Extract code blocks to protect them
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    codeBlocks.push(`<pre style="background:var(--surface-container-low);border-radius:6px;padding:12px 16px;font-family:var(--font-mono);font-size:0.75rem;line-height:1.5;margin:8px 0;overflow-x:auto"><code>${code.trim()}</code></pre>`);
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });

  // Split into paragraphs by double newline
  const paragraphs = processed.split(/\n\n+/);
  const htmlParts: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Check for code block placeholder
    const cbMatch = trimmed.match(/^%%CODEBLOCK_(\d+)%%$/);
    if (cbMatch) {
      htmlParts.push(codeBlocks[parseInt(cbMatch[1]!)]!);
      continue;
    }

    // Check if entire paragraph is a list
    const lines = trimmed.split('\n');
    const allListItems = lines.every(l => /^[-*] /.test(l.trim()) || /^\d+\. /.test(l.trim()));
    if (allListItems && lines.length > 0) {
      const isOrdered = /^\d+\. /.test(lines[0]!.trim());
      const tag = isOrdered ? 'ol' : 'ul';
      const items = lines.map(l => {
        const content = l.trim().replace(/^[-*] |^\d+\. /, '');
        return `<li>${inlineFormat(content)}</li>`;
      }).join('');
      htmlParts.push(`<${tag} style="list-style:${isOrdered ? 'decimal' : 'disc'};padding-left:20px;margin:4px 0">${items}</${tag}>`);
      continue;
    }

    // Check for heading
    const h2Match = trimmed.match(/^## (.+)$/);
    if (h2Match) {
      htmlParts.push(`<h2 style="font-size:15px;font-weight:600;margin:12px 0 6px">${inlineFormat(h2Match[1]!)}</h2>`);
      continue;
    }
    const h3Match = trimmed.match(/^### (.+)$/);
    if (h3Match) {
      htmlParts.push(`<h3 style="font-size:14px;font-weight:600;margin:10px 0 4px">${inlineFormat(h3Match[1]!)}</h3>`);
      continue;
    }

    // Check for blockquote
    if (trimmed.startsWith('> ')) {
      const quoteContent = lines.map(l => l.replace(/^> ?/, '')).join('<br/>');
      htmlParts.push(`<blockquote style="border-left:3px solid var(--primary-container);padding-left:12px;margin:6px 0;color:var(--on-surface-variant)">${inlineFormat(quoteContent)}</blockquote>`);
      continue;
    }

    // Regular paragraph — handle single newlines as <br/>
    const paraHtml = lines.map(l => inlineFormat(l)).join('<br/>');
    htmlParts.push(`<p style="margin:0 0 8px 0">${paraHtml}</p>`);
  }

  let result = htmlParts.join('');

  return result;
}

function inlineFormat(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/`([^`]+)`/g, '<code style="background:var(--surface-container-highest);color:var(--tertiary);padding:1px 5px;border-radius:4px;font-family:var(--font-mono);font-size:0.75rem">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

function shouldGroup(prev: Message, curr: Message) {
  if (prev.user_id !== curr.user_id) return false;
  if (prev.is_deleted || curr.is_deleted) return false;
  return new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60 * 1000;
}

function avatarColor(name: string) {
  const colors = ['#7C6B4F', '#5B7A6B', '#6B5D7A', '#7A5B5B', '#5B6B7A', '#7A6B5B'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

const SHORTCODE_TO_EMOJI: Record<string, string> = {
  thumbsup: '👍', thumbsdown: '👎', heart: '❤️', tada: '🎉', fire: '🔥',
  eyes: '👀', joy: '😂', open_mouth: '😮', pray: '🙏', white_check_mark: '✅',
  x: '❌', '100': '💯', rocket: '🚀', muscle: '💪', clap: '👏',
  thinking: '🤔', heart_eyes: '😍', cry: '😢', angry: '😡', handshake: '🤝',
  bulb: '💡', star: '⭐', trophy: '🏆', dart: '🎯',
  '+1': '👍', '-1': '👎', smile: '😄', laughing: '😂', wink: '😉',
  ok_hand: '👌', wave: '👋', raised_hands: '🙌',
};

/** Returns unicode emoji. If the input is already a unicode character, returns as-is.
 *  Otherwise tries to map a shortcode string to its unicode equivalent. */
function displayEmoji(emoji: string): string {
  // If it looks like it already contains non-ASCII (i.e. a real emoji), return as-is
  if (/[^\x00-\x7F]/.test(emoji)) return emoji;
  // Strip optional colons (e.g. ":thumbsup:")
  const key = emoji.replace(/^:|:$/g, '').toLowerCase();
  return SHORTCODE_TO_EMOJI[key] || emoji;
}

function compactReceiptTitle(title: string) {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  return cleaned.length > 44 ? `${cleaned.slice(0, 41)}...` : cleaned;
}

function WorkIntentReceiptChips({
  intents,
  inline = false,
  className = '',
}: {
  intents?: WorkIntentReceipt[];
  inline?: boolean;
  className?: string;
}) {
  const knowledgeReceipts = (intents ?? []).filter((intent) => {
    const metadata = intent.metadata ?? {};
    return intent.status === 'converted'
      && typeof metadata.converted_wiki_slug === 'string'
      && metadata.converted_wiki_slug.trim().length > 0;
  });
  if (knowledgeReceipts.length === 0) return null;

  const receiptsByDestination = new Map<string, { intent: WorkIntentReceipt; count: number }>();
  for (const intent of knowledgeReceipts) {
    const metadata = intent.metadata ?? {};
    const wikiPageId = typeof metadata.converted_wiki_page_id === 'string' ? metadata.converted_wiki_page_id : null;
    const wikiSlug = typeof metadata.converted_wiki_slug === 'string' ? metadata.converted_wiki_slug : null;
    if (!wikiSlug) continue;
    const key = wikiPageId || wikiSlug;
    const existing = receiptsByDestination.get(key);
    receiptsByDestination.set(key, existing
      ? { intent: existing.intent, count: existing.count + 1 }
      : { intent, count: 1 });
  }

  const destinations = [...receiptsByDestination.values()];
  const primary = destinations.reduce((best, candidate) => candidate.count > best.count ? candidate : best);
  const primaryMetadata = primary.intent.metadata ?? {};
  const wikiSlug = primaryMetadata.converted_wiki_slug as string;
  const title = primary.intent.title ?? 'Work capture';
  const isWikiUpdate = primary.intent.proposed_action === 'wiki_update' || primaryMetadata.update_kind === 'wiki_content';
  const relatedLabel = destinations.length > 1 ? `, plus ${destinations.length - 1} related knowledge page${destinations.length === 2 ? '' : 's'}` : '';
  const label = `${isWikiUpdate ? 'Knowledge updated' : 'Added to knowledge'}: ${compactReceiptTitle(title)}${relatedLabel}`;

  return (
    <div className={`${inline ? 'inline-flex' : 'mt-1 flex'} ${className} items-center`} aria-label="Knowledge receipt">
      <a
        href={`/knowledge?slug=${encodeURIComponent(wikiSlug)}`}
        className={`${inline ? 'h-3.5 w-3.5' : 'h-4 w-4'} inline-flex items-center justify-center rounded-full opacity-70 transition hover:opacity-100`}
        style={{ color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 11%, transparent)' }}
        title={label}
        aria-label={label}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--success)' }} />
      </a>
    </div>
  );
}

function isImageUrl(url: string) {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(url);
}

function isImageType(type: string) {
  return type.startsWith('image/');
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render inline formatting (bold, italic, strikethrough, inline code) */
function renderFormattedText(text: string, keyPrefix: string): React.ReactNode[] {
  // Process code blocks first (```...```)
  const codeBlockParts = text.split(/(```[\s\S]*?```)/g);
  const result: React.ReactNode[] = [];

  codeBlockParts.forEach((segment, si) => {
    if (segment.startsWith('```') && segment.endsWith('```')) {
      const code = segment.slice(3, -3).replace(/^\n/, '');
      result.push(
        <pre
          key={`${keyPrefix}-cb-${si}`}
          className="my-1.5 px-3 py-2 rounded-lg text-[13px] overflow-x-auto"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', fontFamily: 'monospace' }}
        >
          <code style={{ color: 'var(--foreground)' }}>{code}</code>
        </pre>
      );
      return;
    }

    // Process line by line for blockquotes
    const lines = segment.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('> ')) {
        // Collect consecutive blockquote lines
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].startsWith('> ')) {
          quoteLines.push(lines[i].slice(2));
          i++;
        }
        result.push(
          <div
            key={`${keyPrefix}-bq-${i}`}
            className="pl-3 my-1 text-[14px]"
            style={{ borderLeft: '3px solid var(--border)', color: 'var(--foreground-secondary)' }}
          >
            {quoteLines.map((ql, qi) => (
              <span key={qi}>{renderInlineFormatting(ql, `${keyPrefix}-bql-${qi}`)}{qi < quoteLines.length - 1 ? <br /> : null}</span>
            ))}
          </div>
        );
      } else {
        result.push(...renderInlineFormatting(line, `${keyPrefix}-l-${i}`));
        if (i < lines.length - 1) {
          result.push(<br key={`${keyPrefix}-br-${i}`} />);
        }
        i++;
      }
    }
  });

  return result;
}

/** Render inline formatting: bold, italic, strikethrough, inline code */
function renderInlineFormatting(text: string, keyPrefix: string): React.ReactNode[] {
  // Pre-pass: split on markdown links [text](url) first, before any other formatting
  const linkPattern = /(\[[^\]]+\]\([^)]+\))/g;
  const linkSegments = text.split(linkPattern);
  if (linkSegments.length > 1) {
    // There are markdown links — process each segment
    const result: React.ReactNode[] = [];
    linkSegments.forEach((seg, si) => {
      const linkMatch = seg.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const label = linkMatch[1]!;
        const href = linkMatch[2]!;
        // Sanitize: only allow http, https, mailto
        const safe = /^(https?:\/\/|mailto:)/i.test(href);
        if (safe) {
          result.push(
            <a
              key={`${keyPrefix}-lnk-${si}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              style={{ color: 'var(--accent)' }}
            >
              {label}
            </a>
          );
        } else {
          result.push(<span key={`${keyPrefix}-lnk-${si}`}>{seg}</span>);
        }
      } else if (seg) {
        // Recurse on plain segments so bold/italic/code still work
        result.push(...renderInlineFormatting(seg, `${keyPrefix}-ls-${si}`));
      }
    });
    return result;
  }

  // Split by inline code first (backticks)
  const codeParts = text.split(/(`[^`]+`)/g);
  const result: React.ReactNode[] = [];

  codeParts.forEach((part, ci) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      result.push(
        <code
          key={`${keyPrefix}-ic-${ci}`}
          className="px-1 py-0.5 rounded text-[13px]"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', fontFamily: 'monospace', color: 'var(--foreground)' }}
        >
          {part.slice(1, -1)}
        </code>
      );
      return;
    }

    // Process bold, italic, strikethrough via regex
    // Pattern: **bold**, *italic*, ~~strike~~
    const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(part)) !== null) {
      // Text before the match
      if (match.index > lastIndex) {
        result.push(<span key={`${keyPrefix}-t-${ci}-${lastIndex}`}>{part.slice(lastIndex, match.index)}</span>);
      }
      const m = match[0];
      if (m.startsWith('**') && m.endsWith('**')) {
        result.push(<strong key={`${keyPrefix}-b-${ci}-${match.index}`}>{m.slice(2, -2)}</strong>);
      } else if (m.startsWith('~~') && m.endsWith('~~')) {
        result.push(<del key={`${keyPrefix}-s-${ci}-${match.index}`}>{m.slice(2, -2)}</del>);
      } else if (m.startsWith('*') && m.endsWith('*')) {
        result.push(<em key={`${keyPrefix}-i-${ci}-${match.index}`}>{m.slice(1, -1)}</em>);
      }
      lastIndex = match.index + m.length;
    }
    // Remaining text
    if (lastIndex < part.length) {
      result.push(<span key={`${keyPrefix}-t-${ci}-${lastIndex}`}>{part.slice(lastIndex)}</span>);
    }
  });

  return result;
}

const FILE_API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const OPEN_COMMAND_PALETTE_EVENT = 'deft:open-command-palette';

/** Parse [[file:...]] markers from content and separate them */
function parseFileMarkers(content: string): { text: string; files: FileAttachment[] } {
  const filePattern = /\[\[file:([^:]+):([^:]+):([^:]+):([^:]+):([^\]]+)\]\]/g;
  const files: FileAttachment[] = [];
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(content)) !== null) {
    // Ensure URL is absolute so images load from the API server
    let url = match[5]!;
    if (url.startsWith('/')) url = FILE_API_BASE + url;
    files.push({
      id: match[1]!,
      name: match[2]!,
      type: match[3]!,
      size: parseInt(match[4]!, 10),
      url,
    });
  }
  const text = content.replace(filePattern, '').trim();
  return { text, files };
}

/** Render message content — handles both HTML (from TipTap) and plain text */
function renderContent(content: string) {
  // First separate file markers
  const { text } = parseFileMarkers(content);
  if (!text) return null;

  // Detect if content is HTML (from TipTap editor)
  const isHtml = text.startsWith('<') && /<\/?[a-z][\s>]/i.test(text);

  if (isHtml) {
    // Process mentions within HTML: replace <@id|name> with styled spans
    let processed = text.replace(
      /&lt;@([^|]+)\|([^&]+)&gt;/g,
      '<span class="px-1 py-0.5 rounded text-[13px] font-medium" style="background:rgba(212,168,83,0.15);color:var(--accent)">@$2</span>'
    ).replace(
      /<@([^|]+)\|([^>]+)>/g,
      '<span class="px-1 py-0.5 rounded text-[13px] font-medium" style="background:rgba(212,168,83,0.15);color:var(--accent)">@$2</span>'
    );
    // Replace #PREFIX-N with styled task reference chips
    processed = processed.replace(
      /#([A-Z]{2,6})-(\d+)/g,
      '<a href="/tasks?task=$1-$2" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-medium" style="background:var(--accent-subtle);color:var(--accent);text-decoration:none">$1-$2</a>'
    );
    // Highlight @here/@all/@channel broadcast mentions
    processed = processed.replace(
      /@(here|all|channel)\b/g,
      '<span style="background:rgba(234,179,8,0.2);color:var(--accent);font-weight:600;padding:1px 4px;border-radius:3px">@$1</span>'
    );
    return <span className="message-content" dangerouslySetInnerHTML={{ __html: sanitizeHtml(processed) }} />;
  }

  // Plain text with markdown (agent replies, seed data, non-TipTap messages)
  // Use the full markdown renderer for any text that has markdown patterns
  const hasMarkdown = /\*\*|__|~~|`|^#{1,3} |^- |^\d+\. |^> /m.test(text);
  if (hasMarkdown || text.includes('\n')) {
    let html = renderSimpleMarkdown(text);
    // Process mentions
    html = html.replace(
      /&lt;@([^|]+)\|([^&]+)&gt;/g,
      '<span style="background:var(--accent-muted);color:var(--primary);padding:1px 5px;border-radius:4px;font-weight:500">@$2</span>'
    ).replace(
      /<@([^|]+)\|([^>]+)>/g,
      '<span style="background:var(--accent-muted);color:var(--primary);padding:1px 5px;border-radius:4px;font-weight:500">@$2</span>'
    );
    // Process task references (DEFT-7 etc.)
    html = html.replace(
      /([A-Z]{2,6})-(\d+)/g,
      '<a href="/tasks?task=$1-$2" style="background:var(--surface-container-highest);color:var(--primary);padding:1px 6px;border-radius:4px;font-family:var(--font-mono);font-size:0.75rem;text-decoration:none">$1-$2</a>'
    );
    // Highlight @here/@all/@channel broadcast mentions
    html = html.replace(
      /@(here|all|channel)\b/g,
      '<span style="background:rgba(234,179,8,0.2);color:var(--accent);font-weight:600;padding:1px 4px;border-radius:3px">@$1</span>'
    );
    return <span className="message-content" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
  }

  const parts = text.split(/(<@[^>]+>|#?[A-Z]{2,6}-\d+|@(?:here|all|channel)\b)/g);
  const result: React.ReactNode[] = [];

  parts.forEach((part, i) => {
    const mentionMatch = part.match(/^<@([^|]+)\|([^>]+)>$/);
    const taskRefMatch = part.match(/^#?([A-Z]{2,6})-(\d+)$/);
    const broadcastMatch = part.match(/^@(here|all|channel)$/);
    if (broadcastMatch) {
      result.push(
        <span key={`b-${i}`} className="px-1 py-0.5 rounded text-[13px] font-semibold"
          style={{ background: 'rgba(234,179,8,0.2)', color: 'var(--accent)' }}>
          @{broadcastMatch[1]}
        </span>
      );
    } else if (mentionMatch) {
      result.push(
        <span
          key={`m-${i}`}
          className="px-1 py-0.5 rounded text-[13px] font-medium cursor-pointer"
          style={{
            background: 'var(--accent-light, rgba(124,107,79,0.15))',
            color: 'var(--accent)',
          }}
        >
          @{mentionMatch[2]}
        </span>
      );
    } else if (taskRefMatch) {
      result.push(
        <a
          key={`tr-${i}`}
          href={`/tasks?task=${taskRefMatch[1]}-${taskRefMatch[2]}`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-medium cursor-pointer hover:opacity-80"
          style={{
            background: 'var(--accent-subtle)',
            color: 'var(--accent)',
            textDecoration: 'none',
          }}
        >
          {taskRefMatch[1]}-{taskRefMatch[2]}
        </a>
      );
    } else if (part) {
      result.push(<span key={`t-${i}`}>{part}</span>);
    }
  });

  return result;
}

/** Extract embedded files from message content markers */
function getEmbeddedFiles(content: string): FileAttachment[] {
  return parseFileMarkers(content).files;
}

/** Detect clip marker in message content: [[clip:clipId:status]] */
function parseClipMarker(content: string): { clipId: string; status: string } | null {
  const match = content.match(/\[\[clip:([^:]+):([^\]]+)\]\]/);
  return match ? { clipId: match[1]!, status: match[2]! } : null;
}

export function SpaceChat({
  spaceId,
  spaceName,
  spaceType,
  spaceTopic,
  spaceDescription,
  highlightMessageId,
}: {
  spaceId: string;
  spaceName: string;
  spaceType: string;
  spaceTopic?: string | null;
  spaceDescription?: string | null;
  highlightMessageId?: string;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const { setThreadMessage, markSpaceRead, presence, spaces, orgMembers, startHuddle, joinHuddleBySpace, huddleSpaceId, huddleBusy, activeHuddles, openDmWith } = useChatContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  // presence is provided by ChatContext — no local state needed
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [moreMenuId, setMoreMenuId] = useState<string | null>(null);
  const [menuDirection, setMenuDirection] = useState<'down' | 'up'>('down');
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [forwardMsgId, setForwardMsgId] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<{ id: string; url: string; name: string; type: string; size: number }[]>([]);
  const activeSpaceIdRef = useRef(spaceId);
  activeSpaceIdRef.current = spaceId;
  const [linkPreviews, setLinkPreviews] = useState<Map<string, LinkPreview[]>>(new Map());
  const [renamingSpace, setRenamingSpace] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isTyping = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [mobileActionMsg, setMobileActionMsg] = useState<Message | null>(null);
  const [reminderMenuId, setReminderMenuId] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const previousSpaceIdRef = useRef(spaceId);
  const [createTaskMsg, setCreateTaskMsg] = useState<{ title: string; description: string; messageId: string } | null>(null);
  const [defaultProjectId, setDefaultProjectId] = useState<string | null>(null);
  const [recapSummary, setRecapSummary] = useState<string | null>(null);
  const [recapLoading, setRecapLoading] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);
  const [clipRecording, setClipRecording] = useState(false);
  const { uploadFile, uploading, progress, error: uploadError, setError: setUploadError } = useFileUpload();
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(new Set());
  const [memberCount, setMemberCount] = useState(0);
  const [pinCount, setPinCount] = useState(0);
  const [quotedMessage, setQuotedMessage] = useState<{ userName: string; content: string } | null>(null);
  const [profileCard, setProfileCard] = useState<{ userId: string; rect: { top: number; left: number; bottom: number } } | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  // Mirror mute state to the slash-menu's chat-mute-toggle command so its
  // label + dispatched action match what the user actually expects.
  useEffect(() => { setCurrentSpaceMuted(isMuted); }, [isMuted]);
  const [cmdToast, setCmdToast] = useState<string | null>(null);
  const [capturingDiscussion, setCapturingDiscussion] = useState(false);

  // P4-4 — pending agent_actions keyed by message_id for this space.
  // Polled every 5s so inline approval cards appear promptly.
  const pendingBySpaceKey = spaceId
    ? `/api/agent/actions/pending-by-space?space_id=${spaceId}`
    : null;

  const { data: pendingByMessage } = useSWR(
    pendingBySpaceKey,
    async (url: string) => {
      const res = await api.get(url);
      if (!res.ok) return {} as Record<string, AgentAction[]>;
      const list: Array<AgentAction & { message_id: string }> = await res.json();
      const map: Record<string, AgentAction[]> = {};
      for (const a of list) {
        if (!a.message_id) continue;
        (map[a.message_id] ??= []).push(a);
      }
      return map;
    },
    { refreshInterval: 5000, fallbackData: {} },
  );

  const displayContentForMessage = useCallback((msg: Message) => {
    const hasInlineApproval = Boolean(pendingByMessage?.[msg.id]?.length);
    const hasApprovalContext = hasInlineApproval || Object.keys(pendingByMessage ?? {}).length > 0;
    return normalizeInlineApprovalCopy(msg.content, hasApprovalContext);
  }, [pendingByMessage]);

  const workIntentBySpaceKey = spaceId
    ? `/api/work-intents?space_id=${spaceId}&limit=100`
    : null;

  const { data: workIntentsByMessage } = useSWR(
    workIntentBySpaceKey,
    async (url: string) => {
      const res = await api.get(url);
      if (!res.ok) return {} as Record<string, WorkIntentReceipt[]>;
      const data = await res.json();
      const list = (data.intents ?? []) as WorkIntentReceipt[];
      const map: Record<string, WorkIntentReceipt[]> = {};
      for (const intent of list) {
        if (!intent.source_message_id) continue;
        if (intent.status === 'proposed') continue;
        (map[intent.source_message_id] ??= []).push(intent);
      }
      return map;
    },
    { refreshInterval: 10000, fallbackData: {} },
  );

  // Load user's saved/bookmarked message IDs for this space
  useEffect(() => {
    api.get('/api/bookmarks').then(async res => {
      if (res.ok) {
        const data = await res.json();
        setSavedMessageIds(new Set(data.map((b: { message_id: string }) => b.message_id)));
      }
    });
  }, []);

  const toggleBookmark = async (messageId: string) => {
    const isSaved = savedMessageIds.has(messageId);
    if (isSaved) {
      const res = await api.delete(`/api/bookmarks/${messageId}`);
      if (res.ok) {
        setSavedMessageIds(prev => { const next = new Set(prev); next.delete(messageId); return next; });
      }
    } else {
      const res = await api.post('/api/bookmarks', { message_id: messageId, space_id: spaceId });
      if (res.ok || res.status === 409) {
        setSavedMessageIds(prev => new Set(prev).add(messageId));
      }
    }
  };

  const plainMessageText = (content: string) => stripHtml(content);

  const openTaskFromMessage = (msg: Message) => {
    let title = stripHtml(msg.content.replace(/<@[^>]+>/g, ' '))
      .replace(/\[\[file:[^\]]+\]\]/g, '')
      .replace(/\*\*|__|~~|`|#/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const sentenceEnd = title.search(/[.!?](\s|$)/);
    if (sentenceEnd > 0 && sentenceEnd < 80) {
      title = title.slice(0, sentenceEnd + 1);
    } else if (title.length > 80) {
      title = (title.slice(0, title.lastIndexOf(' ', 80)) || title.slice(0, 80)) + '...';
    }
    const description = `<blockquote>${msg.content}</blockquote><p><em>Created from chat in #${spaceName}</em></p>`;
    setCreateTaskMsg({ title: title || 'New task', description, messageId: msg.id });
  };

  const togglePinForMessage = async (msg: Message) => {
    if (msg.is_pinned) {
      const res = await api.delete(`/api/spaces/${spaceId}/pins/${msg.id}`);
      if (res.ok) {
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_pinned: false } : m));
      }
    } else {
      const res = await api.post(`/api/spaces/${spaceId}/pins`, { message_id: msg.id });
      if (res.ok || res.status === 409) {
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_pinned: true } : m));
      }
    }
  };

  const saveMessageToKnowledge = async (msg: Message) => {
    const title = plainMessageText(msg.content).split(/[.!?\n]/)[0]?.trim().slice(0, 100) || 'Decision';
    const res = await api.post(`/api/spaces/${spaceId}/knowledge`, {
      type: 'decision',
      title,
      content: plainMessageText(msg.content),
      source_message_id: msg.id,
    });
    setCmdToast(res.ok ? 'Saved to knowledge' : 'Failed to save knowledge');
  };

  const captureRecentDiscussion = async () => {
    if (capturingDiscussion) return;
    setCapturingDiscussion(true);
    try {
      const res = await api.post(`/api/spaces/${spaceId}/knowledge/capture-discussion`, {
        lookback_minutes: 120,
      });
      setCmdToast(res.ok ? 'Discussion capture queued' : 'Failed to queue discussion capture');
    } finally {
      setCapturingDiscussion(false);
    }
  };

  const copyMessageLink = (msg: Message) => {
    navigator.clipboard.writeText(`${window.location.origin}/chat?space=${spaceId}&message=${msg.id}`);
    setCmdToast('Message link copied');
  };

  // Auto-dismiss command toast
  useEffect(() => {
    if (cmdToast) { const t = setTimeout(() => setCmdToast(null), 3000); return () => clearTimeout(t); }
  }, [cmdToast]);

  // Space-scoped surfaces should not visually follow the user into another channel or DM.
  useEffect(() => {
    if (previousSpaceIdRef.current === spaceId) return;
    previousSpaceIdRef.current = spaceId;

    setThreadMessage(null);
    setRecapSummary(null);
    setRecapLoading(false);
    setShowKnowledge(false);
    setShowMembers(false);
    setShowScheduled(false);
    setCreateTaskMsg(null);
    setQuotedMessage(null);
    setPendingFiles([]);
    setMoreMenuId(null);
    setMobileActionMsg(null);
    setEmojiPickerMsgId(null);
    setReminderMenuId(null);
  }, [spaceId, setThreadMessage]);

  // Sync mute status from spaces list
  useEffect(() => {
    const space = spaces.find(s => s.id === spaceId);
    setIsMuted(!!space?.is_muted);
  }, [spaceId, spaces]);

  // Fetch member count and pin count for header
  useEffect(() => {
    let cancelled = false;
    setMemberCount(0);
    setPinCount(0);

    void api.get(`/api/spaces/${spaceId}/members`).then(async (res) => {
      if (!res.ok) return;
      const data = await res.json();
      if (!cancelled && activeSpaceIdRef.current === spaceId) {
        setMemberCount(Array.isArray(data) ? data.length : 0);
      }
    }).catch(() => {});
    void api.get(`/api/spaces/${spaceId}/pins`).then(async (res) => {
      if (!res.ok) return;
      const data = await res.json();
      if (!cancelled && activeSpaceIdRef.current === spaceId) {
        setPinCount(Array.isArray(data) ? data.length : 0);
      }
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [spaceId]);

  // Fetch default project for task creation
  useEffect(() => {
    if (!createTaskMsg || defaultProjectId) return;
    async function loadProject() {
      const res = await api.get('/api/projects');
      if (res.ok) {
        const data = await res.json();
        if (data.length > 0) setDefaultProjectId(data[0].id);
      }
    }
    loadProject();
  }, [createTaskMsg, defaultProjectId]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Capture the last read message ID ONCE per space visit, before markSpaceRead fires
  const lastReadMsgIdRef = useRef<string | null>(null);
  const hasSetRef = useRef<string | null>(null);
  useEffect(() => {
    if (hasSetRef.current !== spaceId) {
      const space = spaces.find(s => s.id === spaceId);
      lastReadMsgIdRef.current = space?.last_read_message_id || null;
      hasSetRef.current = spaceId;
    }
  }, [spaceId, spaces]);

  // Mark space as read when it becomes active — declared AFTER the ref capture effect
  useEffect(() => {
    markSpaceRead(spaceId);
  }, [spaceId, markSpaceRead]);

  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  useEffect(() => {
    setMessages([]);
    let cancelled = false;
    async function load() {
      const res = await api.get(`/api/messages/${spaceId}`);
      if (res.ok && !cancelled && activeSpaceIdRef.current === spaceId) {
        const data = await res.json();
        if (cancelled || activeSpaceIdRef.current !== spaceId) return;
        setMessages(data.messages || data || []);
        if (highlightMessageId) {
          // Scroll to the highlighted message after render
          setTimeout(() => {
            if (cancelled || activeSpaceIdRef.current !== spaceId) return;
            const el = document.querySelector(`[data-message-id="${highlightMessageId}"]`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setHighlightedId(highlightMessageId);
              // Clear highlight after animation
              setTimeout(() => {
                if (!cancelled && activeSpaceIdRef.current === spaceId) setHighlightedId(null);
              }, 3000);
            }
          }, 200);
        } else {
          setTimeout(() => {
            if (!cancelled && activeSpaceIdRef.current === spaceId) scrollToBottom();
          }, 100);
        }
      }
    }
    void load().catch(() => {});
    return () => { cancelled = true; };
  }, [spaceId, scrollToBottom, highlightMessageId]);

  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const unsubscribeFromSpace = subscribeToSpace(socket, spaceId);

    const onNew = (msg: Message & { parent_id?: string | null; metadata?: { is_agent_reply?: boolean } }) => {
      // Thread replies should NOT appear in the main message list
      if (msg.parent_id) {
        // If it's an agent reply, auto-open the thread so the user sees it
        if (msg.metadata?.is_agent_reply) {
          // Use setMessages to access current state (avoid stale closure)
          setMessages((prev) => {
            const parentMsg = prev.find(m => m.id === msg.parent_id);
            if (parentMsg) {
              // Schedule thread open outside of setState
              setTimeout(() => {
                setThreadMessage({
                  id: parentMsg.id,
                  content: parentMsg.content,
                  user_id: parentMsg.user_id,
                  user_name: parentMsg.user_name,
                  user_avatar: parentMsg.user_avatar,
                  is_deleted: parentMsg.is_deleted,
                  edited_at: parentMsg.edited_at,
                  created_at: parentMsg.created_at,
                  reactions: parentMsg.reactions,
                  file_ids: parentMsg.file_ids,
                });
              }, 0);
            }
            return prev; // don't modify messages
          });
        }
        return;
      }
      const normalizedMessage: Message = {
        ...msg,
        reactions: msg.reactions ?? [],
        reply_count: msg.reply_count ?? 0,
        latest_reply_at: msg.latest_reply_at ?? null,
        file_ids: msg.file_ids ?? [],
      };
      setMessages((prev) => (
        prev.some((message) => message.id === normalizedMessage.id)
          ? prev
          : [...prev, normalizedMessage]
      ));
      setTimeout(scrollToBottom, 50);
    };
    const onThreadUpdated = (data: { parent_id: string; reply_count: number; latest_reply_at: string }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === data.parent_id
            ? { ...m, reply_count: data.reply_count, latest_reply_at: data.latest_reply_at }
            : m
        )
      );
    };
    const onEdited = (msg: any) => {
      setMessages((prev) => prev.map((m) => m.id === msg.id ? { ...m, content: msg.content, edited_at: msg.edited_at, metadata: msg.metadata ?? (m as any).metadata } : m));
    };
    const onDeleted = (data: { id: string }) => {
      setMessages((prev) => prev.map((m) => m.id === data.id ? { ...m, is_deleted: true } : m));
    };
    const onTypingStart = (data: { user_id: string; user_name: string; space_id: string }) => {
      if (data.space_id === spaceId && data.user_id !== user?.id) setTypingUsers((prev) => new Map(prev).set(data.user_id, data.user_name));
    };
    const onTypingStop = (data: { user_id: string; space_id: string }) => {
      if (data.space_id === spaceId) setTypingUsers((prev) => { const n = new Map(prev); n.delete(data.user_id); return n; });
    };
    // presence is handled globally in the app layout

    const onReactionAdded = (data: { message_id: string; emoji: string; user_id: string }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== data.message_id) return m;
          const reactions = [...(m.reactions || [])];
          const existing = reactions.find((r) => r.emoji === data.emoji);
          if (existing) {
            if (!existing.users.includes(data.user_id)) {
              existing.count++;
              existing.users.push(data.user_id);
            }
          } else {
            reactions.push({ emoji: data.emoji, count: 1, users: [data.user_id] });
          }
          return { ...m, reactions };
        })
      );
    };

    const onReactionRemoved = (data: { message_id: string; emoji: string; user_id: string }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== data.message_id) return m;
          let reactions = [...(m.reactions || [])];
          const existing = reactions.find((r) => r.emoji === data.emoji);
          if (existing) {
            existing.count--;
            existing.users = existing.users.filter((u) => u !== data.user_id);
            if (existing.count <= 0) {
              reactions = reactions.filter((r) => r.emoji !== data.emoji);
            }
          }
          return { ...m, reactions };
        })
      );
    };

    socket.on('message:new', onNew);
    socket.on('message:edited', onEdited);
    socket.on('message:deleted', onDeleted);
    socket.on('typing:start', onTypingStart);
    socket.on('typing:stop', onTypingStop);
    // presence:update handled by layout
    socket.on('reaction:added', onReactionAdded);
    socket.on('reaction:removed', onReactionRemoved);
    socket.on('thread:updated', onThreadUpdated);

    const onLinkPreviews = (data: { message_id: string; previews: LinkPreview[] }) => {
      setLinkPreviews((prev) => {
        const next = new Map(prev);
        next.set(data.message_id, data.previews);
        return next;
      });
    };
    socket.on('message:link_previews', onLinkPreviews);

    const onMessagePinned = (data: { message_id: string }) => {
      setMessages(prev => prev.map(m => m.id === data.message_id ? { ...m, is_pinned: true } : m));
    };
    const onMessageUnpinned = (data: { message_id: string }) => {
      setMessages(prev => prev.map(m => m.id === data.message_id ? { ...m, is_pinned: false } : m));
    };
    socket.on('message:pinned', onMessagePinned);
    socket.on('message:unpinned', onMessageUnpinned);

    return () => {
      unsubscribeFromSpace();
      socket.off('message:new', onNew);
      socket.off('message:edited', onEdited);
      socket.off('message:deleted', onDeleted);
      socket.off('typing:start', onTypingStart);
      socket.off('typing:stop', onTypingStop);
      // presence:update handled by layout
      socket.off('reaction:added', onReactionAdded);
      socket.off('reaction:removed', onReactionRemoved);
      socket.off('thread:updated', onThreadUpdated);
      socket.off('message:link_previews', onLinkPreviews);
      socket.off('message:pinned', onMessagePinned);
      socket.off('message:unpinned', onMessageUnpinned);
    };
  }, [spaceId, user?.id, scrollToBottom]);

  const serializeMentions = (html: string) => html.replace(
    /<span[^>]*data-mention-uuid="([^"]+)"[^>]*data-mention-name="([^"]+)"[^>]*>[^<]*<\/span>/g,
    '<@$1|$2>'
  ).replace(
    /<span[^>]*data-mention-name="([^"]+)"[^>]*data-mention-uuid="([^"]+)"[^>]*>[^<]*<\/span>/g,
    '<@$2|$1>'
  );

  const handleScheduleSend = async (scheduledFor: string, html: string, text: string) => {
    const requestSpaceId = spaceId;
    const pendingFilesToSend = [...pendingFiles];
    let content = serializeMentions(html);
    // Embed file references as markers in the content
    if (pendingFilesToSend.length > 0) {
      const fileLines = pendingFilesToSend.map(
        (f) => `[[file:${f.id}:${f.name}:${f.type}:${f.size}:${f.url}]]`
      );
      content = content + '\n' + fileLines.join('\n');
    }
    const response = await api.post('/api/scheduled-messages', {
      space_id: requestSpaceId,
      content: content || '(attached files)',
      scheduled_for: scheduledFor,
    });
    if (!response.ok) {
      throw new Error(await apiErrorMessage(response, 'Failed to schedule message'));
    }
    if (activeSpaceIdRef.current !== requestSpaceId) return;
    const sentFileIds = new Set(pendingFilesToSend.map((file) => file.id));
    setPendingFiles((current) => current.filter((file) => !sentFileIds.has(file.id)));
  };

  const handleRichSend = async (html: string, text: string) => {
    const requestSpaceId = spaceId;
    const quotedMessageToSend = quotedMessage;
    const pendingFilesToSend = [...pendingFiles];
    let content = serializeMentions(html);
    // Prepend quoted message if present
    if (quotedMessageToSend) {
      const quoteHtml = serializeQuotedMessage(quotedMessageToSend);
      content = quoteHtml + content;
    }
    // Embed file references as markers in the content
    if (pendingFilesToSend.length > 0) {
      const fileLines = pendingFilesToSend.map(
        (f) => `[[file:${f.id}:${f.name}:${f.type}:${f.size}:${f.url}]]`
      );
      content = content + '\n' + fileLines.join('\n');
    }
    const token = localStorage.getItem('deft-access-token');
    if (token) getSocket(token).emit('typing:stop', { space_id: requestSpaceId });
    isTyping.current = false;
    const response = await api.post(`/api/messages/${requestSpaceId}`, {
      content: content || '(attached files)',
    });
    if (!response.ok) {
      throw new Error(await apiErrorMessage(response, 'Failed to send message'));
    }
    const createdMessage = await response.json() as Message;
    if (activeSpaceIdRef.current !== requestSpaceId) return;
    const sentFileIds = new Set(pendingFilesToSend.map((file) => file.id));
    setPendingFiles((current) => current.filter((file) => !sentFileIds.has(file.id)));
    if (quotedMessageToSend) {
      setQuotedMessage((current) => current === quotedMessageToSend ? null : current);
    }
    setMessages((prev) => (
      prev.some((message) => message.id === createdMessage.id)
        ? prev
        : [...prev, {
            ...createdMessage,
            reactions: createdMessage.reactions ?? [],
            reply_count: createdMessage.reply_count ?? 0,
            latest_reply_at: createdMessage.latest_reply_at ?? null,
            file_ids: createdMessage.file_ids ?? [],
          }]
    ));
    setTimeout(scrollToBottom, 50);
  };

  const handleEditLastMessage = useCallback(() => {
    // Find last message sent by current user
    const myMessages = messages.filter(m => m.user_id === user?.id && !m.is_deleted);
    const lastMsg = myMessages[myMessages.length - 1];
    if (lastMsg) {
      setEditingId(lastMsg.id);
      setEditContent(lastMsg.content);
      // Scroll the message into view so the edit box is visible
      setTimeout(() => {
        const el = document.querySelector(`[data-message-id="${lastMsg.id}"]`);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 50);
    }
  }, [messages, user?.id]);

  const handleEdit = async (id: string) => {
    if (!editContent.trim()) return;
    await api.patch(`/api/messages/${id}`, { content: editContent });
    setEditingId(null);
    setMoreMenuId(null);
  };

  const handleDelete = async (id: string) => {
    setMessages((prev) => prev.map((message) => (
      message.id === id ? { ...message, is_deleted: true } : message
    )));
    await api.delete(`/api/messages/${id}`);
    setMoreMenuId(null);
  };

  const handleReaction = async (msgId: string, emoji: string) => {
    await api.post(`/api/messages/${msgId}/reactions`, { emoji });
    setEmojiPickerMsgId(null);
  };

  const toggleReaction = async (msgId: string, emoji: string) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg) return;
    const reaction = msg.reactions?.find((r) => r.emoji === emoji);
    if (reaction && user && reaction.users.includes(user.id)) {
      await api.delete(`/api/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`);
    } else {
      await api.post(`/api/messages/${msgId}/reactions`, { emoji });
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const result = await uploadFile(file);
      if (result) {
        setPendingFiles((prev) => [...prev, result]);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileUploadComplete = async (result: { id: string; url: string; name: string; type: string; size: number }) => {
    setPendingFiles((prev) => [...prev, result]);
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const result = await uploadFile(file);
          if (result) setPendingFiles((prev) => [...prev, result]);
        }
      }
    }
  };

  const typingText = Array.from(typingUsers.values());
  const isDm = spaceType === 'dm' || spaceType === 'group_dm';
  const displayName = isDm
    ? (() => {
        const others = spaceName.split(',').map((n) => n.trim()).filter((n) => n !== user?.name);
        return others.length ? others.join(', ') : spaceName;
      })()
    : spaceName;

  return (
    <FileDropZone onUploadComplete={handleFileUploadComplete}>
      <div className="flex h-full">
      <div className="flex flex-col h-full flex-1 min-w-0">
        {/* Header */}
        <div
          className="px-3 md:px-5 flex-shrink-0 border-b"
          style={{ borderColor: 'var(--border-default, var(--outline-variant))' }}
        >
          {/* Row 1: channel name + topic + actions */}
          <TabStrip className="h-[48px] items-center relative">
            {!isDm && <Hash size={15} strokeWidth={1.5} style={{ color: 'var(--on-surface-variant)' }} />}
            {renamingSpace ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && renameValue.trim()) {
                    e.preventDefault();
                    try {
                      const res = await api.patch(`/api/spaces/${spaceId}`, { name: renameValue.trim() });
                      if (res.ok) setRenamingSpace(false);
                    } catch {}
                  }
                  if (e.key === 'Escape') { setRenamingSpace(false); setRenameValue(displayName); }
                }}
                onBlur={() => { setRenamingSpace(false); setRenameValue(displayName); }}
                className="text-[14px] font-semibold bg-transparent outline-none px-1 rounded"
                style={{ color: 'var(--on-surface)', border: '1px solid var(--primary-container)', minWidth: '80px' }}
              />
            ) : (
              <h2
                className="text-[14px] font-semibold cursor-pointer flex-shrink-0"
                style={{ color: 'var(--on-surface)' }}
                onDoubleClick={() => { if (!isDm) { setRenamingSpace(true); setRenameValue(displayName); } }}
                title={isDm ? undefined : 'Double-click to rename'}
              >
                {displayName}
              </h2>
            )}

            {/* Topic (truncated) */}
            {spaceTopic && !isDm && (
              <>
                <span className="text-[11px] mx-1" style={{ color: 'var(--outline)' }}>|</span>
                <span className="text-[12px] truncate max-w-[200px] md:max-w-[300px]"
                  style={{ color: 'var(--on-surface-variant)' }}
                  title={spaceTopic}>
                  {spaceTopic}
                </span>
              </>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Pin count */}
            {pinCount > 0 && (
              <button className="deft-pill hidden min-h-[30px] items-center gap-1 md:flex"
                style={{ color: 'var(--on-surface-variant)' }}
                title={`${pinCount} pinned messages`}>
                <Pin size={12} strokeWidth={1.5} />
                <span>{pinCount}</span>
              </button>
            )}

            {/* Member count */}
            <button
              onClick={() => setShowMembers(true)}
              className="deft-pill hidden min-h-[30px] items-center gap-1 md:flex"
              style={{ color: 'var(--on-surface-variant)' }}
              title="View members"
            >
              <Users size={13} strokeWidth={1.5} />
              <span>{memberCount}</span>
            </button>

            {/* Mute toggle */}
            <button
              onClick={async () => {
                const newMuted = !isMuted;
                setIsMuted(newMuted);
                await api.patch(`/api/spaces/${spaceId}/mute`, { muted: newMuted });
              }}
              className="deft-pill deft-pill-icon hidden min-h-[30px] items-center justify-center md:flex"
              style={{ color: isMuted ? 'var(--status-red)' : 'var(--on-surface-variant)' }}
              title={isMuted ? 'Unmute channel' : 'Mute channel'}
            >
              {isMuted ? <BellOff size={14} strokeWidth={1.5} /> : <Bell size={14} strokeWidth={1.5} />}
            </button>

            {/* Huddle button */}
            {HUDDLES_ENABLED && (() => {
              const inThisHuddle = huddleSpaceId === spaceId;
              const huddleHere = activeHuddles.get(spaceId);
              const othersInHuddle = !inThisHuddle && huddleHere && huddleHere.participants.length > 0;

              if (inThisHuddle) {
                return (
                  <button type="button" disabled aria-label={`You are in the huddle in ${displayName}`}
                    className="deft-pill min-h-[44px] md:min-h-[30px]"
                    style={{ background: '#22c55e', color: 'white' }} title="You're in this huddle">
                    <Mic size={13} strokeWidth={1.5} />
                    <span className="hidden md:inline">In Huddle</span>
                  </button>
                );
              }
              if (othersInHuddle) {
                return (
                  <button type="button" onClick={() => joinHuddleBySpace?.(spaceId)}
                    disabled={huddleBusy}
                    aria-label={`Join huddle in ${displayName} with ${huddleHere!.participants.length} participants`}
                    aria-busy={huddleBusy}
                    className="deft-pill min-h-[44px] animate-pulse disabled:cursor-wait disabled:opacity-60 md:min-h-[30px]"
                    style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
                    title={`${huddleHere!.participants.length} in huddle — click to join`}>
                    <Mic size={13} strokeWidth={1.5} />
                    <span className="hidden md:inline">{huddleBusy ? 'Connecting…' : `Join (${huddleHere!.participants.length})`}</span>
                  </button>
                );
              }
              return (
                <button type="button" onClick={() => startHuddle?.(spaceId)}
                  disabled={huddleBusy}
                  aria-label={`Start a huddle in ${displayName}`}
                  aria-busy={huddleBusy}
                  className="deft-pill min-h-[44px] disabled:cursor-wait disabled:opacity-60 md:min-h-[30px]"
                  style={{ color: 'var(--on-surface-variant)' }}
                  title="Start a huddle">
                  <Mic size={13} strokeWidth={1.5} />
                  <span className="hidden md:inline">{huddleBusy ? 'Connecting…' : 'Huddle'}</span>
                </button>
              );
            })()}

            {/* Catch Up */}
            <button
              onClick={async () => {
                setRecapLoading(true);
                try {
                  const res = await api.post(`/api/spaces/${spaceId}/recap`);
                  const data = await res.json();
                  if (res.ok) setRecapSummary(data.summary);
                  else setRecapSummary(`Failed to generate summary: ${data.error || 'Unknown error'}`);
                } catch { setRecapSummary('Failed to connect to the server.'); }
                setRecapLoading(false);
              }}
              aria-label="Catch up on this space"
              title="Catch Up"
              className="deft-pill min-h-[38px] md:min-h-[30px]"
              style={{ background: 'var(--accent-muted)', color: 'var(--primary)' }}
              disabled={recapLoading}
            >
              <Sparkles size={14} strokeWidth={1.7} className={recapLoading ? 'animate-pulse' : ''} />
              <span className="hidden md:inline">{recapLoading ? 'Reading...' : 'Catch Up'}</span>
            </button>

            {/* Knowledge */}
            <button
              onClick={() => setShowKnowledge(!showKnowledge)}
              aria-label={showKnowledge ? 'Close knowledge panel' : 'Open knowledge panel'}
              className="deft-pill deft-pill-icon min-h-[38px] md:min-h-[30px]"
              style={{
                color: showKnowledge ? 'var(--primary)' : 'var(--on-surface-variant)',
                background: showKnowledge ? 'var(--accent-muted)' : undefined,
              }}
              title="Knowledge"
            >
              <BookOpen size={14} strokeWidth={1.5} />
            </button>
          </TabStrip>

          {/* Row 2: Description (collapsible, only if exists) */}
          {spaceDescription && !isDm && (
            <div className="pb-2 -mt-1">
              <p className="text-[11px] truncate" style={{ color: 'var(--on-surface-variant)', opacity: 0.7 }}
                title={spaceDescription}>
                {spaceDescription}
              </p>
            </div>
          )}
        </div>
        {showMembers && (
          <SpaceMembersPanel
            spaceId={spaceId}
            spaceName={spaceName}
            spaceType={spaceType}
            onClose={() => setShowMembers(false)}
          />
        )}
        {/* Pinned messages bar — persistent at top of chat */}
        <PinnedBar spaceId={spaceId} />

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-2 md:px-4 py-0.5 relative" ref={scrollContainerRef} onScroll={(e) => {
          const el = e.currentTarget;
          setShowJumpToLatest(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
        }}>
          {recapSummary && (
            <div className="sticky top-0 z-10 mx-4 mb-4 p-4 rounded-lg" style={{ background: 'var(--surface-container)', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Catch Up Summary</span>
                </div>
                <button onClick={() => setRecapSummary(null)} className="p-1" style={{ color: 'var(--outline)' }}>
                  <X size={12} strokeWidth={1.5} />
                </button>
              </div>
              <div className="text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }} dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimpleMarkdown(recapSummary)) }} />
            </div>
          )}
          {messages.length === 0 && (
            <EmptyState
              icon={<MessageSquare size={20} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />}
              title={`This is the start of ${isDm ? displayName : '#' + spaceName}`}
              description="Send a message to kick things off."
            />
          )}
          {messages
            .filter((m) => {
              const meta = ((m as any).metadata ?? {}) as Record<string, unknown>;
              return meta.kind !== 'tool_result' && meta.hidden !== true;
            })
            .map((msg, i, visibleMessages) => {
            const prev = i > 0 ? visibleMessages[i - 1] : null;
            const grouped = prev ? shouldGroup(prev, msg) : false;
            const showDaySeparator = !prev || !isSameDay(prev.created_at, msg.created_at);
            const isHovered = hoveredId === msg.id;
            const color = avatarColor(msg.user_name || '');
            const messageWorkIntents = workIntentsByMessage?.[msg.id];

            // Detect system messages (task status changes, BYOA mention notices, etc.)
            const msgMeta = ((msg as any).metadata ?? {}) as Record<string, unknown>;
            const isSystemMessage = isTrustedSystemMessage(msgMeta);
            const isBot = msg.user_name === 'Defty' || msg.user_name === 'Deft' || (msg as any).metadata?.is_agent_reply;

            // Show "New messages" divider after the last-read message
            const showUnreadDivider = lastReadMsgIdRef.current
              && prev?.id === lastReadMsgIdRef.current
              && msg.user_id !== user?.id;

            return (
              <div key={msg.id} data-message-id={msg.id}>
                {/* Day separator */}
                {showDaySeparator && (
                  <div className="flex items-center justify-center my-6">
                    <span
                      className="text-[11px] font-semibold uppercase"
                      style={{
                        color: 'var(--outline-variant)',
                        letterSpacing: '0.05em',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {formatDayLabel(msg.created_at)}
                    </span>
                  </div>
                )}

                {/* Unread messages divider */}
                {showUnreadDivider && (
                  <div className="flex items-center gap-3 my-3 px-4">
                    <div className="flex-1 h-px" style={{ background: 'var(--status-red)' }} />
                    <span className="text-[11px] font-semibold" style={{ color: 'var(--status-red)' }}>
                      New messages
                    </span>
                    <div className="flex-1 h-px" style={{ background: 'var(--status-red)' }} />
                  </div>
                )}

                {/* System message */}
                {isSystemMessage && (
                  <div className="flex justify-center py-1.5">
                    <span
                      className="text-[12px] px-3 py-1 rounded-full"
                      style={{
                        color: 'var(--muted)',
                        background: 'var(--surface)',
                      }}
                    >
                      {renderContent(displayContentForMessage(msg))}
                    </span>
                  </div>
                )}

                {/* Message row */}
                {!isSystemMessage && <div
                  className={`relative px-3 -mx-2 md:-mx-3 rounded-lg ${highlightedId === msg.id ? 'message-highlight' : ''}`}
                  style={{
                    background: highlightedId === msg.id ? 'var(--accent-subtle)' : 'transparent',
                    marginTop: grouped ? '2px' : (i === 0 || showDaySeparator) ? '0px' : '16px',
                    transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                  onMouseEnter={() => setHoveredId(msg.id)}
                  onMouseMove={() => {
                    if (hoveredId !== msg.id) setHoveredId(msg.id);
                  }}
                  onFocusCapture={() => setHoveredId(msg.id)}
                  onMouseLeave={() => { setHoveredId(null); setMoreMenuId(null); }}
                >
                  {/* Mobile action button — always visible on touch */}
                  {!msg.is_deleted && editingId !== msg.id && (
                    <button
                      aria-label="Open message actions"
                      className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full absolute top-0 right-0 opacity-45 active:opacity-80"
                      style={{ color: 'var(--outline)' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMoreMenuId(null);
                        setMobileActionMsg(msg);
                      }}
                    >
                      <MoreHorizontal size={16} strokeWidth={1.8} />
                    </button>
                  )}

                  {/* Hover toolbar (desktop only) */}
                  {isHovered && !msg.is_deleted && editingId !== msg.id && (
                    <div
                      className="hidden md:flex absolute -top-3 right-3 items-center px-1 z-10"
                      style={{ background: 'var(--surface-container)', boxShadow: 'var(--glass-shadow)', borderRadius: '6px' }}
                    >
                      {/* React button */}
                      <div className="relative">
                        <button
                          className="p-1.5 rounded-full"
                          style={{ color: 'var(--muted)' }}
                          title="React"
                          onClick={() => setEmojiPickerMsgId(emojiPickerMsgId === msg.id ? null : msg.id)}
                        >
                          <Smile size={16} strokeWidth={1.5} />
                        </button>
                        {emojiPickerMsgId === msg.id && (
                          <EmojiPicker
                            onSelect={(emoji) => handleReaction(msg.id, emoji)}
                            onClose={() => setEmojiPickerMsgId(null)}
                          />
                        )}
                      </div>

                      {/* Reply button */}
                      <button
                        className="p-1.5 rounded-full"
                        style={{ color: 'var(--muted)' }}
                        title="Reply"
                        onClick={() => setThreadMessage(msg)}
                      >
                        <MessageSquare size={16} strokeWidth={1.5} />
                      </button>

                      <button
                        className="p-1.5 rounded-full"
                        style={{ color: msg.is_pinned ? 'var(--primary)' : 'var(--outline)' }}
                        title={msg.is_pinned ? 'Unpin' : 'Pin'}
                        onClick={async () => {
                          if (msg.is_pinned) {
                            const res = await api.delete(`/api/spaces/${spaceId}/pins/${msg.id}`);
                            if (res.ok) {
                              setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_pinned: false } : m));
                            }
                          } else {
                            const res = await api.post(`/api/spaces/${spaceId}/pins`, { message_id: msg.id });
                            if (res.ok || res.status === 409) {
                              setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_pinned: true } : m));
                            }
                          }
                        }}
                      >
                        <Pin size={16} strokeWidth={1.5} />
                      </button>

                      <button
                        className="p-1.5 rounded-full"
                        style={{ color: savedMessageIds.has(msg.id) ? 'var(--primary)' : 'var(--muted)' }}
                        title={savedMessageIds.has(msg.id) ? 'Remove from saved' : 'Save for later'}
                        onClick={() => toggleBookmark(msg.id)}
                      >
                        <Bookmark size={16} strokeWidth={1.5} fill={savedMessageIds.has(msg.id) ? 'currentColor' : 'none'} />
                      </button>

                      <button
                        className="p-1.5 rounded-full"
                        style={{ color: 'var(--muted)' }}
                        title="Create task"
                        onClick={() => {
                          // Strip mention/file markers, then use the shared
                          // parser so quoted ">" characters cannot evade tag handling.
                          let title = stripHtml(msg.content
                            .replace(/<@[^>]+>/g, ' ')
                            .replace(/\[\[file:[^\]]+\]\]/g, ' '))
                            .replace(/\*\*|__|~~|`|#/g, '') // strip markdown
                            .replace(/\s+/g, ' ') // collapse whitespace
                            .trim();
                          // Take first sentence from the beginning of the message
                          const sentenceEnd = title.search(/[.!?](\s|$)/);
                          if (sentenceEnd > 0 && sentenceEnd < 80) {
                            title = title.slice(0, sentenceEnd + 1);
                          } else if (title.length > 80) {
                            title = (title.slice(0, title.lastIndexOf(' ', 80)) || title.slice(0, 80)) + '...';
                          }
                          // Build description with source attribution
                          const description = `<blockquote>${msg.content}</blockquote><p><em>Created from chat in #${spaceName}</em></p>`;
                          setCreateTaskMsg({ title, description, messageId: msg.id });
                        }}
                      >
                        <CheckSquare size={16} strokeWidth={1.5} />
                      </button>

                      <div className="relative">
                        <button
                          ref={moreButtonRef}
                          className="p-1.5 rounded-full"
                          style={{ color: 'var(--muted)' }}
                          title="More"
                          aria-label="More message actions"
                          onClick={() => {
                            if (moreMenuId === msg.id) {
                              setMoreMenuId(null);
                            } else {
                              const rect = moreButtonRef.current?.getBoundingClientRect();
                              const spaceBelow = window.innerHeight - (rect?.bottom || 0);
                              setMenuDirection(spaceBelow < 200 ? 'up' : 'down');
                              setMoreMenuId(msg.id);
                            }
                          }}
                        >
                          <MoreHorizontal size={16} strokeWidth={1.5} />
                        </button>
                        {moreMenuId === msg.id && (
                          <div
                            className={`absolute right-0 ${menuDirection === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} w-44 rounded-xl py-1.5 z-20`}
                            style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)' }}
                          >
                            {msg.user_id === user?.id && (
                              <button
                                className="w-full text-left px-3.5 py-2 text-[13px] flex items-center gap-2.5"
                                style={{ color: 'var(--foreground-secondary)' }}
                                onClick={() => { setEditingId(msg.id); setEditContent(msg.content); setMoreMenuId(null); }}
                              >
                                <Pencil size={13} strokeWidth={1.5} /> Edit
                              </button>
                            )}
                            <button onClick={() => {
                              copyMessageLink(msg);
                              setMoreMenuId(null);
                            }} className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5"
                              style={{ color: 'var(--on-surface-variant)' }}>
                              <Copy size={13} strokeWidth={1.5} /> Copy link
                            </button>
                            <button onClick={async () => {
                              const res = await api.post(`/api/spaces/${spaceId}/mark-unread`, { message_id: msg.id });
                              setCmdToast(res.ok ? 'Marked unread' : 'Failed to mark unread');
                              setMoreMenuId(null);
                            }} className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5 hover:bg-[var(--bg-hover)]"
                              style={{ color: 'var(--on-surface-variant)' }}>
                              <MailOpen size={13} strokeWidth={1.5} /> Mark unread
                            </button>
                            <button onClick={() => {
                              const plain = plainMessageText(msg.content).slice(0, 200);
                              setQuotedMessage({ userName: msg.user_name, content: plain });
                              setMoreMenuId(null);
                            }} className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5"
                              style={{ color: 'var(--on-surface-variant)' }}>
                              <MessageSquare size={13} strokeWidth={1.5} /> Quote
                            </button>
                            <button onClick={() => {
                              setForwardMsgId(msg.id);
                              setMoreMenuId(null);
                            }} className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5 hover:bg-[var(--bg-hover)]"
                              style={{ color: 'var(--on-surface-variant)' }}>
                              <Forward size={13} strokeWidth={1.5} /> Forward
                            </button>
                            <button onClick={() => {
                              void saveMessageToKnowledge(msg);
                              setMoreMenuId(null);
                            }} className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5"
                              style={{ color: 'var(--on-surface-variant)' }}>
                              <BookOpen size={13} strokeWidth={1.5} /> Save to Knowledge
                            </button>
                            <button
                              onClick={() => {
                                void captureRecentDiscussion();
                                setMoreMenuId(null);
                              }}
                              disabled={capturingDiscussion}
                              className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5 disabled:opacity-50"
                              style={{ color: 'var(--on-surface-variant)' }}
                            >
                              <Sparkles size={13} strokeWidth={1.5} /> Capture recent discussion
                            </button>
                            <div className="relative">
                              <button className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5"
                                style={{ color: 'var(--on-surface-variant)' }}
                                onClick={(e) => { e.stopPropagation(); setReminderMenuId(reminderMenuId === msg.id ? null : msg.id); }}>
                                <Clock size={13} strokeWidth={1.5} /> Remind me
                              </button>
                              {reminderMenuId === msg.id && (
                                <div className="absolute right-full top-0 mr-1 w-44 py-1 rounded-lg z-50"
                                  style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)' }}>
                                  {[
                                    { label: 'In 20 minutes', mins: 20 },
                                    { label: 'In 1 hour', mins: 60 },
                                    { label: 'In 3 hours', mins: 180 },
                                    { label: 'Tomorrow 9 AM', mins: null as number | null },
                                  ].map(opt => (
                                    <button key={opt.label} onClick={async () => {
                                      const time = opt.mins
                                        ? new Date(Date.now() + opt.mins * 60000)
                                        : (() => { const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0); return d; })();
                                      await api.post('/api/reminders', {
                                        remind_at: time.toISOString(),
                                        source_message_id: msg.id,
                                      });
                                      setMoreMenuId(null);
                                      setReminderMenuId(null);
                                    }}
                                      className="w-full text-left px-3 py-1.5 text-[0.75rem]"
                                      style={{ color: 'var(--on-surface-variant)' }}>
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            {msg.user_id === user?.id && (
                              <button
                                className="w-full text-left px-3.5 py-2 text-[13px] flex items-center gap-2.5"
                                style={{ color: 'var(--danger)' }}
                                onClick={() => {
                                  setDeleteConfirmId(msg.id);
                                  setMoreMenuId(null);
                                }}
                              >
                                <Trash2 size={13} strokeWidth={1.5} /> Delete
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Mobile more-menu (rendered at message level, outside hover toolbar) */}
                  {moreMenuId === msg.id && !isHovered && !msg.is_deleted && (
                    <div
                      className="md:hidden absolute right-1 z-20 w-44 rounded-xl py-1.5"
                      style={{
                        background: 'var(--surface-container-highest)',
                        boxShadow: 'var(--glass-shadow)',
                        ...(menuDirection === 'up' ? { bottom: '100%', marginBottom: '4px' } : { top: '2rem', marginTop: '4px' }),
                      }}
                    >
                      {msg.user_id === user?.id && (
                        <button
                          className="w-full text-left px-3.5 py-2 text-[13px] flex items-center gap-2.5"
                          style={{ color: 'var(--foreground-secondary)' }}
                          onClick={() => { setEditingId(msg.id); setEditContent(msg.content); setMoreMenuId(null); }}
                        >
                          <Pencil size={13} strokeWidth={1.5} /> Edit
                        </button>
                      )}
                      <button onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/chat?space=${spaceId}&message=${msg.id}`);
                        setMoreMenuId(null);
                      }} className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5"
                        style={{ color: 'var(--on-surface-variant)' }}>
                        <Copy size={13} strokeWidth={1.5} /> Copy link
                      </button>
                      <button
                        className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5"
                        style={{ color: 'var(--on-surface-variant)' }}
                        onClick={() => setThreadMessage(msg)}
                      >
                        <MessageSquare size={13} strokeWidth={1.5} /> Reply
                      </button>
                      <button
                        className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5"
                        style={{ color: msg.is_pinned ? 'var(--primary)' : 'var(--on-surface-variant)' }}
                        onClick={async () => {
                          if (msg.is_pinned) {
                            const res = await api.delete(`/api/spaces/${spaceId}/pins/${msg.id}`);
                            if (res.ok) setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_pinned: false } : m));
                          } else {
                            const res = await api.post(`/api/spaces/${spaceId}/pins`, { message_id: msg.id });
                            if (res.ok || res.status === 409) setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_pinned: true } : m));
                          }
                          setMoreMenuId(null);
                        }}
                      >
                        <Pin size={13} strokeWidth={1.5} /> {msg.is_pinned ? 'Unpin' : 'Pin'}
                      </button>
                      <button
                        className="w-full text-left px-3.5 py-2 text-[0.8125rem] flex items-center gap-2.5"
                        style={{ color: savedMessageIds.has(msg.id) ? 'var(--primary)' : 'var(--on-surface-variant)' }}
                        onClick={() => { toggleBookmark(msg.id); setMoreMenuId(null); }}
                      >
                        <Bookmark size={13} strokeWidth={1.5} fill={savedMessageIds.has(msg.id) ? 'currentColor' : 'none'} /> {savedMessageIds.has(msg.id) ? 'Unsave' : 'Save'}
                      </button>
                      {msg.user_id === user?.id && (
                        <button
                          className="w-full text-left px-3.5 py-2 text-[13px] flex items-center gap-2.5"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => {
                            setDeleteConfirmId(msg.id);
                            setMoreMenuId(null);
                          }}
                        >
                          <Trash2 size={13} strokeWidth={1.5} /> Delete
                        </button>
                      )}
                    </div>
                  )}

                  {grouped ? (
                    <div className="flex gap-3 py-[2px]">
                      <div className="w-9 flex-shrink-0 flex items-start justify-center">
                        <div className="flex items-center justify-center gap-1 pt-[3px]">
                          {isHovered && (
                            <span className="text-[10px]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}
                              title={formatTimeWithSenderZone(msg.created_at, msg.user_timezone, msg.user_name)}>
                              {formatMessageTime(msg.created_at)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        {msg.is_deleted ? (
                          <p className="text-[13px] italic" style={{ color: 'var(--muted)' }}>This message was deleted</p>
                        ) : editingId === msg.id ? (
                          <EditBox content={editContent} onChange={setEditContent} onSave={() => handleEdit(msg.id)} onCancel={() => setEditingId(null)} />
                        ) : (
                          <>
                            {(() => {
                              const clipInfo = parseClipMarker(msg.content);
                              const meta = (msg as any).metadata;
                              if (clipInfo) {
                                return (
                                  <ClipCard
                                    clipId={clipInfo.clipId}
                                    clipStatus={meta?.clip_status || clipInfo.status}
                                    clipSummary={meta?.clip_summary}
                                    clipDuration={meta?.clip_duration_s}
                                    clipUserName={meta?.clip_user_name}
                                    clipHasTranscript={meta?.clip_has_transcript}
                                  />
                                );
                              }
                              return (
                                <>
                                  <div className="text-[13px] whitespace-pre-wrap break-words" style={{ color: 'var(--foreground)', lineHeight: '20px' }}>
                                    {renderContent(displayContentForMessage(msg))}
                                    <WorkIntentReceiptChips intents={messageWorkIntents} inline className="ml-1 align-middle" />
                                    {msg.edited_at && <EditedIndicator messageId={msg.id} />}
                                  </div>
                                  <MessageFiles files={[...(msg.files || []), ...getEmbeddedFiles(msg.content)]} onImageClick={setLightboxSrc} />
                                  {linkPreviews.get(msg.id)?.map((preview, pi) => (
                                    <LinkPreviewCard key={`lp-${pi}`} preview={preview} />
                                  ))}
                                </>
                              );
                            })()}
                            {(() => {
                              const meta = ((msg as any).metadata ?? {}) as Record<string, unknown>;
                              const blocks = meta.agent_blocks as AgentBlock[] | undefined;
                              const citations = meta.citations as AgentCitation[] | null | undefined;
                              const model = meta.model as string | null | undefined;
                              const tokensIn = meta.tokens_in as number | null | undefined;
                              const tokensOut = meta.tokens_out as number | null | undefined;
                              if (!blocks && !citations && !model) return null;
                              return (
                                <AgentMessageBlocks
                                  blocks={blocks ?? null}
                                  citations={citations ?? null}
                                  model={model ?? null}
                                  tokens_in={tokensIn ?? null}
                                  tokens_out={tokensOut ?? null}
                                />
                              );
                            })()}
                            {pendingByMessage?.[msg.id]?.map((action) => (
                              <AgentActionCard
                                key={action.id}
                                action={action}
                                variant="compact"
                                onApprove={async () => {
                                  const res = await api.post(`/api/agent/actions/${action.id}/approve`, {});
                                  if (!res.ok) throw new Error(await apiErrorMessage(res, `Approve failed (${res.status})`));
                                  const body = await res.json().catch(() => ({ status: 'approved' }));
                                  if (pendingBySpaceKey) swrMutate(pendingBySpaceKey);
                                  if (workIntentBySpaceKey) swrMutate(workIntentBySpaceKey);
                                  return body;
                                }}
                                onReject={async () => {
                                  const res = await api.post(`/api/agent/actions/${action.id}/reject`, {});
                                  if (!res.ok) throw new Error(await apiErrorMessage(res, `Reject failed (${res.status})`));
                                  const body = await res.json().catch(() => ({ status: 'rejected' }));
                                  if (pendingBySpaceKey) swrMutate(pendingBySpaceKey);
                                  if (workIntentBySpaceKey) swrMutate(workIntentBySpaceKey);
                                  return body;
                                }}
                              />
                            ))}
                            <MessageReactions
                              reactions={msg.reactions}
                              userId={user?.id}
                              onToggle={(emoji) => toggleReaction(msg.id, emoji)}
                              onAdd={(emoji) => handleReaction(msg.id, emoji)}
                              emojiPickerOpen={emojiPickerMsgId === `reactions-${msg.id}`}
                              onToggleEmojiPicker={() => setEmojiPickerMsgId(emojiPickerMsgId === `reactions-${msg.id}` ? null : `reactions-${msg.id}`)}
                              onCloseEmojiPicker={() => setEmojiPickerMsgId(null)}
                              orgMembers={orgMembers}
                            />
                            <ThreadIndicator
                              replyCount={msg.reply_count}
                              latestReplyAt={msg.latest_reply_at}
                              hasUnread={(msg as any).has_unread_thread_replies}
                              onClick={() => setThreadMessage(msg)}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-3 py-1.5">
                      <div className="relative h-9 w-9 flex-shrink-0 self-start">
                        {msg.user_avatar ? (
                          <img
                            src={msg.user_avatar}
                            alt=""
                            className="w-9 h-9 rounded-full object-cover cursor-pointer hover:opacity-80"
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setProfileCard({ userId: msg.user_id, rect: { top: rect.top, left: rect.left, bottom: rect.bottom } });
                            }}
                          />
                        ) : (
                          <div
                            className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-medium text-white cursor-pointer hover:opacity-80"
                            style={{ background: color }}
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setProfileCard({ userId: msg.user_id, rect: { top: rect.top, left: rect.left, bottom: rect.bottom } });
                            }}
                          >
                            {msg.user_name?.charAt(0).toUpperCase()}
                          </div>
                        )}
                        {(presence.get(msg.user_id) === 'online' || presence.get(msg.user_id) === 'idle') && (
                          <div
                            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full"
                            style={{
                              background: presence.get(msg.user_id) === 'online' ? 'var(--status-green)' : '#EAB308',
                              border: `2px solid ${isHovered ? 'var(--surface)' : 'var(--background)'}`,
                            }}
                          />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span
                            className="text-[13px] font-medium cursor-pointer hover:underline"
                            style={{ color: 'var(--on-surface)' }}
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setProfileCard({ userId: msg.user_id, rect: { top: rect.top, left: rect.left, bottom: rect.bottom } });
                            }}
                          >
                            {msg.user_name}
                          </span>
                          {isBot && (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                              style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                              BOT
                            </span>
                          )}
                          <span className="text-[11px]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}
                            title={formatTimeWithSenderZone(msg.created_at, msg.user_timezone, msg.user_name)}>
                            {formatMessageTime(msg.created_at)}
                          </span>
                          <WorkIntentReceiptChips intents={messageWorkIntents} inline />
                          {msg.is_pinned && (
                            <span className="text-[0.6875rem] ml-1" style={{ color: 'var(--outline)' }}>pinned</span>
                          )}
                        </div>
                        {msg.is_deleted ? (
                          <p className="text-[13px] italic mt-0.5" style={{ color: 'var(--muted)' }}>This message was deleted</p>
                        ) : editingId === msg.id ? (
                          <EditBox content={editContent} onChange={setEditContent} onSave={() => handleEdit(msg.id)} onCancel={() => setEditingId(null)} />
                        ) : (
                          <>
                            {(() => {
                              const clipInfo = parseClipMarker(msg.content);
                              const meta = (msg as any).metadata;
                              if (clipInfo) {
                                return (
                                  <ClipCard
                                    clipId={clipInfo.clipId}
                                    clipStatus={meta?.clip_status || clipInfo.status}
                                    clipSummary={meta?.clip_summary}
                                    clipDuration={meta?.clip_duration_s}
                                    clipUserName={meta?.clip_user_name}
                                    clipHasTranscript={meta?.clip_has_transcript}
                                  />
                                );
                              }
                              return (
                                <>
                                  <div className="text-[13px] whitespace-pre-wrap break-words mt-0.5" style={{ color: 'var(--foreground)', lineHeight: '20px' }}>
                                    {renderContent(displayContentForMessage(msg))}
                                    {msg.edited_at && <EditedIndicator messageId={msg.id} />}
                                  </div>
                                  <MessageFiles files={[...(msg.files || []), ...getEmbeddedFiles(msg.content)]} onImageClick={setLightboxSrc} />
                                  {linkPreviews.get(msg.id)?.map((preview, pi) => (
                                    <LinkPreviewCard key={`lp-${pi}`} preview={preview} />
                                  ))}
                                </>
                              );
                            })()}
                            {(() => {
                              const meta = ((msg as any).metadata ?? {}) as Record<string, unknown>;
                              const blocks = meta.agent_blocks as AgentBlock[] | undefined;
                              const citations = meta.citations as AgentCitation[] | null | undefined;
                              const model = meta.model as string | null | undefined;
                              const tokensIn = meta.tokens_in as number | null | undefined;
                              const tokensOut = meta.tokens_out as number | null | undefined;
                              if (!blocks && !citations && !model) return null;
                              return (
                                <AgentMessageBlocks
                                  blocks={blocks ?? null}
                                  citations={citations ?? null}
                                  model={model ?? null}
                                  tokens_in={tokensIn ?? null}
                                  tokens_out={tokensOut ?? null}
                                />
                              );
                            })()}
                            {pendingByMessage?.[msg.id]?.map((action) => (
                              <AgentActionCard
                                key={action.id}
                                action={action}
                                variant="compact"
                                onApprove={async () => {
                                  const res = await api.post(`/api/agent/actions/${action.id}/approve`, {});
                                  if (!res.ok) throw new Error(await apiErrorMessage(res, `Approve failed (${res.status})`));
                                  const body = await res.json().catch(() => ({ status: 'approved' }));
                                  if (pendingBySpaceKey) swrMutate(pendingBySpaceKey);
                                  if (workIntentBySpaceKey) swrMutate(workIntentBySpaceKey);
                                  return body;
                                }}
                                onReject={async () => {
                                  const res = await api.post(`/api/agent/actions/${action.id}/reject`, {});
                                  if (!res.ok) throw new Error(await apiErrorMessage(res, `Reject failed (${res.status})`));
                                  const body = await res.json().catch(() => ({ status: 'rejected' }));
                                  if (pendingBySpaceKey) swrMutate(pendingBySpaceKey);
                                  if (workIntentBySpaceKey) swrMutate(workIntentBySpaceKey);
                                  return body;
                                }}
                              />
                            ))}
                            <MessageReactions
                              reactions={msg.reactions}
                              userId={user?.id}
                              onToggle={(emoji) => toggleReaction(msg.id, emoji)}
                              onAdd={(emoji) => handleReaction(msg.id, emoji)}
                              emojiPickerOpen={emojiPickerMsgId === `reactions-${msg.id}`}
                              onToggleEmojiPicker={() => setEmojiPickerMsgId(emojiPickerMsgId === `reactions-${msg.id}` ? null : `reactions-${msg.id}`)}
                              onCloseEmojiPicker={() => setEmojiPickerMsgId(null)}
                              orgMembers={orgMembers}
                            />
                            <ThreadIndicator
                              replyCount={msg.reply_count}
                              latestReplyAt={msg.latest_reply_at}
                              hasUnread={(msg as any).has_unread_thread_replies}
                              onClick={() => setThreadMessage(msg)}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
          {showJumpToLatest && (
            <button onClick={scrollToBottom}
              className="sticky bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-[0.75rem] font-medium z-10"
              style={{ background: 'var(--primary-container)', color: '#fff', boxShadow: 'var(--glass-shadow)' }}>
              ↓ Jump to latest
            </button>
          )}
        </div>

        {/* Typing indicator */}
        {typingText.length > 0 && (
          <div className="px-6 py-1 text-[12px] flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
            <span style={{ color: 'var(--foreground-secondary)' }}>{typingText.join(', ')}</span>
            {' '}{typingText.length === 1 ? 'is' : 'are'} typing...
          </div>
        )}

        {/* Upload progress */}
        <UploadProgress
          progress={progress}
          uploading={uploading}
          error={uploadError}
          onDismissError={() => setUploadError(null)}
        />

        {/* Pending files preview */}
        {pendingFiles.length > 0 && (
          <div className="px-6 py-2 flex gap-2 flex-wrap flex-shrink-0">
            {pendingFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px]"
                style={{ background: 'var(--surface-container)' }}
              >
                {isImageType(file.type) ? (
                  <ImageIcon size={13} strokeWidth={1.5} style={{ color: 'var(--muted)' }} />
                ) : (
                  <FileText size={13} strokeWidth={1.5} style={{ color: 'var(--muted)' }} />
                )}
                <span className="max-w-[120px] truncate" style={{ color: 'var(--foreground-secondary)' }}>
                  {file.name}
                </span>
                <button
                  onClick={() => setPendingFiles((prev) => prev.filter((f) => f.id !== file.id))}
                  className="p-0.5"
                  style={{ color: 'var(--muted)' }}
                >
                  <X size={12} strokeWidth={1.5} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Hidden file input */}
        <input ref={fileInputRef} type="file" className="hidden" multiple onChange={handleFileSelect} />

        {/* Clip recorder — replaces composer entirely while recording.
            Matches WhatsApp/iMessage pattern (recorder takes over the input area
            instead of stacking above the composer). The whole space-chat composer
            is hidden via the {!clipRecording && ...} wrapper below. */}
        {clipRecording && (
          <div className="px-3 md:px-4 py-2 md:py-3">
            <ClipRecorder
              spaceId={spaceId}
              contextType="space"
              contextId={spaceId}
              onComplete={() => setClipRecording(false)}
              onCancel={() => setClipRecording(false)}
            />
          </div>
        )}

        {/* Quote preview */}
        {quotedMessage && (
          <div className="mx-4 px-3 py-2 rounded-t-lg flex items-center gap-2 text-[11px]"
            style={{ background: 'var(--surface-container-high, var(--accent-muted))', borderLeft: '3px solid var(--primary)' }}>
            <div className="flex-1 min-w-0">
              <span className="font-semibold" style={{ color: 'var(--on-surface)' }}>{quotedMessage.userName}</span>
              <span className="ml-2 truncate" style={{ color: 'var(--on-surface-variant)' }}>{quotedMessage.content}</span>
            </div>
            <button onClick={() => setQuotedMessage(null)} className="p-0.5 hover:opacity-70"
              style={{ color: 'var(--outline)' }}>
              <X size={12} />
            </button>
          </div>
        )}

        {/* Rich text composer — hidden while recording so the recorder
            owns the input area (single focused interaction). */}
        {!clipRecording && (
        <RichComposer
          key={spaceId}
          placeholder={`Message ${isDm ? displayName : '#' + spaceName}`}
          onSend={handleRichSend}
          onScheduleSend={handleScheduleSend}
          onEditLastMessage={handleEditLastMessage}
          pendingFiles={pendingFiles}
          onRemovePendingFile={(id) => setPendingFiles((prev) => prev.filter((f) => f.id !== id))}
          onFileSelect={() => fileInputRef.current?.click()}
          onPaste={handlePaste}
          uploading={uploading}
          uploadProgress={progress}
          onViewScheduled={() => setShowScheduled(true)}
          onClipRecord={() => setClipRecording(true)}
          onAskDefty={() => { void openDeftyDm(api, openDmWith); }}
          spaceId={spaceId}
          onSlashCommand={async (command, args) => {
            switch (command) {
              case 'task':
                setCreateTaskMsg({ title: args || 'New task', description: '', messageId: '' });
                break;

              case 'remind': {
                // Parse time from args: "/remind 30m check email" → time="30m", text="check email"
                const parts = args.split(/\s+/);
                const timeStr = parts[0] || '20m';
                const text = parts.slice(1).join(' ') || 'Reminder';
                const parsed = parseReminderTime(timeStr);
                const ms = parsed?.ms || 20 * 60000;
                const label = parsed?.label || 'in 20m';
                const remindAt = new Date(Date.now() + ms).toISOString();
                const response = await api.post('/api/reminders', { content: text, remind_at: remindAt });
                if (!response.ok) throw new Error(await apiErrorMessage(response, 'Failed to set reminder'));
                setCmdToast(`Reminder set ${label}: "${text}"`);
                break;
              }

              case 'status': {
                // Parse: "/status 🍕 Lunch break" → emoji="🍕", text="Lunch break"
                const emojiMatch = args.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)\s*(.*)/u);
                const emoji = emojiMatch?.[1] || '💬';
                const text = emojiMatch?.[2]?.trim() || args || 'Busy';
                const response = await api.patch('/api/users/status', { emoji, text });
                if (!response.ok) throw new Error(await apiErrorMessage(response, 'Failed to update status'));
                setCmdToast(`Status set: ${emoji} ${text}`);
                break;
              }

              case 'dnd': {
                const isDndNow = user?.status_text === 'Do Not Disturb';
                if (isDndNow) {
                  const response = await api.delete('/api/users/status');
                  if (!response.ok) throw new Error(await apiErrorMessage(response, 'Failed to disable Do Not Disturb'));
                  setCmdToast('Do Not Disturb disabled');
                } else {
                  const response = await api.patch('/api/users/dnd', { enabled: true });
                  if (!response.ok) throw new Error(await apiErrorMessage(response, 'Failed to enable Do Not Disturb'));
                  setCmdToast('Do Not Disturb enabled');
                }
                break;
              }

              case 'mute': {
                const response = await api.patch(`/api/spaces/${spaceId}/mute`, { muted: true });
                if (!response.ok) throw new Error(await apiErrorMessage(response, `Failed to mute #${spaceName}`));
                setIsMuted(true);
                setCmdToast(`#${spaceName} muted`);
                break;
              }

              case 'unmute': {
                const response = await api.patch(`/api/spaces/${spaceId}/mute`, { muted: false });
                if (!response.ok) throw new Error(await apiErrorMessage(response, `Failed to unmute #${spaceName}`));
                setIsMuted(false);
                setCmdToast(`#${spaceName} unmuted`);
                break;
              }

              case 'search':
                document.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
                break;

              case 'note': {
                const res = await api.post('/api/daily-notes', { title: args || 'Untitled', content: '' });
                if (res.ok) {
                  const note = await res.json();
                  setCmdToast(`Note "${args || 'Untitled'}" created`);
                  // Navigate to the newly created note
                  setTimeout(() => router.push(`/notes?id=${note.id}`), 500);
                } else {
                  throw new Error(await apiErrorMessage(res, 'Failed to create note'));
                }
                break;
              }
            }
          }}
        />
        )}

        {/* Scheduled messages panel */}
        {showScheduled && <ScheduledPanel onClose={() => setShowScheduled(false)} />}

        {/* Create task from message */}
        {createTaskMsg && defaultProjectId && (
          <TaskQuickCreate
            projectId={defaultProjectId}
            initialTitle={createTaskMsg.title}
            initialDescription={createTaskMsg.description}
            sourceMessageId={createTaskMsg.messageId}
            onClose={() => setCreateTaskMsg(null)}
            onCreated={() => { setCreateTaskMsg(null); setCmdToast('Task created'); }}
          />
        )}

        {/* Lightbox */}
        {lightboxSrc && (
          <Lightbox src={lightboxSrc} alt="Image preview" onClose={() => setLightboxSrc(null)} />
        )}
      </div>
      {showKnowledge && <KnowledgePanel spaceId={spaceId} onClose={() => setShowKnowledge(false)} />}
      <MobileActionSheet
        open={!!mobileActionMsg}
        onClose={() => setMobileActionMsg(null)}
        title={mobileActionMsg ? `${mobileActionMsg.user_name}'s message` : 'Message actions'}
      >
        {mobileActionMsg && (
          <div className="space-y-1">
            <MobileMessageAction
              icon={<MessageSquare size={18} strokeWidth={1.7} />}
              label="Reply in thread"
              onClick={() => {
                setThreadMessage(mobileActionMsg);
                setMobileActionMsg(null);
              }}
            />
            <MobileMessageAction
              icon={<Smile size={18} strokeWidth={1.7} />}
              label="React"
              onClick={() => {
                setEmojiPickerMsgId(`reactions-${mobileActionMsg.id}`);
                setMobileActionMsg(null);
              }}
            />
            <MobileMessageAction
              icon={<CheckSquare size={18} strokeWidth={1.7} />}
              label="Create task"
              onClick={() => {
                openTaskFromMessage(mobileActionMsg);
                setMobileActionMsg(null);
              }}
            />
            <MobileMessageAction
              icon={<Bookmark size={18} strokeWidth={1.7} fill={savedMessageIds.has(mobileActionMsg.id) ? 'currentColor' : 'none'} />}
              label={savedMessageIds.has(mobileActionMsg.id) ? 'Remove from saved' : 'Save for later'}
              onClick={() => {
                void toggleBookmark(mobileActionMsg.id);
                setMobileActionMsg(null);
              }}
            />
            <MobileMessageAction
              icon={<BookOpen size={18} strokeWidth={1.7} />}
              label="Save to Knowledge"
              onClick={() => {
                void saveMessageToKnowledge(mobileActionMsg);
                setMobileActionMsg(null);
              }}
            />
            <MobileMessageAction
              icon={<Sparkles size={18} strokeWidth={1.7} />}
              label={capturingDiscussion ? 'Capture queued...' : 'Capture recent discussion'}
              onClick={() => {
                void captureRecentDiscussion();
                setMobileActionMsg(null);
              }}
            />
            <MobileMessageAction
              icon={<Pin size={18} strokeWidth={1.7} />}
              label={mobileActionMsg.is_pinned ? 'Unpin message' : 'Pin message'}
              onClick={() => {
                void togglePinForMessage(mobileActionMsg);
                setMobileActionMsg(null);
              }}
            />
            <MobileMessageAction
              icon={<Copy size={18} strokeWidth={1.7} />}
              label="Copy link"
              onClick={() => {
                copyMessageLink(mobileActionMsg);
                setMobileActionMsg(null);
              }}
            />
            <MobileMessageAction
              icon={<MailOpen size={18} strokeWidth={1.7} />}
              label="Mark unread"
              onClick={() => {
                void api.post(`/api/spaces/${spaceId}/mark-unread`, { message_id: mobileActionMsg.id });
                setMobileActionMsg(null);
              }}
            />
            {mobileActionMsg.user_id === user?.id && (
              <>
                <div className="h-px my-1" style={{ background: 'var(--outline-variant)' }} />
                <MobileMessageAction
                  icon={<Pencil size={18} strokeWidth={1.7} />}
                  label="Edit"
                  onClick={() => {
                    setEditingId(mobileActionMsg.id);
                    setEditContent(mobileActionMsg.content);
                    setMobileActionMsg(null);
                  }}
                />
                <MobileMessageAction
                  icon={<Trash2 size={18} strokeWidth={1.7} />}
                  label="Delete"
                  danger
                  onClick={() => {
                    setDeleteConfirmId(mobileActionMsg.id);
                    setMobileActionMsg(null);
                  }}
                />
              </>
            )}
          </div>
        )}
      </MobileActionSheet>
      {/* Command toast */}
      {cmdToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg text-[12px] font-medium"
          style={{ background: 'var(--foreground)', color: 'var(--background)' }}>
          {cmdToast}
        </div>
      )}
      {profileCard && (
        <UserProfileCard
          userId={profileCard.userId}
          anchorRect={profileCard.rect}
          onClose={() => setProfileCard(null)}
        />
      )}
      {deleteConfirmId && (
        <ConfirmDialog
          title="Delete message"
          message="Delete this message? This can't be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => { handleDelete(deleteConfirmId); setDeleteConfirmId(null); }}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}
      </div>
      {forwardMsgId && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[80] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setForwardMsgId(null)}>
          <div className="w-80 max-h-96 rounded-xl overflow-hidden" style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}>
            <div className="p-3 font-semibold text-[14px]" style={{ color: 'var(--foreground)', borderBottom: '1px solid var(--border)' }}>
              Forward to...
            </div>
            <div className="overflow-y-auto max-h-72 p-2">
              {spaces?.filter(s => s.id !== spaceId).map(s => (
                <button key={s.id} onClick={async () => {
                  await api.post('/api/messages/forward', { message_id: forwardMsgId, target_space_id: s.id });
                  setForwardMsgId(null);
                }} className="w-full text-left px-3 py-2 rounded-lg text-[13px] flex items-center gap-2 hover:bg-[var(--bg-hover)]"
                  style={{ color: 'var(--foreground)' }}>
                  # {s.name}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}
    </FileDropZone>
  );
}

/** Reactions row below a message */
function MessageReactions({
  reactions,
  userId,
  onToggle,
  onAdd,
  emojiPickerOpen,
  onToggleEmojiPicker,
  onCloseEmojiPicker,
  orgMembers,
}: {
  reactions?: Reaction[];
  userId?: string;
  onToggle: (emoji: string) => void;
  onAdd: (emoji: string) => void;
  emojiPickerOpen: boolean;
  onToggleEmojiPicker: () => void;
  onCloseEmojiPicker: () => void;
  orgMembers?: { id: string; name: string }[];
}) {
  if (!reactions || reactions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {reactions.map((reaction) => {
        const userReacted = userId ? reaction.users.includes(userId) : false;
        const names = orgMembers
          ? reaction.users.map(id => orgMembers.find(m => m.id === id)?.name).filter(Boolean)
          : [];
        const tooltip = names.length <= 5
          ? names.join(', ')
          : `${names.slice(0, 5).join(', ')} and ${names.length - 5} others`;
        return (
          <button
            key={reaction.emoji}
            onClick={() => onToggle(reaction.emoji)}
            title={tooltip || undefined}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px]"
            style={{
              background: userReacted ? 'var(--primary-container)' : 'var(--surface-container-highest)',
              color: userReacted ? '#fff' : 'var(--on-surface)',
              transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <span>{displayEmoji(reaction.emoji)}</span>
            <span className="text-[11px]" style={{ color: userReacted ? 'rgba(255,255,255,0.7)' : 'var(--outline)' }}>
              {reaction.count}
            </span>
          </button>
        );
      })}
      <div className="relative">
        <button
          onClick={onToggleEmojiPicker}
          className="flex items-center justify-center w-6 h-6 rounded-md"
          style={{ background: 'var(--surface-container-highest)', color: 'var(--outline)' }}
        >
          <Smile size={12} strokeWidth={1.5} />
        </button>
        {emojiPickerOpen && (
          <EmojiPicker
            onSelect={onAdd}
            onClose={onCloseEmojiPicker}
          />
        )}
      </div>
    </div>
  );
}

/** Thread reply count indicator */
function ThreadIndicator({
  replyCount,
  latestReplyAt,
  hasUnread,
  onClick,
}: {
  replyCount?: number;
  latestReplyAt?: string | null;
  hasUnread?: boolean;
  onClick: () => void;
}) {
  if (!replyCount || replyCount === 0) return null;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 mt-1.5 text-[12px] font-medium group"
      style={{ color: 'var(--primary-container)', fontWeight: 500, transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)' }}
    >
      {hasUnread && (
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'var(--primary, #6366f1)' }} />
      )}
      <span className="group-hover:underline inline-flex items-center gap-1">
        {replyCount} thread {replyCount === 1 ? 'reply' : 'replies'}
        <ChevronRight size={12} strokeWidth={2} />
      </span>
      {latestReplyAt && (
        <span className="text-[11px]" style={{ color: 'var(--outline)' }}>
          Last reply {formatMessageTime(latestReplyAt)}
        </span>
      )}
    </button>
  );
}

/** Clickable (edited) indicator with version history popover */
function EditedIndicator({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<{ id: string; content: string; edited_at: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (versions.length === 0) {
      setLoading(true);
      try {
        const res = await api.get(`/api/messages/${messageId}/history`);
        if (res.ok) {
          const data = await res.json();
          setVersions(data.versions || []);
        }
      } catch {} finally { setLoading(false); }
    }
  };

  return (
    <span className="relative inline-block">
      <button onClick={handleClick}
        className="text-[10px] ml-1.5 hover:underline cursor-pointer"
        style={{ color: 'var(--muted)' }}>
        (edited)
      </button>
      {open && (
        <div className="absolute left-0 top-5 z-50 w-[280px] max-h-[200px] overflow-y-auto rounded-lg shadow-lg p-3"
          style={{ background: 'var(--card-bg, var(--surface-container-low))', border: '1px solid var(--border-default, var(--outline-variant))' }}>
          <div className="text-[10px] font-semibold mb-2" style={{ color: 'var(--on-surface-variant)' }}>
            Edit History
          </div>
          {loading && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>Loading...</div>}
          {!loading && versions.length === 0 && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>No previous versions</div>}
          {versions.map((v) => (
            <div key={v.id} className="border-b last:border-b-0 py-1.5" style={{ borderColor: 'var(--border-default, var(--outline-variant))' }}>
              <div className="text-[10px]" style={{ color: 'var(--outline)' }}>{formatMessageTime(v.edited_at)}</div>
              <div className="text-[11px] mt-0.5 line-clamp-3" style={{ color: 'var(--on-surface-variant)' }}>
                {stripHtml(v.content).slice(0, 150)}
              </div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/** File attachments below a message */
function MessageFiles({
  files,
  onImageClick,
}: {
  files?: FileAttachment[];
  onImageClick: (src: string) => void;
}) {
  if (!files || files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {files.map((file) =>
        isImageType(file.type) || isImageUrl(file.url) ? (
          <button
            key={file.id}
            onClick={() => onImageClick(file.url)}
            className="rounded-lg overflow-hidden"
          >
            <img
              src={file.url}
              alt={file.name}
              className="max-w-full md:max-w-[400px] max-h-[300px] object-cover"
            />
          </button>
        ) : (
          <a
            key={file.id}
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg no-underline"
            style={{
              background: 'var(--surface-container)',
              color: 'var(--on-surface)',
              transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <FileText size={18} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
            <div className="min-w-0">
              <p className="text-[13px] font-medium truncate max-w-[200px]">{file.name}</p>
              <p className="text-[11px]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                {formatFileSize(file.size)}
              </p>
            </div>
          </a>
        )
      )}
    </div>
  );
}

/** Link preview card rendered below a message */
function LinkPreviewCard({ preview }: { preview: LinkPreview }) {
  let hostname = '';
  try { hostname = new URL(preview.url).hostname; } catch { hostname = preview.url; }

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block mt-2 rounded-lg overflow-hidden max-w-full md:max-w-[400px] no-underline"
      style={{ background: 'var(--surface-container)' }}
    >
      {preview.image && (
        <img src={preview.image} alt="" className="w-full max-w-full h-[160px] object-cover" />
      )}
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-1">
          {preview.favicon && <img src={preview.favicon} className="w-4 h-4 rounded" alt="" />}
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {preview.siteName || hostname}
          </span>
        </div>
        {preview.title && (
          <p
            className="text-[13px] font-medium leading-snug"
            style={{ color: 'var(--text-primary)' }}
          >
            {preview.title}
          </p>
        )}
        {preview.description && (
          <p
            className="text-[12px] mt-0.5 line-clamp-2"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            {preview.description}
          </p>
        )}
      </div>
    </a>
  );
}

function MobileMessageAction({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 min-h-[48px] px-3 py-2 rounded-xl text-left"
      style={{
        background: 'var(--surface-container-low)',
        color: danger ? 'var(--danger)' : 'var(--on-surface)',
      }}
    >
      <span
        className="flex items-center justify-center w-9 h-9 rounded-full flex-shrink-0"
        style={{
          background: danger ? 'rgba(239, 68, 68, 0.12)' : 'rgba(144,128,250,0.14)',
          color: danger ? 'var(--danger)' : 'var(--primary)',
        }}
      >
        {icon}
      </span>
      <span className="text-[0.875rem] font-semibold">{label}</span>
    </button>
  );
}

/** Inline card shown when the agent suggests creating a task from a message */
function EditBox({ content, onChange, onSave, onCancel }: { content: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, link: false }),
      Link.configure({ openOnClick: false }),
    ],
    content,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: {
      attributes: { class: 'deft-editor' },
      handleKeyDown(_view, event) {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSave(); return true; }
        if (event.key === 'Escape') { onCancel(); return true; }
        return false;
      },
    },
  });

  useEffect(() => { editor?.commands.focus('end'); }, [editor]);

  return (
    <div className="mt-1">
      <div className="text-[11px] mb-1 font-medium" style={{ color: 'var(--accent)' }}>Editing</div>
      <div className="flex gap-2 items-start">
        <div
          className="flex-1 px-3 py-1.5 rounded-lg text-[13px] outline-none"
          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--foreground)', minHeight: '2.5rem' }}
        >
          <EditorContent editor={editor} />
        </div>
        <button onClick={onSave} className="p-1" style={{ color: 'var(--success)' }}><Check size={15} /></button>
        <button onClick={onCancel} className="p-1" style={{ color: 'var(--danger)' }}><X size={15} /></button>
      </div>
      <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>Escape to cancel &middot; Enter to save</div>
    </div>
  );
}
