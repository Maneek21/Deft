'use client';

import React from 'react';

type Props = {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void } | { label: string; href: string };
};

export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 py-20">
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center"
        style={{ background: 'var(--surface-container-high)' }}
      >
        {icon}
      </div>
      <div className="text-center max-w-[320px]">
        <h3 className="text-[16px] font-semibold" style={{ color: 'var(--on-surface)' }}>
          {title}
        </h3>
        <p className="text-[13px] mt-1" style={{ color: 'var(--outline)' }}>
          {description}
        </p>
      </div>
      {action && (
        'href' in action ? (
          <a
            href={action.href}
            className="px-4 py-2 text-[13px] font-medium text-white"
            style={{ background: 'var(--primary-container)', borderRadius: 'var(--radius-lg)' }}
          >
            {action.label}
          </a>
        ) : (
          <button
            onClick={action.onClick}
            className="px-4 py-2 text-[13px] font-medium text-white"
            style={{ background: 'var(--primary-container)', borderRadius: 'var(--radius-lg)' }}
          >
            {action.label}
          </button>
        )
      )}
    </div>
  );
}
