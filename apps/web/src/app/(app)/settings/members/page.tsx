'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { UserPlus, X, ChevronDown, Trash2 } from 'lucide-react';

type Member = { id: string; name: string; email: string; avatar_url: string | null; role: string };

const ROLE_OPTIONS = ['admin', 'member', 'guest'] as const;

export default function MembersPage() {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('member');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [roleDropdown, setRoleDropdown] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  const fetchMembers = async () => {
    const res = await api.get('/api/members');
    if (res.ok) setMembers(await res.json());
  };

  useEffect(() => { fetchMembers(); }, []);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteError('');
    setInviteSuccess('');
    setInviteLoading(true);
    try {
      const res = await api.post('/api/members/invite', { email: inviteEmail, role: inviteRole });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to invite');
      }
      setInviteSuccess(`Invitation sent to ${inviteEmail}`);
      setInviteEmail('');
      setInviteRole('member');
      fetchMembers();
      setTimeout(() => { setInviteSuccess(''); setShowInvite(false); }, 2000);
    } catch (err: any) {
      setInviteError(err.message);
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRoleChange = async (memberId: string, newRole: string) => {
    const res = await api.patch(`/api/members/${memberId}`, { role: newRole });
    if (res.ok) {
      setMembers(prev => prev.map(m => m.id === memberId ? { ...m, role: newRole } : m));
    }
    setRoleDropdown(null);
  };

  const handleRemove = async (memberId: string) => {
    const res = await api.delete(`/api/members/${memberId}`);
    if (res.ok) {
      setMembers(prev => prev.filter(m => m.id !== memberId));
    }
    setConfirmRemove(null);
  };

  return (
    <div className="p-6 max-w-[600px]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[18px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
          Members
        </h2>
        {isAdmin && (
          <button
            onClick={() => setShowInvite(!showInvite)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{
              background: 'var(--accent)',
              color: 'white',
              fontFamily: 'var(--font-heading)',
            }}
          >
            <UserPlus size={13} />
            Invite
          </button>
        )}
      </div>

      {/* Invite form */}
      {showInvite && (
        <form onSubmit={handleInvite} className="mb-4 p-4 rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
          {inviteError && (
            <div className="mb-3 px-3 py-2 text-[12px] rounded" style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}>
              {inviteError}
            </div>
          )}
          {inviteSuccess && (
            <div className="mb-3 px-3 py-2 text-[12px] rounded" style={{ background: 'rgba(0,120,80,0.2)', color: 'var(--accent)' }}>
              {inviteSuccess}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="name@company.com"
              className="flex-1 h-9 px-3 text-[13px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              required
            />
            <select
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value)}
              className="h-9 px-2 text-[12px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              {ROLE_OPTIONS.map(r => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={inviteLoading}
              className="h-9 px-4 text-[12px] font-medium rounded-md disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {inviteLoading ? '...' : 'Send'}
            </button>
          </div>
        </form>
      )}

      {/* Member list */}
      <div className="space-y-2">
        {members.map(m => (
          <div key={m.id} className="flex items-center gap-3 px-4 py-3 rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-medium text-white" style={{ background: 'var(--avatar-bg)' }}>
              {m.avatar_url ? (
                <img src={m.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
              ) : (
                m.name.charAt(0).toUpperCase()
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
                {m.name}
                {m.id === user?.id && <span className="text-[11px] ml-1" style={{ color: 'var(--muted)' }}>(you)</span>}
              </p>
              <p className="text-[12px] truncate" style={{ color: 'var(--muted)' }}>{m.email}</p>
            </div>

            {/* Role badge / dropdown */}
            {isAdmin && m.role !== 'owner' && m.id !== user?.id ? (
              <div className="relative">
                <button
                  onClick={() => setRoleDropdown(roleDropdown === m.id ? null : m.id)}
                  className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded"
                  style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)', border: '1px solid var(--border)' }}
                >
                  {m.role || 'member'}
                  <ChevronDown size={10} />
                </button>
                {roleDropdown === m.id && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setRoleDropdown(null)} />
                    <div className="absolute right-0 top-full mt-1 w-28 rounded-lg py-1 z-20"
                      style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
                      {ROLE_OPTIONS.map(r => (
                        <button
                          key={r}
                          onClick={() => handleRoleChange(m.id, r)}
                          className="w-full text-left px-3 py-1.5 text-[12px]"
                          style={{ color: m.role === r ? 'var(--accent)' : 'var(--foreground)' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover-tint)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          {r.charAt(0).toUpperCase() + r.slice(1)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <span className="text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}>
                {m.role || 'member'}
              </span>
            )}

            {/* Remove button */}
            {isAdmin && m.role !== 'owner' && m.id !== user?.id && (
              <>
                {confirmRemove === m.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleRemove(m.id)}
                      className="text-[11px] px-2 py-0.5 rounded"
                      style={{ background: 'var(--error)', color: 'white' }}
                    >
                      Confirm
                    </button>
                    <button onClick={() => setConfirmRemove(null)}>
                      <X size={12} style={{ color: 'var(--muted)' }} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmRemove(m.id)}
                    className="p-1 rounded opacity-0 group-hover:opacity-100"
                    style={{ color: 'var(--muted)' }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                    title="Remove member"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
