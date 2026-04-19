'use client';

import { useState, useEffect } from 'react';

const STATUS_COLORS: Record<string, string> = {
  backlog: '#6B7280',
  todo: '#3B82F6',
  in_progress: '#EAB308',
  in_review: '#A855F7',
  done: '#22C55E',
  cancelled: '#EF4444',
};

type TimelineTask = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  assignee_name: string | null;
};

export default function TaskTimeline({
  tasks,
  onTaskClick,
  projectPrefix,
}: {
  tasks: TimelineTask[];
  onTaskClick: (taskNumber: number) => void;
  projectPrefix: string;
}) {
  const [undatedExpanded, setUndatedExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const datedTasks = tasks.filter(t => t.due_date || t.start_date);
  const undatedTasks = tasks.filter(t => !t.due_date && !t.start_date);

  const today = new Date();
  const rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - 7);
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + 49);
  const totalDays = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24));

  const getPos = (date: string) => {
    const d = new Date(date);
    const offset = (d.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(0, Math.min(100, (offset / totalDays) * 100));
  };

  // Generate week markers
  const weeks: Date[] = [];
  const wd = new Date(rangeStart);
  wd.setDate(wd.getDate() - wd.getDay());
  while (wd <= rangeEnd) {
    weeks.push(new Date(wd));
    wd.setDate(wd.getDate() + 7);
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div style={{ minWidth: isMobile ? 500 : 900 }}>
        {/* Week headers */}
        <div className="relative h-7 mb-2">
          {weeks.map((w, i) => (
            <div key={i} className="absolute text-[10px]"
              style={{ left: `${getPos(w.toISOString())}%`, color: 'var(--muted)', borderLeft: '1px dashed var(--border)', paddingLeft: 4, height: 9999, opacity: 0.5, pointerEvents: 'none' }}>
              {w.toLocaleDateString('en', { month: 'short', day: 'numeric' })}
            </div>
          ))}
          {/* Today */}
          <div className="absolute top-0" style={{ left: `${getPos(today.toISOString())}%`, width: 2, height: 9999, background: 'var(--accent)', opacity: 0.6, zIndex: 5, pointerEvents: 'none' }} />
        </div>

        {/* Task rows */}
        {datedTasks.map(task => {
          const start = task.start_date ? getPos(task.start_date) : task.due_date ? getPos(task.due_date) - 0.5 : 0;
          const end = task.due_date ? getPos(task.due_date) : start + 0.5;
          const width = Math.max(3 / totalDays * 100, end - start);
          const color = STATUS_COLORS[task.status] || '#6B7280';

          return (
            <div key={task.id} className="relative h-7 flex items-center cursor-pointer group"
              onClick={() => onTaskClick(task.number)}>
              {!isMobile && (
                <div className="w-28 flex-shrink-0 text-[10px] truncate pr-2" style={{ color: 'var(--muted)' }}>
                  {projectPrefix}-{task.number}
                </div>
              )}
              <div className="flex-1 relative h-5">
                <div className="absolute h-full rounded-sm transition-all group-hover:opacity-100"
                  style={{ left: `${start}%`, width: `${width}%`, background: color, opacity: 0.7, minWidth: 4, overflow: 'visible' }}>
                  <span className="text-[9px] text-white px-1.5 block leading-5 font-medium whitespace-nowrap" style={{ overflow: 'visible' }}>
                    {task.title}
                  </span>
                </div>
              </div>
            </div>
          );
        })}

        {/* Undated */}
        {undatedTasks.length > 0 && (
          <div className="mt-6 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => setUndatedExpanded(!undatedExpanded)}
              className="flex items-center gap-2 text-[11px] font-medium mb-2 w-full text-left"
              style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
            >
              <span style={{ fontSize: '8px' }}>{undatedExpanded ? '▼' : '▶'}</span>
              No dates ({undatedTasks.length})
            </button>
            {undatedExpanded && (
              <div className={isMobile ? "flex flex-col gap-1" : "grid grid-cols-3 gap-1.5"}>
                {undatedTasks.map(task => (
                  <div key={task.id}
                    className="text-[11px] py-1 px-2 rounded cursor-pointer flex items-center gap-1.5"
                    onClick={() => onTaskClick(task.number)}
                    style={{ color: 'var(--foreground)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: STATUS_COLORS[task.status] || '#6B7280' }} />
                    <span style={{ color: 'var(--muted)' }}>{projectPrefix}-{task.number}</span>
                    <span className="truncate">{task.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
