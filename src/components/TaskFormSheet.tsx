// src/components/TaskFormSheet.tsx —— 任务新建/编辑表单浮层
// UI 基线：docs/demo/src/App.jsx:1133-1529（弹层结构与类名逐字保留）
//
// S2/S3 教训硬性落实：
//   - useLiveQuery 三态：undefined=未解析(loading)，null=确认不存在
//   - 浮层容器 stopPropagation 守卫
//   - 不静默封顶/改写输入
//   - 搜索 trim
//   - 保存后显式 navigate('/workbench') 而非 navigate(-1)
//
// 任务与成衣联动 UI：
//   - 任务表单内可选取/更换/解除关联成衣（候选为未删除成衣）
//   - 删除任务不级联删成衣（UI 不出现此类提示或动作）

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { nanoid } from 'nanoid';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import {
  createTask,
  updateTask,
  deleteTask,
  setTaskStatus,
} from '@/services/taskService';
import { createGarmentWithMaterials } from '@/services/garmentService';
import { toast } from '@/store/toastStore';
import type {
  Task,
  TaskPriority,
  TaskStep,
} from '@/db/types';

// ============================ Props ============================
export interface TaskFormSheetProps {
  /** 编辑时传入已有任务；新建传 null。 */
  task: Task | null;
  /** 父级关闭回调。 */
  onClose: () => void;
}

// ============================ 常量 ============================
const PRIORITY_OPTIONS: { key: TaskPriority; label: string }[] = [
  { key: 'high', label: '高' },
  { key: 'medium', label: '中' },
  { key: 'low', label: '低' },
];

interface FormState {
  title: string;
  priority: TaskPriority;
  dueDate: string;
  notes: string;
  tags: string[];
  steps: TaskStep[];
  garmentId: string;
  garmentName: string;
  templateId: string;
  autoCreateGarment: boolean;
}

function buildInitialForm(task: Task | null): FormState {
  return {
    title: task?.title ?? '',
    priority: task?.priority ?? 'medium',
    dueDate: task?.dueDate ?? '',
    notes: task?.notes ?? '',
    tags: task?.tags ?? [],
    steps: task?.steps ?? [],
    garmentId: task?.garmentId ?? '',
    garmentName: task?.garmentName ?? '',
    templateId: task?.templateId ?? '',
    autoCreateGarment: task ? false : true,
  };
}

