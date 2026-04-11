'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { useRouter } from 'next/navigation';
import { Send, Square, Loader2, ExternalLink } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

type Citation = { type: string; id: string; title: string };
type PendingAction = { id: string; action: string; params: Record<string, any> };

function AgentThinking({ toolStatus }: { toolStatus?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <div className="relative w-4 h-4 flex-shrink-0">
        <div className="absolute inset-0 rounded-full border-[1.5px] border-t-transparent animate-spin"
          style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      </div>
      <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
        {toolStatus || 'Thinking...'}
      </span>
    </div>
  );
}

type AutoExecutedAction = {
  id: string;
  action: string;
  params: any;
  success: boolean;
  result: any;
  error: string | null;
};

type AgentMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  pending_actions?: (PendingAction & { status?: string; executed_at?: string })[];
  auto_executed?: AutoExecutedAction[];
  streaming?: boolean;
  thinking?: boolean;
  tool_status?: string; // "Searching messages..."
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  follow_ups?: string[];
};

type Props = {
  conversationId?: string;
  initialPrompt?: string;
  onConversationCreated?: (id: string) => void;
  onTitleUpdate?: (title: string) => void;
  agentEmployeeId?: string;
};

function renderAgentMarkdown(text: string): string {
  if (!text) return '';
  let html = text
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Headers (## Header)
    .replace(/^### (.+)$/gm, '<h3 style="font-size:15px;font-weight:600;margin:12px 0 4px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:600;margin:14px 0 6px">$1</h2>')
    // Unordered lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul style="list-style:disc;padding-left:20px;margin:4px 0">$1</ul>')
    // Blockquotes
    .replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid var(--accent);padding-left:12px;margin:6px 0;color:var(--foreground-secondary)">$1</blockquote>')
    // Paragraphs — convert double newlines
    .replace(/\n\n/g, '</p><p>')
    // Single newlines within paragraphs
    .replace(/\n/g, '<br/>');

  // Wrap in paragraph
  if (!html.startsWith('<')) html = '<p>' + html + '</p>';

  return html;
}

function getFollowUpSuggestions(content: string, citations: Citation[]): string[] {
  const hasTasks = citations.some(c => c.type === 'task');
  const hasMessages = citations.some(c => c.type === 'message');

  const suggestions: string[] = [];
  if (hasTasks) {
    suggestions.push('Show me the details on the first task');
    suggestions.push('What else is assigned to the same person?');
  }
  if (hasMessages) {
    suggestions.push('Summarize the key decisions from these conversations');
  }
  if (content.toLowerCase().includes('overdue') || content.toLowerCase().includes('due')) {
    suggestions.push('Create a reminder for the overdue tasks');
  }
  if (!suggestions.length) {
    suggestions.push('Tell me more');
    suggestions.push('What should I focus on next?');
  }
  return suggestions.slice(0, 3);
}

export function AgentChat({ conversationId, initialPrompt, onConversationCreated, onTitleUpdate, agentEmployeeId }: Props) {
  const { user } = useAuth();
  const router = useRouter();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [noApiKey, setNoApiKey] = useState(false);
  const [loading, setLoading] = useState(!!conversationId);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(conversationId);
  const streamingRef = useRef(false); // tracks streaming across re-renders
  const [expandedCitationMsgs, setExpandedCitationMsgs] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialPromptSent = useRef(false);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    isUserScrolledUp.current = !atBottom;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (isUserScrolledUp.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Load conversation messages — skip if we're already streaming (lazy-created conversation)
  useEffect(() => {
    if (!conversationId) {
      setLoading(false);
      return;
    }
    // If we're actively streaming to this conversation, don't reload and wipe messages
    if (streamingRef.current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setMessages([]);
    setActiveConversationId(conversationId);
    api.get(`/api/agent/conversations/${conversationId}/messages`).then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setMessages(data.map((m: any) => ({
          id: m.id, role: m.role, content: m.content,
          citations: m.citations || [], pending_actions: [], auto_executed: [],
          model: m.model, tokens_in: m.tokens_in, tokens_out: m.tokens_out,
        })));
      }
      setLoading(false);
      setTimeout(scrollToBottom, 100);
    });
  }, [conversationId, scrollToBottom]);

  // Send initial prompt if provided (lazy conversation creation)
  useEffect(() => {
    if (initialPrompt && !initialPromptSent.current) {
      initialPromptSent.current = true;
      sendMessage(initialPrompt);
    }
  }, [initialPrompt]);

  // Auto-scroll when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendMessage = async (content: string) => {
    if (!content.trim() || streaming) return;

    setInput('');

    let convId = activeConversationId;

    // Set streaming flag early — prevents the conversationId effect from
    // wiping messages when the parent re-renders with the new conversation ID
    streamingRef.current = true;

    // Lazy conversation creation if no conversationId yet
    if (!convId) {
      try {
        const res = await api.post('/api/agent/conversations', {});
        if (res.ok) {
          const convo = await res.json();
          convId = convo.id;
          setActiveConversationId(convId);
          // Update URL without triggering a re-render/re-mount — router.push would
          // destroy this component and lose the SSE stream.
          // Preserve employee param if present so the parent doesn't switch tabs.
          const currentParams = new URLSearchParams(window.location.search);
          const employeeId = currentParams.get('employee') || agentEmployeeId;
          const newUrl = employeeId
            ? `/agent?id=${convId}&employee=${employeeId}`
            : `/agent?id=${convId}`;
          window.history.replaceState(null, '', newUrl);
          if (onConversationCreated) onConversationCreated(convId!);
        } else {
          streamingRef.current = false;
          setMessages(prev => [...prev, { role: 'assistant', content: 'Failed to create conversation.' }]);
          return;
        }
      } catch {
        streamingRef.current = false;
        setMessages(prev => [...prev, { role: 'assistant', content: 'Failed to create conversation.' }]);
        return;
      }
    }

    // Update title from first message
    if (messages.length === 0 && onTitleUpdate) {
      onTitleUpdate(content.slice(0, 60) + (content.length > 60 ? '...' : ''));
    }

    setStreaming(true);
    streamingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    // Add user message AND assistant placeholder in one atomic update
    setMessages(prev => [
      ...prev,
      { role: 'user', content },
      { role: 'assistant', content: '', streaming: true, thinking: true },
    ]);
    isUserScrolledUp.current = false;
    setTimeout(scrollToBottom, 50);

    try {
      const token = localStorage.getItem('deft-access-token');
      const res = await fetch(`${API_URL}/api/agent/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ content, ...(agentEmployeeId ? { agent_employee_id: agentEmployeeId } : {}) }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.code === 'NO_API_KEY') {
          setNoApiKey(true);
          setMessages(prev => prev.slice(0, -1)); // remove placeholder
          setStreaming(false);
          return;
        }
        throw new Error(data.error || 'Failed to get response');
      }

      // Parse SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();
      let agentText = '';
      let citations: Citation[] = [];
      let pendingActions: PendingAction[] = [];
      let autoExecutedActions: AutoExecutedAction[] = [];
      let buffer = '';
      let doneModel: string | undefined;
      let doneTokensIn: number | undefined;
      let doneTokensOut: number | undefined;
      let lastDataTime = Date.now();

      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        lastDataTime = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const data = JSON.parse(payload);

            switch (data.type) {
              case 'heartbeat':
                // Keepalive from server — ignore
                break;
              case 'text': {
                agentText += data.text;
                const snap = agentText;
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last && last.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, content: snap, thinking: false, streaming: true, tool_status: undefined };
                  }
                  return updated;
                });
                scrollToBottom();
                break;
              }
              case 'tool_start': {
                const toolLabel = data.tool.replace(/_/g, ' ').replace(/^(search|get|find|check)/, (m: string) => {
                  const labels: Record<string, string> = { search: 'Searching', get: 'Checking', find: 'Looking up', check: 'Checking' };
                  return labels[m] || m;
                });
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last && last.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, tool_status: toolLabel + '...', thinking: true };
                  }
                  return updated;
                });
                break;
              }
              case 'tool_result':
                // Don't clear tool_status — keep showing until next tool or text arrives
                break;
              case 'citations':
                citations = data.citations;
                break;
              case 'pending_action':
                pendingActions.push(data);
                break;
              case 'action_auto_executed':
                autoExecutedActions.push({
                  id: data.id,
                  action: data.action,
                  params: data.params,
                  success: data.success,
                  result: data.result,
                  error: data.error,
                });
                break;
              case 'error':
                agentText += `\n\n*Error: ${data.error}*`;
                break;
              case 'done':
                doneModel = data.model;
                doneTokensIn = data.tokens_in;
                doneTokensOut = data.tokens_out;
                streamDone = true; // exit the read loop
                break;
            }
          } catch {}
        }
      }

      // If stream ended with no content, show error
      if (!agentText.trim()) {
        agentText = 'Failed to get a response. Please try again.';
      }

      // Finalize agent message
      const followUps = getFollowUpSuggestions(agentText, citations);
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === 'assistant') {
          updated[updated.length - 1] = {
            ...last, content: agentText, streaming: false,
            citations, pending_actions: pendingActions, auto_executed: autoExecutedActions, tool_status: undefined,
            follow_ups: followUps,
            model: doneModel,
            tokens_in: doneTokensIn,
            tokens_out: doneTokensOut,
          };
        }
        return updated;
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last) updated[updated.length - 1] = { ...last, streaming: false, content: last.content + '\n\n*(stopped)*' };
          return updated;
        });
      } else {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last) updated[updated.length - 1] = { ...last, streaming: false, content: `Error: ${err.message}` };
          return updated;
        });
      }
    } finally {
      setStreaming(false);
      streamingRef.current = false;
      abortRef.current = null;
      scrollToBottom();
    }
  };

  const handleApprove = async (actionId: string) => {
    // Show "executing" state immediately
    setMessages(prev => prev.map(m => ({
      ...m,
      pending_actions: m.pending_actions?.map(a =>
        a.id === actionId ? { ...a, status: 'executing' } : a
      ),
    })));

    const res = await api.post(`/api/agent/actions/${actionId}/approve`);
    if (res.ok) {
      const result = await res.json();
      // Brief delay so the user sees the executing animation
      await new Promise(r => setTimeout(r, 1200));
      setMessages(prev => prev.map(m => ({
        ...m,
        pending_actions: m.pending_actions?.map(a =>
          a.id === actionId ? { ...a, status: result.success ? 'approved' : 'failed', executed_at: result.executed_at } : a
        ),
      })));
    }
  };

  const handleReject = async (actionId: string) => {
    await api.post(`/api/agent/actions/${actionId}/reject`);
    setMessages(prev => prev.map(m => ({
      ...m,
      pending_actions: m.pending_actions?.map(a =>
        a.id === actionId ? { ...a, status: 'rejected' } : a
      ),
    })));
  };

  const handleUndo = async (actionId: string) => {
    const res = await api.post(`/api/agent/actions/${actionId}/undo`);
    if (res.ok) {
      setMessages(prev => prev.map(m => ({
        ...m,
        pending_actions: m.pending_actions?.map(a =>
          a.id === actionId ? { ...a, status: 'undone' } : a
        ),
      })));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  if (noApiKey) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl"
          style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>◇</div>
        <p className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>
          Add your Anthropic API key in Settings to enable Deft
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6" ref={scrollContainerRef} onScroll={handleScroll}>
        <div className="max-w-[700px] w-full mx-auto space-y-6">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--muted)' }} />
            </div>
          )}
          {!loading && messages.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl"
                style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>◇</div>
              <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Send a message to start</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'assistant' && (
                <div className="w-4 h-4 flex items-center justify-center text-[16px] font-bold flex-shrink-0 mr-2 mt-0.5"
                  style={{ color: 'var(--accent)' }}>◇</div>
              )}
              <div className={`${msg.role === 'user' ? 'max-w-[85%] md:max-w-[70%]' : 'w-full'}`}>
                {msg.role === 'assistant' && (
                  <p className="text-[12px] font-semibold mb-1"
                    style={{ color: 'var(--accent)' }}>Deft</p>
                )}
                <div className="px-4 py-3" style={msg.role === 'user' ? {
                  background: 'var(--bg-active)',
                  color: 'var(--text-primary)',
                  borderRadius: '8px',
                } : {
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}>
                  {msg.role === 'assistant' && msg.thinking && !msg.content ? (
                    <AgentThinking toolStatus={msg.tool_status} />
                  ) : msg.role === 'assistant' ? (
                    <>
                      <div className="message-content text-[13px] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: renderAgentMarkdown(msg.content || (msg.streaming ? '' : '...')) }} />
                      {msg.thinking && msg.tool_status && (
                        <AgentThinking toolStatus={msg.tool_status} />
                      )}
                    </>
                  ) : (
                    <p className="text-[13px] whitespace-pre-wrap leading-relaxed">
                      {msg.content || (msg.streaming ? '' : '...')}
                    </p>
                  )}
                </div>

                {/* Citations */}
                {msg.citations && msg.citations.length > 0 && (() => {
                  // Filter out DM citations and deduplicate
                  const filtered = msg.citations
                    .filter(c => !c.title.includes(',')) // Remove DM-style "Maneek, Rahul" citations
                    .filter((c, ci, arr) => arr.findIndex(x => x.id === c.id) === ci) // dedupe
                    .slice(0, 5);

                  if (filtered.length === 0) return null;

                  const isExpanded = expandedCitationMsgs.has(i);
                  const visibleCitations = isExpanded ? filtered : filtered.slice(0, 3);

                  return (
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {visibleCitations.map((c, ci) => (
                        <button key={ci}
                          onClick={() => {
                            if (c.type === 'task') {
                              const match = c.title.match(/^([A-Z]+-\d+)/);
                              if (match) router.push(`/tasks?task=${match[1]}`);
                            } else if (c.type === 'message') {
                              router.push('/chat');
                            }
                          }}
                          className="px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
                          style={{ background: 'var(--bg-active)', color: 'var(--text-secondary)' }}>
                          {c.type === 'task' ? '\uD83D\uDCCB ' : '\uD83D\uDCAC '}{c.title.length > 40 ? c.title.slice(0, 40) + '...' : c.title}
                        </button>
                      ))}
                      {!isExpanded && filtered.length > 3 && (
                        <button className="px-2 py-0.5 rounded-md text-[10px]"
                          style={{ color: 'var(--outline)' }}
                          onClick={() => setExpandedCitationMsgs(prev => new Set(prev).add(i))}>
                          +{filtered.length - 3} more
                        </button>
                      )}
                    </div>
                  );
                })()}

                {/* Confidence indicator */}
                {!msg.streaming && msg.role === 'assistant' && msg.content && (
                  <div className="flex items-center gap-1.5 mt-2 text-[10px]" style={{ color: 'var(--muted)' }}>
                    {(msg.citations?.length || 0) >= 3 ? (
                      <><span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success)' }} /> High confidence</>
                    ) : (msg.citations?.length || 0) >= 1 ? (
                      <><span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} /> Based on limited data</>
                    ) : (
                      <><span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--danger)' }} /> Low confidence — no direct sources</>
                    )}
                  </div>
                )}

                {/* Token/model metadata */}
                {!msg.streaming && msg.role === 'assistant' && msg.model && (
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                    {msg.model.replace('claude-', '').replace(/-\d+$/, '')}
                    {msg.tokens_in && msg.tokens_out ? ` · ${msg.tokens_in + msg.tokens_out} tokens` : ''}
                  </div>
                )}

                {/* Follow-up suggestion chips */}
                {!msg.streaming && !streaming && msg.follow_ups && msg.follow_ups.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {msg.follow_ups.map((s, si) => (
                      <button key={si} onClick={() => sendMessage(s)}
                        disabled={streaming}
                        className="px-2.5 py-1 rounded-md text-[11px]"
                        style={{ background: 'var(--surface-container)', color: 'var(--on-surface-variant)' }}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}

                {/* Pending actions */}
                {msg.pending_actions && msg.pending_actions.length > 0 && (
                  msg.pending_actions.length === 1 ? (
                    <ActionCard key={msg.pending_actions[0].id} action={msg.pending_actions[0]}
                      onApprove={() => handleApprove(msg.pending_actions![0].id)}
                      onReject={() => handleReject(msg.pending_actions![0].id)}
                      onUndo={() => handleUndo(msg.pending_actions![0].id)} />
                  ) : (
                    <PlanCard
                      actions={msg.pending_actions}
                      onApproveAll={async () => {
                        for (const a of msg.pending_actions!) {
                          if (a.status !== 'rejected' && a.status !== 'approved') {
                            await handleApprove(a.id);
                          }
                        }
                      }}
                      onRejectAll={() => {
                        msg.pending_actions!.forEach(a => handleReject(a.id));
                      }}
                      onApproveOne={handleApprove}
                      onRejectOne={handleReject}
                    />
                  )
                )}

                {/* Auto-executed actions */}
                {msg.auto_executed && msg.auto_executed.length > 0 && (
                  <div className="space-y-1 mt-1">
                    {msg.auto_executed.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px]"
                        style={{
                          background: a.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                          border: `1px solid ${a.success ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
                        }}
                      >
                        <span style={{ color: a.success ? '#22C55E' : '#EF4444' }}>
                          {a.success ? '\u2713' : '\u2717'}
                        </span>
                        <span style={{ color: 'var(--foreground)' }}>
                          {a.action.replace(/_/g, ' ')}
                          {a.success && a.result?.identifier ? `: ${a.result.identifier}` : ''}
                          {a.error ? `: ${a.error}` : ''}
                        </span>
                        <span
                          className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--surface-container)', color: 'var(--muted)' }}
                        >
                          auto
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-[12px] font-medium text-white flex-shrink-0 ml-3 mt-0.5"
                  style={{ background: 'var(--avatar-bg)' }}>
                  {user?.name?.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="px-4 md:px-6 py-4 flex-shrink-0">
        <div className="max-w-[700px] w-full mx-auto">
          <div className="rounded-xl overflow-hidden flex items-end gap-2"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Deft anything..."
              className="flex-1 px-4 py-3 text-[14px] resize-none max-h-[120px] bg-transparent outline-none"
              style={{ color: 'var(--text-primary)', border: 'none', boxShadow: 'none' }}
              rows={1}
              disabled={streaming}
            />
            <div className="pr-2 pb-2">
              {streaming ? (
                <button onClick={() => abortRef.current?.abort()}
                  className="p-2 rounded-lg" style={{ color: 'var(--danger)' }}>
                  <Square size={16} fill="currentColor" />
                </button>
              ) : input.trim() ? (
                <button onClick={() => sendMessage(input)}
                  className="p-2 rounded-lg text-white" style={{ background: 'var(--accent)' }}>
                  <Send size={16} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionCard({ action, onApprove, onReject, onUndo }: {
  action: PendingAction & { status?: string; executed_at?: string };
  onApprove: () => void;
  onReject: () => void;
  onUndo?: () => void;
}) {
  const labels: Record<string, string> = {
    create_task: 'Create task',
    update_task_status: 'Update status',
    assign_task: 'Assign task',
    post_message: 'Post message',
  };

  if (action.status === 'executing') {
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px] flex items-center gap-2.5"
        style={{ background: 'rgba(124,107,79,0.08)', border: '1px solid rgba(124,107,79,0.15)', color: 'var(--on-surface-variant)' }}>
        <div className="relative flex items-center justify-center w-4 h-4 flex-shrink-0">
          <div className="absolute w-4 h-4 rounded-full border-2 border-t-transparent animate-spin"
            style={{ borderColor: 'var(--primary)', borderTopColor: 'transparent' }} />
        </div>
        <span className="font-medium">Executing {labels[action.action]?.toLowerCase()}...</span>
      </div>
    );
  }
  if (action.status === 'approved') {
    const canUndo = action.executed_at && (Date.now() - new Date(action.executed_at).getTime() < 5 * 60 * 1000);
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px] flex items-center gap-2"
        style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: 'var(--success)' }}>
        <span>{'\u2713'} {labels[action.action]} — done</span>
        {canUndo && onUndo && (
          <button onClick={onUndo} className="text-[11px] underline ml-2" style={{ color: 'var(--muted)' }}>
            Undo
          </button>
        )}
      </div>
    );
  }
  if (action.status === 'undone') {
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
        {'\u21A9'} {labels[action.action]} — undone
      </div>
    );
  }
  if (action.status === 'rejected') {
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
        ✗ {labels[action.action]} — rejected
      </div>
    );
  }

  return (
    <div className="p-3 mt-2 max-w-[380px] w-full"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: '8px' }}>
      <p className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {labels[action.action] || action.action}
      </p>
      <div className="text-[12px] mt-1 space-y-0.5" style={{ color: 'var(--foreground-secondary)' }}>
        {action.params.title && <p>"{action.params.title}"</p>}
        {action.params.project_name && <p>{action.params.project_name}</p>}
        {(action.params.priority || action.params.assignee_name) && (
          <p>{[action.params.priority?.toUpperCase(), action.params.assignee_name].filter(Boolean).join(' · ')}</p>
        )}
        {action.params.content && <p>"{action.params.content.slice(0, 80)}..."</p>}
        {action.params.space_name && <p>in #{action.params.space_name}</p>}
      </div>
      <div className="flex gap-2 mt-2.5">
        <button onClick={onApprove} className="px-3 py-1 rounded-md text-[11px] font-medium text-white"
          style={{ background: 'var(--status-green)' }}>Approve</button>
        <button onClick={onReject} className="px-3 py-1 rounded-md text-[11px] font-medium"
          style={{ background: 'var(--bg-overlay)', color: 'var(--text-secondary)' }}>Reject</button>
      </div>
    </div>
  );
}

