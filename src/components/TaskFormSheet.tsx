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
// 任务与成衣联动 UI（W-C 新增任务1 / 新增任务2 口径，2026-09-29）：
//   - 关联成衣手工选择控件已移除——任务↔成衣关联的唯一通道是新建时勾选
//     「生成成衣」（建成衣 status='planning'，任务开始时由服务层联动扣库存）。
//     FormState.garmentId / garmentName 字段与编辑透传保留，既有任务的关联
//     数据不删不改（读侧展示不受影响）。
//   - 删除任务：关联成衣 planning → 随任务一并删除（服务层级联）；制作中 /
//     已完成 → 保留在成衣库（确认文案按状态区分）。

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
import PatternPickerPage from '@/pages/pickers/PatternPickerPage';
import { toast } from '@/store/toastStore';
import type {
  Material,
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
  patternId: string; // V-C 工作台Q2：关联纸样（弱引用，'' = 未关联）
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
    patternId: task?.patternId ?? '',
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
  // W-C 新增任务1：关联成衣选择器已移除，不再拉全表；仅定向查绑定成衣
  //（编辑态删除确认文案需按成衣状态区分级联 / 保留口径）。
  const boundGarment = useLiveQuery(
    () => db.garments.get(task?.garmentId ?? ''),
    [task?.garmentId],
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

  // V-C 工作台Q1：新增/编辑任务表单去掉标签与备注录入（2026-09-28 用户验收
  // 口径）。FormState.notes / tags 字段保留——编辑提交仍透传既有数据，历史
  // 任务的备注 / 标签不删不改（DoneTaskDetail 展示不受影响）。

  // ── 删除确认（应用内确认框，层级高于遮罩）──
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // ── 纸样选择器浮层（V-C 工作台Q2）──
  const [showPatternPicker, setShowPatternPicker] = useState(false);
  const patterns = useLiveQuery(
    () => db.materials.where('type').equals('pattern').toArray().then((arr) => arr ?? []),
    [],
  );
  const candidatePatterns = patterns ?? [];
  const selectedPattern = form.patternId
    ? candidatePatterns.find((pt) => pt.id === form.patternId)
    : undefined;

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
          // AH-A Q3：不再提交 dueDate（patch 不含键 → 存量值保留）
          tags: form.tags,
          steps: form.steps.map((s) => ({
            id: s.id,
            title: s.title,
            done: s.done,
            completedAt: s.completedAt,
          })),
          garmentId: form.garmentId,
          notes: form.notes,
          patternId: form.patternId, // V-C 工作台Q2（'' = 清除关联）
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
              status: 'planning', // W-C 新增任务2：任务待办 → 成衣规划中（未扣库存），任务开始时联动扣减
              category: '',
              size: '',
              recipient: '',
              patternId: form.patternId, // 【AB-A 需求 3】任务勾选生成成衣时带上所选纸样，
              // 服务层据此自动反写纸样 linkedGarmentIds（此前硬编码 '' 导致关联丢失）
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
          // AH-A Q3：不再提交 dueDate（新建任务不再有截止日期）
          tags: form.tags,
          notes: form.notes,
          steps: form.steps.map((s) => ({
            title: s.title,
            done: false, // 新建步骤一律未勾选
          })),
          garmentId: garmentId || undefined,
          templateId: form.templateId || undefined,
          patternId: form.patternId || undefined, // V-C 工作台Q2
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
  const loading = templates === undefined;
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
              {/* 模板选择器（仅新增任务时显示，demo 行 1248）。
                  W-C 设置4：零模板时不再整行消失——保留行渲染 + 空态提示
                  （模板全部由用户在「设置 → 任务模板」自建），避免用户误以为
                  功能不存在。 */}
              {!isEdit && (
                <div className="input-row">
                  <label className="input-label">从模板加载</label>
                  {(templates ?? []).length > 0 ? (
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
                  ) : (
                    <div
                      style={{
                        padding: '10px 14px',
                        fontSize: '13px',
                        color: 'var(--secondary-foreground)',
                        background: 'var(--card)',
                        borderRadius: '12px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      暂无模板——可在「设置 → 任务模板」中自建模板，步骤也可直接在下方手动输入
                    </div>
                  )}
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

              {/* 截止日期 —— AH-A Q3：录入 UI 移除（数据层字段与历史任务存量值保留，
                  编辑提交不带 dueDate 键 → 存量值原样保留，不再展示） */}

              {/* V-C 工作台Q1：备注录入已按 2026-09-28 验收口径移除（字段与既有数据保留） */}

              {/* V-C 工作台Q1：标签录入已按 2026-09-28 验收口径移除（字段与既有数据保留） */}

              {/* 关联纸样（V-C 工作台Q2，demo 形态「+ 去选择纸样」） */}
              <div className="input-row">
                <label className="input-label">关联纸样（非必填）</label>
                {form.patternId && selectedPattern ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ flex: 1, minWidth: 0, padding: '10px 14px', background: 'var(--card)', borderRadius: '12px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '14px', fontWeight: 500 }}>
                        {selectedPattern.name}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--secondary-foreground)' }}>
                        {selectedPattern.category || '纸样'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: '6px 12px', fontSize: '12px', flexShrink: 0 }}
                      onClick={() => setShowPatternPicker(true)}
                    >
                      更换
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: '6px 12px', fontSize: '12px', flexShrink: 0, color: 'var(--destructive)' }}
                      onClick={() => updateField('patternId', '')}
                    >
                      清除
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ width: '100%', padding: '12px 14px', justifyContent: 'flex-start', gap: '6px' }}
                    onClick={() => setShowPatternPicker(true)}
                  >
                    + 去选择纸样
                  </button>
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

      {/* 纸样选择器浮层（V-C 工作台Q2，复用 GarmentForm 同款 overlay） */}
      {/* AG-A Q6：浮层外加 stopPropagation 守卫（对齐 GarmentForm S3-FIX-C R1），
          避免选择纸样卡片时点击冒泡到 form-overlay 的 onClose 导致整个新建任务表单被关闭、任务丢失 */}
      {showPatternPicker && (
        <div onClick={(e) => e.stopPropagation()}>
          <PatternPickerPage
            initialSelectedId={form.patternId || undefined}
            onClose={() => setShowPatternPicker(false)}
            onSelect={(pattern: Material) => {
              updateField('patternId', pattern.id);
              setShowPatternPicker(false);
            }}
          />
        </div>
      )}

      {/* 删除二次确认（应用内居中确认框，层级高于遮罩，demo 的 window.confirm 缺陷被剔除） */}
      {/* AG-A 同类修复：confirm-overlay 根节点补 stopPropagation，避免点确认框遮罩时冒泡到
          form-overlay 的 onClose 连坐关闭整个任务表单（与 Q6 同类冒泡缺陷） */}
      {showDeleteConfirm && task && (
        <div
          className="confirm-overlay"
          onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(false); }}
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
                  」
                  {boundGarment === undefined
                    ? '将按当前状态处理'
                    : boundGarment.status === 'planning'
                      ? '尚在规划中，将随任务一并删除'
                      : '将保留在成衣库'}
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