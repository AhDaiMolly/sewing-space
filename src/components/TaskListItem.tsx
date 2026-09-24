// src/components/TaskListItem.tsx —— 列表视图行（含内嵌 Step 勾选）
// UI 基线：docs/demo/src/components/TaskListItem.jsx
// 落实 PRD §8.10 缺陷表 #2/#3/#4/#6/#7/#10：
//   #2 真实当前日期 → done 检测
//   #3 YYYY.MM.DD 显示
//   #4 统一「高/中/低」
//   #6 行内勾选容器 stopPropagation
//   #7 completedAt 清除走 setTaskStatus（不在本组件做回退）
//   #10 标签 chips 最多 2 + 「+N」
// 「开始任务后才能勾选步骤」提示 → toast('开始任务后才能勾选步骤')
// 勾选区 onClick 必须 e.stopPropagation()

import React from 'react';
import type { Task } from '@/db/types';
import { isOverdue, fmtDisplayDate, todayIsoDate } from '@/lib/date';
import { toast } from '@/store/toastStore';
import { IconDress, IconTag } from './Icons';

interface TaskListItemProps {
  task: Task;
  /** 行点击（除勾选区外），用于打开编辑表单 */
  onClick?: () => void;
  /** 勾选 / 取消勾选某步骤。task.status === 'todo' 时由调用方拦截。 */
  onToggleStep?: (taskId: string, stepId: string, done: boolean) => void;
}

const PRIORITY_LABELS: Record<Task['priority'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export default function TaskListItem({ task, onClick, onToggleStep }: TaskListItemProps) {
  const today = todayIsoDate();
  const overdue = isOverdue(task, today);

  const total = task.steps.length;
  const done = task.steps.filter((s) => s.done).length;
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;

  const isTodo = task.status === 'todo';
  const visibleTags = task.tags.slice(0, 2);
  const extraTagCount = task.tags.length - 2;

  // 行点击：整行可点击，勾选区必须 stopPropagation
  const handleRowClick = () => {
    onClick?.();
  };

  // 步骤勾选：todo 时拦截 + 提示；否则交给父级服务
  const handleStepClick = (
    e: React.MouseEvent,
    stepId: string,
    stepDone: boolean,
  ) => {
    e.stopPropagation();
    if (isTodo) {
      toast('开始任务后才能勾选步骤');
      return;
    }
    onToggleStep?.(task.id, stepId, !stepDone);
  };

  // 勾选区容器：阻止冒泡，避免点空白也触发行点击
  const handleStepsContainerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div className="task-list-item" onClick={handleRowClick}>
      {/* 头部：标题 + 优先级 */}
      <div className="task-list-header">
        <div className="task-list-title" title={task.title}>{task.title}</div>
        <span className={`badge badge-priority-${task.priority}`}>
          {PRIORITY_LABELS[task.priority]}
        </span>
      </div>

      {/* Meta：截止 + 关联成衣 */}
      <div className="task-list-meta">
        {task.dueDate && (
          <span className={`task-due ${overdue ? 'overdue' : ''}`}>
            {fmtDisplayDate(task.dueDate)}
            {overdue && ' · 逾期'}
          </span>
        )}
        {task.garmentName && (
          <span className="task-garment-link">
            <IconDress style={{ width: '12px', height: '12px', color: 'var(--accent)' }} />
            <span>{task.garmentName}</span>
          </span>
        )}
      </div>

      {/* 行内步骤勾选（PRD §8.10：勾选区 stopPropagation） */}
      {total > 0 && (
        <div
          className={`task-steps-inline ${isTodo ? 'disabled' : ''}`}
          onClick={handleStepsContainerClick}
        >
          {task.steps.map((step) => (
            <div
              key={step.id}
              className={`step-inline-item ${step.done ? 'done' : ''} ${isTodo ? 'is-disabled' : ''}`}
              onClick={(e) => handleStepClick(e, step.id, step.done)}
            >
              <div className={`step-inline-checkbox ${step.done ? 'checked' : ''}`}>
                {step.done && '✓'}
              </div>
              <span className="step-inline-title">{step.title}</span>
            </div>
          ))}
        </div>
      )}

      {/* 进度条 + 标签 */}
      <div className="task-list-footer">
        {total > 0 && (
          <div className="task-progress-mini">
            <div className="progress-bar-mini">
              <div className="progress-fill-mini" style={{ width: `${pct}%` }} />
            </div>
            <span className="progress-text-mini">{done}/{total}</span>
          </div>
        )}
        {task.tags.length > 0 && (
          <div className="task-tags-mini">
            {visibleTags.map((tag, i) => (
              <span key={i} className="task-tag-mini">
                <IconTag style={{ width: '10px', height: '10px' }} />
                {tag}
              </span>
            ))}
            {extraTagCount > 0 && (
              <span className="task-tag-mini tag-more">+{extraTagCount}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}