function PlanCard({ actions, onApproveAll, onRejectAll, onApproveOne, onRejectOne }: {
  actions: (PendingAction & { status?: string })[];
  onApproveAll: () => void;
  onRejectAll: () => void;
  onApproveOne: (id: string) => void;
  onRejectOne: (id: string) => void;
}) {
  const labels: Record<string, string> = {
    create_task: 'Create task', update_task_status: 'Update status',
    assign_task: 'Assign task', post_message: 'Post message',
  };

  const allDone = actions.every(a => a.status === 'approved' || a.status === 'rejected' || a.status === 'undone');

  return (
    <div className="rounded-lg p-3 mt-2 max-w-[420px] w-full"
      style={{ background: 'var(--surface-container)', borderRadius: 'var(--radius-lg)' }}>
      <p className="text-[12px] font-semibold mb-2" style={{ color: 'var(--on-surface)' }}>
        Plan — {actions.length} steps
      </p>
      <div className="space-y-1.5">
        {actions.map((a, i) => (
          <div key={a.id} className="flex items-center gap-2 text-[12px]">
            <span style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)', width: '16px' }}>
              {a.status === 'approved' ? '\u2713' : a.status === 'rejected' ? '\u2717' : a.status === 'undone' ? '\u21A9' : `${i + 1}.`}
            </span>
            <span className="flex-1" style={{
              color: a.status === 'approved' ? 'var(--status-green)' :
                     a.status === 'rejected' ? 'var(--outline)' : 'var(--on-surface-variant)',
              textDecoration: a.status === 'rejected' ? 'line-through' : 'none',
            }}>
              {labels[a.action] || a.action}
              {a.params.title && `: "${a.params.title}"`}
              {a.params.space_name && ` in #${a.params.space_name}`}
            </span>
          </div>
        ))}
      </div>
      {!allDone && (
        <div className="flex gap-2 mt-3">
          <button onClick={onApproveAll} className="px-3 py-1.5 rounded-md text-[11px] font-medium text-white"
            style={{ background: 'var(--status-green)' }}>
            Approve All
          </button>
          <button onClick={onRejectAll} className="px-3 py-1.5 rounded-md text-[11px] font-medium"
            style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
            Reject All
          </button>
        </div>
      )}
    </div>
  );
}
