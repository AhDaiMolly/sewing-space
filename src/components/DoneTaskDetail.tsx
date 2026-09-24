// src/components/DoneTaskDetail.tsx —— 已完成任务只读详情浮层
// UI 基线：docs/demo/src/components/DoneTaskDetail.jsx
// 落实 PRD §8.12 + 缺陷表：
//   - 全字段只读，无任何编辑控件
//   - 删除按钮用「应用内居中确认浮层」，不使用浏览器原生 confirm
//   - 关联纸样 / 成衣：仅在对应字段非空 + 记录存在时渲染
//   - 完成时刻、优先级、标签：按字段是否为空渲染
// S2/S3 教训：
//   - useLiveQuery 「可判已结算」写法：undefined=未解析(null=不存在)
//   - 浮层容器 stopPropagation 守卫
//   - 删除确认浮层 z-index 高于主浮层

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { deleteTask } from '@/services/taskService';
import { fmtDisplayDate } from '@/lib/date';
import { toast } from '@/store/toastStore';
import { IconBack, IconTrash, IconTask } from './Icons';
import { UserIconNavGarments } from './UserIcons';
import type { TaskPriority, Task, Garment } from '@/db/types';

interface DoneTaskDetailProps {
  /** 任务 id。空字符串 = 未打开浮层，组件不渲染。 */
  taskId: string;
  /** 关闭浮层 */
  onClose: () => void;
}

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export default function DoneTaskDetail({ taskId, onClose }: DoneTaskDetailProps) {
  // S3-FIX-D：undefined=未解析（保持加载态），null=确认不存在
  const task = useLiveQuery<Task | null>(
    async () => {
      if (!taskId) return null;
      const t = await db.tasks.get(taskId);
      return t ?? null;
    },
    [taskId],
  );

  // 已确认不存在 → 关闭浮层并提示
  useEffect(() => {
    if (task === null && taskId) {
      toast('任务不存在或已被删除', 'error');
      onClose();
    }
  }, [task, taskId, onClose]);

  // 关联成衣：仅在 garmentId 非空时查询；使用「可判已结算」写法
  const linkedGarmentId = task && task.garmentId !== '' ? task.garmentId : '';
  const garment = useLiveQuery<Garment | null>(
    async () => {
      if (!linkedGarmentId) return null;
      const g = await db.garments.get(linkedGarmentId);
      return g ?? null;
    },
    [linkedGarmentId],
  );

  // 删除确认浮层显隐
  const [confirming, setConfirming] = useState(false);

  // 阻止遮罩冒泡，避免误触发外层
  const stopProp = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
  };

  // 加载中：undefined（taskId 非空 + 还在查询）
  if (taskId && task === undefined) return null;
  // 任务不存在：已 effect 触发关闭，这里短路
  if (!task) return null;
  // 只对已完成任务展示（防御性：当前页面只可能传已完成任务过来）
  if (task.status !== 'done') return null;

  const doneSteps = task.steps.filter((s) => s.done).length;
  const totalSteps = task.steps.length;

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(true);
  };

  const handleConfirmDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteTask(task.id);
      toast('任务已删除');
      setConfirming(false);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(false);
  };

  const handleBackdropClick = () => {
    // 仅点击遮罩时关闭，确认浮层开启时不响应
    if (!confirming) onClose();
  };

  return (
    <div className="overlay-backdrop" onClick={handleBackdropClick}>
      <div
        className="page done-task-detail"
        onClick={stopProp}
        role="dialog"
        aria-label="任务详情"
      >
        <div className="page-header">
          <div className="left-actions">
            <button className="icon-btn" onClick={onClose} aria-label="返回">
              <IconBack style={{ width: '20px', height: '20px' }} />
            </button>
          </div>
          <h1 className="title">任务详情</h1>
          <div className="right-actions" />
        </div>

        <div className="page-content">
          {/* 标题 + 状态 */}
          <div className="done-task-header">
            <div className="done-task-title">{task.title}</div>
            <span className="done-task-status-badge">
              <IconTask style={{ width: '12px', height: '12px', marginRight: '3px' }} />
              已完成
            </span>
          </div>

          {/* 基础信息（优先级恒显示，其他字段按是否为空） */}
          <div className="detail-section">
            <div className="detail-section-title">基本信息</div>
            <div className="detail-info-list">
              <div className="detail-info-item">
                <span className="key">优先级</span>
                <span>{PRIORITY_LABELS[task.priority]}</span>
              </div>
              {task.dueDate && (
                <div className="detail-info-item">
                  <span className="key">截止日期</span>
                  <span>{fmtDisplayDate(task.dueDate)}</span>
                </div>
              )}
              {task.completedAt && (
                <div className="detail-info-item">
                  <span className="key">完成时间</span>
                  <span>{fmtDisplayDate(task.completedAt.slice(0, 10))}</span>
                </div>
              )}
              {task.tags.length > 0 && (
                <div className="detail-info-item">
                  <span className="key">标签</span>
                  <span style={{ textAlign: 'right', maxWidth: '60%', fontSize: '13px' }}>
                    {task.tags.join('、')}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* 关联成衣：仅 garmentId 非空 + garment 存在 */}
          {task.garmentId && garment && (
            <div className="detail-section">
              <div className="detail-section-title">关联成衣</div>
              <div className="linked-material-item">
                <div className="linked-material-icon">
                  <UserIconNavGarments style={{ width: '20px', height: '20px' }} />
                </div>
                <div className="linked-material-info">
                  <div className="linked-material-name">{garment.name}</div>
                  <div className="linked-material-qty">已完成 · 成衣库保留</div>
                </div>
                <span className="linked-material-arrow">›</span>
              </div>
            </div>
          )}

          {/* 步骤：仅 steps.length > 0 */}
          {task.steps.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-title">
                步骤
                <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--secondary-foreground)', fontWeight: 'normal' }}>
                  {doneSteps}/{totalSteps}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {task.steps.map((step) => (
                  <div
                    key={step.id}
                    className={`done-step-item ${step.done ? 'done' : ''}`}
                  >
                    <span className="done-step-check">{step.done ? '✓' : ''}</span>
                    <span className="done-step-title">{step.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 备注：仅 notes 非空 */}
          {task.notes && (
            <div className="detail-section">
              <div className="detail-section-title">备注</div>
              <div style={{ fontSize: '13px', color: 'var(--foreground)', lineHeight: 1.6 }}>
                {task.notes}
              </div>
            </div>
          )}

          {/* 底部删除按钮 */}
          <div style={{ padding: '16px 0 24px' }}>
            <button className="btn btn-delete-full" onClick={handleDeleteClick}>
              <IconTrash style={{ width: '16px', height: '16px', marginRight: '6px' }} />
              删除任务
            </button>
          </div>
        </div>

        {/* 应用内删除确认浮层（z-index 高于本页主浮层） */}
        {confirming && (
          <div
            className="confirm-overlay"
            onClick={handleCancelDelete}
            role="presentation"
          >
            <div
              className="confirm-sheet"
              onClick={stopProp}
              role="alertdialog"
              aria-label="确认删除"
            >
              <div className="confirm-title">确认删除「{task.title}」？</div>
              <div style={{ fontSize: '13px', color: 'var(--secondary-foreground)', marginBottom: '20px' }}>
                删除后任务不可恢复
                {task.garmentId && garment && (
                  <>；其生成的成衣「{garment.name}」将保留在成衣库</>
                )}
                。
              </div>
              <div className="confirm-actions">
                <button
                  className="btn btn-secondary"
                  onClick={handleCancelDelete}
                >
                  取消
                </button>
                <button
                  className="btn btn-danger"
                  onClick={handleConfirmDelete}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// （类型 Task / Garment 已从 @/db/types 顶部导入）