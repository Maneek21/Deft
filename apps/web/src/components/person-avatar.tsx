'use client';

import type { CSSProperties } from 'react';
import { Bot } from 'lucide-react';

type PersonAvatarProps = {
  name?: string | null;
  avatarUrl?: string | null;
  kind?: string | null;
  size?: number;
  fontSize?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
};

function avatarColor(name: string) {
  const colors = ['#7C6B4F', '#5B7A6B', '#6B5D7A', '#7A5B5B', '#5B6B7A', '#7A6B5B'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function PersonAvatar({
  name,
  avatarUrl,
  kind,
  size = 32,
  fontSize,
  className = '',
  style,
  title,
}: PersonAvatarProps) {
  const label = name?.trim() || 'User';
  const isAgent = kind === 'agent' || kind === 'system';
  const mergedStyle: CSSProperties = {
    width: size,
    height: size,
    fontSize: fontSize ?? Math.max(9, Math.round(size * 0.38)),
    ...style,
  };

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={label}
        title={title ?? label}
        className={`rounded-full object-cover flex-shrink-0 ${className}`}
        style={mergedStyle}
      />
    );
  }

  return (
    <div
      title={title ?? label}
      className={`rounded-full flex items-center justify-center font-medium text-white flex-shrink-0 ${className}`}
      style={{
        background: isAgent ? '#6366f1' : avatarColor(label),
        ...mergedStyle,
      }}
    >
      {isAgent ? <Bot size={Math.max(12, Math.round(size * 0.5))} strokeWidth={1.7} /> : label.charAt(0).toUpperCase()}
    </div>
  );
}
