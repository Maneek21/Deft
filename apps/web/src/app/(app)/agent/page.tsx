'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { AgentChat } from '@/components/agent-chat';
import { ConversationList } from '@/components/conversation-list';
import { Send, History, Plus, X } from 'lucide-react';

const SUGGESTIONS = [
  'What tasks are in progress?',
  'Summarize #engineering this week',
  'Who is working on what?',
  "What decisions were made this week?",
  "What's overdue?",
];

type Conversation = { id: string; title: string | null; updated_at: string; agent_employee_id?: string | null };
type AgentEmployee = { id: string; name: string; role: string; avatar_url: string | null; is_active: boolean; starter_prompts?: string[] | null };

function MobileConversationPanel({
  onClose,
  activeId,
  activeTab,
}: {
  onClose: () => void;
  activeId: string | null;
  activeTab: string;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const router = useRouter();

  useEffect(() => {
    const url = activeTab === 'defty'
      ? '/api/agent/conversations'
      : `/api/agent/conversations?employee=${activeTab}`;
    api.get(url).then(async res => {
      if (res.ok) {
        const data = await res.json();
        setConversations(
          data.filter((c: Conversation) => c.title && c.title !== 'New conversation'),
        );
      }
    });
  }, [activeTab]);

  return (
    <div
      className="md:hidden flex flex-col flex-shrink-0 border-b"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <span className="text-[0.75rem] font-semibold uppercase tracking-[0.05em]" style={{ color: 'var(--outline)' }}>
          Conversations
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded"
          style={{ color: 'var(--outline)' }}
          aria-label="Close conversation list"
        >
          <X size={16} />
        </button>
      </div>

      {/* New conversation */}
      <div className="px-3 py-2">
        <Link
          href={activeTab === 'defty' ? '/agent' : `/agent?employee=${activeTab}`}
          onClick={onClose}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[0.8125rem] font-medium w-full"
          style={{ color: 'var(--foreground-secondary)', background: 'var(--surface-hover)' }}
        >
          <Plus size={14} />
          New conversation
        </Link>
      </div>

      {/* Conversation list */}
      <div className="px-3 pb-3 overflow-y-auto max-h-[40vh]">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          hrefFor={(conv) =>
            conv.agent_employee_id
              ? `/agent?id=${conv.id}&employee=${conv.agent_employee_id}`
              : `/agent?id=${conv.id}`
          }
          onDelete={(id) => {
            setConversations((prev) => prev.filter((c) => c.id !== id));
            if (activeId === id) router.push('/agent');
            onClose();
          }}
          onNavigate={onClose}
          emptyText="No conversations yet"
        />
      </div>
    </div>
  );
}

export default function AgentPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeId = searchParams.get('id');
  const employeeParam = searchParams.get('employee');
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [localConvId, setLocalConvId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [showMobileConversations, setShowMobileConversations] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(employeeParam || 'defty');
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployee[]>([]);

  // Fetch agent employees
  useEffect(() => {
    api.get('/api/agent-employees').then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setAgentEmployees(data.filter((e: AgentEmployee) => e.is_active));
      }
    });
  }, []);

  // Sync activeTab with URL employee param
  useEffect(() => {
    if (employeeParam) {
      setActiveTab(employeeParam);
    } else {
      setActiveTab('defty');
    }
  }, [employeeParam]);

  // Reset local state when URL changes (user clicked a conversation in sidebar)
  useEffect(() => {
    if (activeId) {
      setLocalConvId(null);
      setPendingPrompt(null);
    }
  }, [activeId]);

  // When a specific conversation is loaded, preserve its agent context by
  // aligning the active tab with the conversation's agent_employee_id.
  useEffect(() => {
    if (!activeId) return;
    api.get(`/api/agent/conversations/${activeId}`).then(async (res) => {
      if (res.ok) {
        const conv = await res.json();
        const newTab = conv.agent_employee_id || 'defty';
        if (newTab !== activeTab) {
          setActiveTab(newTab);
          // Update URL to include employee param so refreshes keep the tab
          if (conv.agent_employee_id) {
            window.history.replaceState(
              null,
              '',
              `/agent?id=${activeId}&employee=${conv.agent_employee_id}`,
            );
          }
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Close mobile panel on navigation
  useEffect(() => {
    setShowMobileConversations(false);
  }, [activeId]);

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    setPendingPrompt(text);
  };

  const effectiveId = activeId || localConvId;

  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId);
    if (tabId === 'defty') {
      router.push('/agent');
    } else {
      router.push(`/agent?employee=${tabId}`);
    }
  };

  const activeEmployee = agentEmployees.find((e) => e.id === activeTab);

  // Tab bar for switching between Defty and agent employees
  const tabBar = agentEmployees.length > 0 ? (
    <div
      className="flex items-center gap-1 px-4 py-2 flex-shrink-0 border-b overflow-x-auto"
      style={{ borderColor: 'var(--border)' }}
    >
      <button
        onClick={() => handleTabClick('defty')}
        className="px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors flex-shrink-0"
        style={{
          background: activeTab === 'defty' ? 'var(--accent)' : 'transparent',
          color: activeTab === 'defty' ? 'white' : 'var(--on-surface-variant)',
        }}
      >
        Defty
      </button>
      {agentEmployees.map((employee) => (
        <button
          key={employee.id}
          onClick={() => handleTabClick(employee.id)}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors flex-shrink-0 flex items-center gap-1.5"
          style={{
            background: activeTab === employee.id ? 'var(--accent)' : 'transparent',
            color: activeTab === employee.id ? 'white' : 'var(--on-surface-variant)',
          }}
        >
          <span
            className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white flex-shrink-0"
            style={{ background: 'var(--primary-container)' }}
          >
            {employee.name.charAt(0).toUpperCase()}
          </span>
          {employee.name}
        </button>
      ))}
    </div>
  ) : null;

  // Employee chat tab — functional chat interface
  if (activeTab !== 'defty' && activeEmployee) {
    const formattedRole = activeEmployee.role
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c: string) => c.toUpperCase());

    return (
      <div className="flex flex-col h-full">
        {tabBar}
        {/* Employee header */}
        <div
          className="flex items-center gap-3 px-4 py-3 flex-shrink-0 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-bold text-white flex-shrink-0"
            style={{ background: 'var(--primary-container)' }}
          >
            {activeEmployee.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2
              className="text-[13px] font-semibold leading-tight"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }}
            >
              {activeEmployee.name}
            </h2>
            <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
              {formattedRole}
            </p>
          </div>
        </div>
        {/* Reuse AgentChat with employee context */}
        <div className="flex-1 overflow-hidden">
          <AgentChat
            key={activeEmployee.id}
            conversationId={activeId || undefined}
            agentEmployeeId={activeEmployee.id}
            agentName={activeEmployee.name}
            starterPrompts={activeEmployee.starter_prompts ?? undefined}
          />
        </div>
      </div>
    );
  }

  // Mobile history toggle button (shown only on mobile)
  const mobileHistoryButton = (
    <button
      onClick={() => setShowMobileConversations(prev => !prev)}
      className="md:hidden flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[0.75rem] font-medium flex-shrink-0"
      style={{
        background: showMobileConversations ? 'var(--accent-subtle)' : 'var(--surface-container-low)',
        color: showMobileConversations ? 'var(--accent)' : 'var(--on-surface-variant)',
        border: '1px solid var(--border)',
      }}
      aria-label="Toggle conversation history"
    >
      <History size={14} />
      History
    </button>
  );

  if (effectiveId) {
    return (
      <div className="flex flex-col h-full">
        {tabBar}
        {/* Mobile history toggle row */}
        <div className="md:hidden flex items-center px-4 py-2 flex-shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
          {mobileHistoryButton}
        </div>
        {showMobileConversations && (
          <MobileConversationPanel
            onClose={() => setShowMobileConversations(false)}
            activeId={effectiveId}
            activeTab={activeTab}
          />
        )}
        <div className="flex-1 overflow-hidden">
          <AgentChat conversationId={effectiveId} />
        </div>
      </div>
    );
  }

  // Pending prompt — AgentChat handles lazy conversation creation.
  // onConversationCreated sets localConvId so the parent keeps rendering AgentChat
  // (instead of flashing back to empty state).
  if (pendingPrompt) {
    return (
      <div className="flex flex-col h-full">
        {tabBar}
        {/* Mobile history toggle row */}
        <div className="md:hidden flex items-center px-4 py-2 flex-shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
          {mobileHistoryButton}
        </div>
        {showMobileConversations && (
          <MobileConversationPanel
            onClose={() => setShowMobileConversations(false)}
            activeId={null}
            activeTab={activeTab}
          />
        )}
        <div className="flex-1 overflow-hidden">
          <AgentChat initialPrompt={pendingPrompt} onConversationCreated={(id) => setLocalConvId(id)} />
        </div>
      </div>
    );
  }

  // Empty state WITH a composer at the bottom
  return (
    <div className="flex flex-col h-full">
      {tabBar}
      {/* Mobile history toggle row */}
      <div className="md:hidden flex items-center px-4 py-2 flex-shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
        {mobileHistoryButton}
      </div>
      {showMobileConversations && (
        <MobileConversationPanel
          onClose={() => setShowMobileConversations(false)}
          activeId={null}
          activeTab={activeTab}
        />
      )}

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
              placeholder="Ask Defty anything..."
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
