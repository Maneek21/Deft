'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { AgentChat } from '@/components/agent-chat';
import { Send } from 'lucide-react';

const SUGGESTIONS = [
  'What tasks are in progress?',
  'Summarize #engineering this week',
  'Who is working on what?',
  "What decisions were made this week?",
  "What's overdue?",
];

export default function AgentPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeId = searchParams.get('id');
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [localConvId, setLocalConvId] = useState<string | null>(null);
  const [input, setInput] = useState('');

  // Reset local state when URL changes (user clicked a conversation in sidebar)
  useEffect(() => {
    if (activeId) {
      setLocalConvId(null);
      setPendingPrompt(null);
    }
  }, [activeId]);

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    setPendingPrompt(text);
  };

  const effectiveId = activeId || localConvId;

  if (effectiveId) {
    return <AgentChat conversationId={effectiveId} />;
  }

  // Pending prompt — AgentChat handles lazy conversation creation.
  // onConversationCreated sets localConvId so the parent keeps rendering AgentChat
  // (instead of flashing back to empty state).
  if (pendingPrompt) {
    return <AgentChat initialPrompt={pendingPrompt} onConversationCreated={(id) => setLocalConvId(id)} />;
  }

  // Empty state WITH a composer at the bottom
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col items-center justify-center gap-8">
        <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-3xl"
          style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>
          {'\u25C7'}
        </div>
        <div className="text-center">
          <h2 className="text-[20px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }}>
            How can I help?
          </h2>
          <p className="text-[14px] mt-2 max-w-[360px]" style={{ color: 'var(--muted)' }}>
            I can search your workspace, create tasks, summarize conversations, and help you stay organized.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 max-w-[480px] justify-center">
          {SUGGESTIONS.map(prompt => (
            <button key={prompt} onClick={() => handleSend(prompt)}
              className="px-3.5 py-2 rounded-full text-[12px] transition-colors"
              style={{ border: '1px solid var(--border)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}>
              {prompt}
            </button>
          ))}
        </div>
      </div>

      {/* Composer — always visible */}
      <div className="px-6 py-4 flex-shrink-0">
        <div className="max-w-[700px] mx-auto">
          <div className="rounded-xl overflow-hidden flex items-end gap-2"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
            <textarea value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); setInput(''); } }}
              placeholder="Ask Deft anything..."
              className="flex-1 px-4 py-3 text-[14px] resize-none max-h-[120px] bg-transparent outline-none"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)', border: 'none', boxShadow: 'none' }}
              rows={1} />
            {input.trim() && (
              <div className="pr-2 pb-2">
                <button onClick={() => { handleSend(input); setInput(''); }}
                  className="p-2 rounded-lg text-white" style={{ background: 'var(--accent)' }}>
                  <Send size={16} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
