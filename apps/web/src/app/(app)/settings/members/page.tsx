'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

type Member = { id: string; name: string; email: string; avatar_url: string | null; role: string };

export default function MembersPage() {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    api.get('/api/members').then(async res => {
      if (res.ok) setMembers(await res.json());
    });
  }, []);

  return (
    <div className="p-6 max-w-[600px]">
      <h2 className="text-[18px] font-semibold mb-4" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>Members</h2>
      <div className="space-y-2">
        {members.map(m => (
          <div key={m.id} className="flex items-center gap-3 px-4 py-3 rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-medium text-white" style={{ background: 'var(--avatar-bg)' }}>
              {m.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <p className="text-[14px] font-medium" style={{ color: 'var(--foreground)' }}>{m.name}</p>
              <p className="text-[12px]" style={{ color: 'var(--muted)' }}>{m.email}</p>
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}>
              {m.role || 'member'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
