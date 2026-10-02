// src/components/TaskCard.tsx —— 看板视图任务卡
// UI 基线：docs/demo/src/components/TaskCard.jsx
// 落实 PRD §8.10 缺陷表 #2/#3/#4/#6/#10：
//   #2 「今天」走 todayIsoDate()
//   #3 日期显示 YYYY.MM.DD
//   #4 优先级文案统一「高/中/低」（与列表行共享）
//   #6 开始任务按钮 onClick 内 e.stopPropagation()（如果上方挂 onClick）
//   #10 标签 chips 最多 2 个 + 「+N」


import type { Task } from '@/db/types';
import { isOverdue, fmtDisplayDate, todayIsoDate } from '@/lib/date';
import { IconDress } from './Icons';

interface TaskCardProps {
  task: Task;
  onClick?: () => void;
  /** 阻止卡片点击（如按钮已 stopPropagation） */
  onContentClick?: () => void;
}

const PRIORITY_LABELS: Record<Task['priority'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

function progressOf(t: Task): { done: number; total: number; pct: number } {
  const total = t.steps.length;
  const done = t.steps.filter((s) => s.done).length;
  // DM §7.3：步骤数为 0 时不强行 0%——按 0/0 + 100% 占位（任务无步骤也展示）
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  return { done, total, pct };
}

export default function TaskCard({ task, onClick }: TaskCardProps) {
  const today = todayIsoDate();
  const overdue = isOverdue(task, today);
  const { done, total, pct } = progressOf(task);

  // PRD §8.10 缺陷表 #10：标签 chips 最多 2 个，超出显示「+N」
  const visibleTags = task.tags.slice(0, 2);
  const extraTagCount = task.tags.length - 2;

  return (
    <div className="task-card" onClick={onClick}>
      <div className="task-title">{task.title}</div>
      <div className="task-meta">
        <span className={`badge badge-priority-${task.priority}`}>
          {PRIORITY_LABELS[task.priority]}
        </span>
        {task.dueDate && (
          <span className={`task-due ${overdue ? 'overdue' : ''}`}>
            {fmtDisplayDate(task.dueDate)}
            {overdue && ' · 逾期'}
          </span>
        )}
      </div>
      {task.garmentName && (
        <div className="task-garment">
          <IconDress style={{ width: '14px', height: '14px', color: 'var(--accent)' }} />
          <span>{task.garmentName}</span>
        </div>
      )}
      {total > 0 && (
        <div className="task-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="progress-text">
            {done}/{total} 步 · {pct}%
          </div>
        </div>
      )}
      {task.tags.length > 0 && (
        <div className="task-tags">
          {visibleTags.map((tag, i) => (
            <span key={i} className="task-tag">{tag}</span>
          ))}
          {extraTagCount > 0 && (
            <span className="task-tag tag-more">+{extraTagCount}</span>
          )}
        </div>
      )}
    </div>
  );
}