// ============================ 组件 ============================
export default function TaskFormSheet({ task, onClose }: TaskFormSheetProps) {
  const navigate = useNavigate();
  const isEdit = task !== null;

  // ── 实时数据 ──
  const templates = useLiveQuery(
    () => db.taskTemplates.toArray().then((arr) => arr ?? []),
    [],
  );
  const garments = useLiveQuery(
    () => db.garments.toArray().then((arr) => arr ?? []),
    [],
  );

  // ── 表单状态（编辑态：useLiveQuery 异步返回后重同步）──
  const [form, setForm] = useState<FormState>(() => buildInitialForm(task));
  const [formSynced, setFormSynced] = useState(false);

  // 编辑态：task 对象异步到达后重同步表单（S2 P0-1 教训）
  useEffect(() => {
    if (isEdit) {
      setForm(buildInitialForm(task));
      setFormSynced(true);
    }
  }, [isEdit, task]);

  // ── 新步骤输入 ──
  const [newStepTitle, setNewStepTitle] = useState('');

  // ── 标签输入 ──
  const [newTag, setNewTag] = useState('');

  const addTag = () => {
    const tag = newTag.trim();
    if (!tag) return;
    if (tag.length > 20) { toast('标签最多 20 个字', 'error'); return; }
    if (form.tags.includes(tag)) { toast('标签已存在', 'error'); return; }
    if (form.tags.length >= 10) { toast('标签最多 10 个', 'error'); return; }
    setForm((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
    setNewTag('');
  };

  const removeTag = (tag: string) => {
    setForm((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }));
  };

  // ── 删除确认（应用内确认框，层级高于遮罩）──
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // ── 成衣选择器浮层 ──
  const [showGarmentPicker, setShowGarmentPicker] = useState(false);

  // ── 辅助函数 ──
  const updateField = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleStep = (stepId: string) => {
    // 待办状态下不允许勾选步骤（demo 行 1161）
    if (task?.status === 'todo') {
      toast('开始任务后才能勾选步骤');
      return;
    }
    setForm((prev) => ({
      ...prev,
      steps: prev.steps.map((s) =>
        s.id === stepId ? { ...s, done: !s.done } : s,
      ),
    }));
  };

  const addStep = () => {
    const title = newStepTitle.trim();
    if (!title) return;
    const newStep: TaskStep = {
      id: nanoid(8),
      title,
      done: false,
      order: form.steps.length,
    };
    setForm((prev) => ({ ...prev, steps: [...prev.steps, newStep] }));
    setNewStepTitle('');
  };

  const deleteStepLocal = (stepId: string) => {
    setForm((prev) => ({
      ...prev,
      steps: prev.steps
        .filter((s) => s.id !== stepId)
        .map((s, i) => ({ ...s, order: i })),
    }));
  };

  const moveStep = (stepId: string, direction: number) => {
    setForm((prev) => {
      const idx = prev.steps.findIndex((s) => s.id === stepId);
      if (idx === -1) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.steps.length) return prev;
      const newSteps = [...prev.steps];
      const [moved] = newSteps.splice(idx, 1);
      if (!moved) return prev;
      newSteps.splice(newIdx, 0, moved);
      return {
        ...prev,
        steps: newSteps.map((s, i) => ({ ...s, order: i })),
      };
    });
  };

  // ── 成衣选取辅助 ──
  const candidateGarments = garments ?? [];

  const selectedGarment = form.garmentId
    ? (garments ?? []).find((g) => g.id === form.garmentId)
    : null;

  // ── 提交 ──
  const handleSubmit = async () => {
    if (!form.title.trim()) {
      toast('标题不能为空', 'error');
      return;
    }

    // 根据步骤完成状态自动推导任务状态
    const allStepsDone =
      form.steps.length > 0 && form.steps.every((s) => s.done);
    const hasStepsDone = form.steps.some((s) => s.done);
    const currentStatus = task?.status ?? 'todo';
    let computedStatus = currentStatus;
    if (allStepsDone && computedStatus !== 'done') computedStatus = 'done';
    else if (hasStepsDone && computedStatus === 'todo')
      computedStatus = 'in_progress';

    try {
      if (isEdit && task) {
        // 编辑：用服务层 updateTask
        await updateTask(task.id, {
          title: form.title.trim(),
          priority: form.priority,
          dueDate: form.dueDate,
          tags: form.tags,
          steps: form.steps.map((s) => ({
            id: s.id,
            title: s.title,
            done: s.done,
            completedAt: s.completedAt,
          })),
          garmentId: form.garmentId,
          notes: form.notes,
        });
        // 状态变更走 setTaskStatus（toggleTaskStep 已含正向派生）
        if (computedStatus !== currentStatus) {
          await setTaskStatus(task.id, computedStatus);
        }
        toast('任务已保存');
      } else {
        // 新建：autoCreateGarment 由服务层 createTask 不支持，这里在 UI 层处理
        // 当前服务层 createTask 已支持 garmentId 绑定，autoCreateGarment 是 UI 概念
        // 若勾选「生成成衣」且未关联已有成衣，先建成衣再建任务
        let garmentId = form.garmentId;
        let didAutoCreateGarment = false;

        if (form.autoCreateGarment && !form.garmentId) {
          // 走 garmentService 创建入口（事务、nanoid(12) id、markDirty 齐全）
          const newGarmentId = await createGarmentWithMaterials({
            data: {
              name: form.title.trim() || '新成衣',
              status: 'in_progress',
              category: '',
              size: '',
              recipient: '',
              patternId: '',
              images: [],
              completionDate: '',
              startDate: '',
              plannedDate: '',
              forWhom: '',
              tags: [],
              notes: '',
              sourceRef: undefined,
              totalCost: null,
            },
            selections: [],
          });
          garmentId = newGarmentId;
          didAutoCreateGarment = true;
        }

        await createTask({
          title: form.title.trim(),
          priority: form.priority,
          dueDate: form.dueDate || undefined,
          tags: form.tags,
          notes: form.notes,
          steps: form.steps.map((s) => ({
            title: s.title,
            done: false, // 新建步骤一律未勾选
          })),
          garmentId: garmentId || undefined,
          templateId: form.templateId || undefined,
        });
        toast(didAutoCreateGarment ? '已创建任务与成衣' : '任务已创建');
      }

      onClose();
      navigate('/workbench'); // 保存后显式 navigate 而非 navigate(-1)（S2 P2-4 模式）
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
    }
  };

  // ── 删除 ──
  const handleDelete = async () => {
    if (!task) return;
    try {
      await deleteTask(task.id);
      toast('任务已删除');
      onClose();
      navigate('/workbench');
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error');
      setShowDeleteConfirm(false);
    }
  };

  // ── 模板加载 ──
  const handleTemplateSelect = (tplId: string) => {
    if (!tplId) {
      updateField('templateId', '');
      updateField('steps', []);
      return;
    }
    const tpl = (templates ?? []).find((t) => t.id === tplId);
    if (tpl) {
      const newSteps: TaskStep[] = tpl.steps.map((s, i) => ({
        id: 'step_' + Date.now().toString(36) + '_' + i,
        title: s.title,
        done: false,
        order: i + 1, // PRD §8.10: order 从 1 起重排
      }));
      setForm((prev) => ({
        ...prev,
        templateId: tplId,
        steps: newSteps,
      }));
      toast(`已加载「${tpl.name}」模板`);
    }
  };

  // ── 加载态 ──
  const loading = templates === undefined || garments === undefined;
  // 编辑态且表单尚未与最新 task 同步完成
  const editNotReady = isEdit && !formSynced;

  // ======================== 渲染 ========================
  return (
    <div className="form-overlay" onClick={onClose}>
      <div className="form-sheet" onClick={(e) => e.stopPropagation()}>
        {/* ── 头部 ── */}
        <div className="form-header">
          <button className="cancel" onClick={onClose}>
            取消
          </button>
          <span className="title">{isEdit ? '编辑任务' : '新增任务'}</span>
          <div style={{ width: '32px' }} />
        </div>

        {/* ── 表单体 ── */}
        <div className="form-body">
          {(loading || editNotReady) ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--secondary-foreground)' }}>
              加载中…
            </div>
          ) : (
            <>
              {/* 模板选择器（仅新增任务时显示，demo 行 1248） */}
              {!isEdit && (templates ?? []).length > 0 && (
                <div className="input-row">
                  <label className="input-label">从模板加载</label>
                  <select
                    className="input-field"
                    value={form.templateId || ''}
                    onChange={(e) => handleTemplateSelect(e.target.value)}
                  >
                    <option value="">不使用模板</option>
                    {(templates ?? []).map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}（{tpl.steps?.length || 0} 步）
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* 标题 */}
              <div className="input-row">
                <label className="input-label">标题 *</label>
                <input
                  className="input-field"
                  placeholder="输入任务标题"
                  value={form.title}
                  onChange={(e) => updateField('title', e.target.value)}
                />
              </div>

              {/* 优先级 */}
              <div className="input-row">
                <label className="input-label">优先级</label>
                <div className="chips-container">
                  {PRIORITY_OPTIONS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={`chip ${form.priority === p.key ? 'selected' : ''}`}
                      onClick={() => updateField('priority', p.key)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 截止日期 */}
              <div className="input-row">
                <label className="input-label">截止日期</label>
                <input
                  className="input-field"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => updateField('dueDate', e.target.value)}
                />
              </div>

              {/* 备注（PRD §8.11 缺陷 #1） */}
              <div className="input-row">
                <label className="input-label">备注</label>
                <input
                  className="input-field"
                  placeholder="如：记得买拉链"
                  value={form.notes}
                  onChange={(e) => updateField('notes', e.target.value)}
                />
              </div>

              {/* 标签（PRD §8.11 缺陷 #2） */}
              <div className="input-row">
                <label className="input-label">标签（{form.tags.length}/10）</label>
                <div className="chips-container">
                  {form.tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="chip selected"
                      onClick={() => removeTag(tag)}
                      title="点击移除"
                    >
                      {tag} ✕
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <input
                    className="input-field"
                    style={{ flex: 1 }}
                    placeholder="输入标签，回车添加（1–20 字）"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    maxLength={20}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '0 14px', flexShrink: 0 }}
                    onClick={addTag}
                  >
                    添加
                  </button>
                </div>
              </div>

              {/* 关联成衣（任务与成衣联动 UI） */}
              <div className="input-row">
                <label className="input-label">关联成衣（非必填）</label>
                {form.garmentId && selectedGarment ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '10px 14px',
                      background: 'var(--card)',
                      borderRadius: '12px',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 500 }}>
                        {selectedGarment.name}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--secondary-foreground)' }}>
                        {selectedGarment.status === 'planning'
                          ? '规划中'
                          : selectedGarment.status === 'in_progress'
                            ? '制作中'
                            : '已完成'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ padding: '6px 12px', fontSize: '12px' }}
                        onClick={() => setShowGarmentPicker(true)}
                      >
                        更换
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ padding: '6px 12px', fontSize: '12px', color: 'var(--destructive)' }}
                        onClick={() => {
                          updateField('garmentId', '');
                          updateField('garmentName', '');
                        }}
                      >
                        解除
                      </button>
                    </div>
                  </div>
                ) : (
                  <select
                    className="input-field"
                    value={form.garmentId}
                    onChange={(e) => {
                      const gid = e.target.value;
                      if (!gid) {
                        updateField('garmentId', '');
                        updateField('garmentName', '');
                        return;
                      }
                      const g = candidateGarments.find((x) => x.id === gid);
                      if (g) {
                        updateField('garmentId', g.id);
                        updateField('garmentName', g.name);
                      }
                    }}
                  >
                    <option value="">不关联成衣</option>
                    {candidateGarments.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                        {g.status === 'planning'
                          ? ' · 规划中'
                          : g.status === 'in_progress'
                            ? ' · 制作中'
                            : ' · 已完成'}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* 生成成衣勾选（仅新建时显示，demo 行 1303） */}
              {!isEdit && (
                <div
                  className="input-row"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: '10px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={form.autoCreateGarment}
                    onChange={(e) =>
                      updateField('autoCreateGarment', e.target.checked)
                    }
                    style={{
                      width: '18px',
                      height: '18px',
                      accentColor: 'var(--primary)',
                    }}
                  />
                  <span
                    style={{
                      fontSize: '14px',
                      color: 'var(--foreground)',
                    }}
                  >
                    生成成衣（默认以任务名称命名）
                  </span>
                </div>
              )}

              {/* 步骤（demo 行 1310-1390） */}
              <div className="input-row">
                <label className="input-label">步骤</label>
                <div
                  style={{
                    background: 'var(--card)',
                    borderRadius: '12px',
                    border: '1px solid var(--border)',
                    overflow: 'hidden',
                  }}
                >
                  {form.steps.length === 0 && (
                    <div
                      style={{
                        padding: '16px',
                        textAlign: 'center',
                        fontSize: '12px',
                        color: 'var(--secondary-foreground)',
                      }}
                    >
                      还没有步骤，在下方输入添加第一步
                    </div>
                  )}
                  {form.steps.map((step, idx) => (
                    <div
                      key={step.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '10px 14px',
                        borderBottom:
                          idx < form.steps.length - 1
                            ? '1px solid var(--border)'
                            : 'none',
                        fontSize: '13px',
                        textDecoration: step.done ? 'line-through' : 'none',
                        color: step.done
                          ? 'var(--secondary-foreground)'
                          : 'var(--foreground)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={step.done}
                        onChange={() => toggleStep(step.id)}
                        disabled={task?.status === 'todo'}
                        style={{
                          width: '18px',
                          height: '18px',
                          accentColor: 'var(--primary)',
                          flexShrink: 0,
                          cursor:
                            task?.status === 'todo' ? 'not-allowed' : 'pointer',
                        }}
                      />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          opacity: task?.status === 'todo' ? 0.7 : 1,
                        }}
                      >
                        {step.title}
                      </span>
                      <div
                        style={{ display: 'flex', gap: '4px', flexShrink: 0 }}
                      >
                        <button
                          type="button"
                          onClick={() => moveStep(step.id, -1)}
                          style={{
                            width: '24px',
                            height: '24px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '12px',
                            color: 'var(--secondary-foreground)',
                            borderRadius: '4px',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                          disabled={idx === 0}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => moveStep(step.id, 1)}
                          style={{
                            width: '24px',
                            height: '24px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '12px',
                            color: 'var(--secondary-foreground)',
                            borderRadius: '4px',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                          disabled={idx === form.steps.length - 1}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteStepLocal(step.id)}
                          style={{
                            width: '24px',
                            height: '24px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '14px',
                            color: 'var(--destructive)',
                            borderRadius: '4px',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 添加步骤输入框 */}
                <div
                  style={{ display: 'flex', gap: '8px', marginTop: '8px' }}
                >
                  <input
                    className="input-field"
                    style={{ flex: 1 }}
                    placeholder="输入步骤名称，回车添加"
                    value={newStepTitle}
                    onChange={(e) => setNewStepTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addStep();
                      }
                    }}
                  />
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '0 14px' }}
                    onClick={addStep}
                  >
                    添加
                  </button>
                </div>

                {form.steps.length > 0 && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: 'var(--secondary-foreground)',
                      marginTop: '6px',
                    }}
                  >
                    已添加 {form.steps.length} 个步骤
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── 底部 ── */}
        <div className="form-footer">
          {isEdit && task ? (
            <>
              <button
                className="btn btn-delete-form"
                onClick={() => setShowDeleteConfirm(true)}
              >
                删除
              </button>
              <div style={{ flex: 1, display: 'flex', gap: '8px' }}>
                <button className="btn btn-secondary" onClick={onClose}>
                  取消
                </button>
                <button className="btn btn-primary" onClick={handleSubmit}>
                  保存
                </button>
              </div>
            </>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={onClose}>
                取消
              </button>
              <button className="btn btn-primary" onClick={handleSubmit}>
                保存
              </button>
            </>
          )}
        </div>
      </div>

      {/* 成衣选择器浮层（取代 window.prompt，PRD §15.3/15.5） */}
      {showGarmentPicker && (
        <div
          className="confirm-overlay"
          onClick={() => setShowGarmentPicker(false)}
        >
          <div
            className="confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-title">选择成衣</div>
            <div style={{ marginBottom: '12px', maxHeight: '200px', overflowY: 'auto' }}>
              {candidateGarments.length === 0 ? (
                <div style={{ fontSize: '13px', color: 'var(--secondary-foreground)', textAlign: 'center', padding: '12px' }}>
                  暂无可选成衣
                </div>
              ) : (
                candidateGarments.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => {
                      updateField('garmentId', g.id);
                      updateField('garmentName', g.name);
                      setShowGarmentPicker(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      padding: '10px 14px',
                      border: 'none',
                      borderBottom: '1px solid var(--border)',
                      background: form.garmentId === g.id ? 'var(--card)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: '14px',
                      color: 'var(--foreground)',
                      textAlign: 'left',
                    }}
                  >
                    <span>{g.name}</span>
                    <span style={{ fontSize: '12px', color: 'var(--secondary-foreground)' }}>
                      {g.status === 'planning' ? '规划中' : g.status === 'in_progress' ? '制作中' : '已完成'}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="confirm-actions">
              <button
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => {
                  updateField('garmentId', '');
                  updateField('garmentName', '');
                  setShowGarmentPicker(false);
                }}
              >
                解除关联
              </button>
              <button
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => setShowGarmentPicker(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认（应用内居中确认框，层级高于遮罩，demo 的 window.confirm 缺陷被剔除） */}
      {showDeleteConfirm && task && (
        <div
          className="confirm-overlay"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-title">确认删除「{task.title}」？</div>
            <div
              style={{
                fontSize: '13px',
                color: 'var(--secondary-foreground)',
                marginBottom: '16px',
              }}
            >
              删除后任务不可恢复
              {task.garmentId && (
                <>
                  ；其关联的成衣「
                  {task.garmentName || '(未命名)'}
                  」将保留在成衣库
                </>
              )}
            </div>
            <div className="confirm-actions">
              <button
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => setShowDeleteConfirm(false)}
              >
                取消
              </button>
              <button
                className="btn btn-danger"
                style={{ flex: 1 }}
                onClick={handleDelete}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}