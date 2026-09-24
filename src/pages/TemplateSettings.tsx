// src/pages/TemplateSettings.tsx —— 任务模板管理页（/settings/templates）
// UI 基线：docs/demo/src/pages/SettingsPage.jsx:380-492 + 1188-1422（弹层结构与类名逐字保留）
//
// 内置 3 个模板只读置灰展示（不可编辑/删除）；自建模板 CRUD 界面；
// 「复制为自建」入口；校验提示走 toast（名称 1–30、步骤 1–30，服务层已兜底）。
//
// S2/S3 教训硬性落实：
//   - useLiveQuery 三态：undefined=未解析(null=不存在)
//   - 浮层容器 stopPropagation 守卫
//   - 不静默封顶/改写输入
//   - 删除确认层级高于遮罩（应用内 confirm-backdrop/confirm-dialog，非 window.confirm）

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import {
  createTaskTemplate,
  updateTaskTemplate,
  deleteTaskTemplate,
  copyPresetTemplateAsCustom,
} from '@/services/taskService';
import { toast } from '@/store/toastStore';
import type { TaskTemplate, TaskTemplateStep } from '@/db/types';
import { IconBack, IconPlus, IconTrash, IconTask } from '@/components/Icons';

// ============================ 常量 ============================
const CATEGORY_OPTIONS = [
  '连衣裙',
  '上衣',
  '半裙',
  '裤子',
  '外套',
  '衬衫',
  '其他',
];

// ============================ 子组件：TemplateForm（新建/编辑浮层）============================

interface TemplateFormProps {
  template: TaskTemplate | null; // null = 新建
  onCancel: () => void;
  onSaved: () => void;
}

interface TemplateFormState {
  name: string;
  description: string;
  category: string;
  steps: (TaskTemplateStep & { id: string })[];
}

function TemplateForm({ template, onCancel, onSaved }: TemplateFormProps) {
  const isEdit = template !== null;
  // 模板步骤本地需 id（用于本地顺序调整），保存前会被服务层规整掉
  const [form, setForm] = useState<TemplateFormState>(() => ({
    name: template?.name ?? '',
    description: template?.description ?? '',
    category: template?.category ?? '',
    steps:
      template?.steps?.map((s, i) => ({
        id: 'local_' + i + '_' + Math.random().toString(36).slice(2, 6),
        title: s.title,
        order: i,
      })) ?? [],
  }));
  const [newStepTitle, setNewStepTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const updateField = <K extends keyof TemplateFormState>(
    key: K,
    value: TemplateFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const addStep = () => {
    const title = newStepTitle.trim();
    if (!title) return;
    const step = {
      id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      title,
      order: form.steps.length,
    };
    setForm((prev) => ({ ...prev, steps: [...prev.steps, step] }));
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

  const updateStepTitle = (stepId: string, title: string) => {
    setForm((prev) => ({
      ...prev,
      steps: prev.steps.map((s) =>
        s.id === stepId ? { ...s, title } : s,
      ),
    }));
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (!form.name.trim()) {
      toast('请输入模板名称', 'error');
      return;
    }
    if (form.steps.length === 0) {
      toast('至少添加一个步骤', 'error');
      return;
    }
    setSubmitting(true);
    try {
      // 编辑内置模板前置拦截
      if (isEdit && template?.source === 'preset') {
        toast('内置模板不可修改', 'error');
        setSubmitting(false);
        return;
      }

      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        category: form.category,
        steps: form.steps.map((s) => ({ title: s.title.trim() })),
      };

      if (isEdit && template) {
        await updateTaskTemplate(template.id, payload);
        toast('模板已更新');
      } else {
        await createTaskTemplate(payload);
        toast('模板已创建');
      }
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-overlay" onClick={onCancel}>
      <div
        className="form-sheet"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: '90vh' }}
      >
        {/* 头部 */}
        <div className="form-header">
          <button className="cancel" onClick={onCancel}>
            取消
          </button>
          <span className="title">{isEdit ? '编辑模板' : '新建模板'}</span>
          <button className="save" onClick={handleSubmit} disabled={submitting}>
            保存
          </button>
        </div>

        <div
          className="form-body"
          style={{ maxHeight: 'calc(90vh - 50px)', overflowY: 'auto' }}
        >
          <div className="input-row">
            <label className="input-label">模板名称 *</label>
            <input
              className="input-field"
              placeholder="例如：连衣裙标准流程"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              maxLength={30}
            />
          </div>

          <div className="input-row">
            <label className="input-label">描述</label>
            <textarea
              className="input-field"
              rows={2}
              placeholder="简要描述用途…"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              style={{ resize: 'none' }}
            />
          </div>

          <div className="input-row">
            <label className="input-label">分类</label>
            <div className="chips-container">
              {CATEGORY_OPTIONS.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`chip ${form.category === cat ? 'selected' : ''}`}
                  onClick={() => updateField('category', cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* 步骤编辑器 */}
          <div className="input-row">
            <label className="input-label">步骤（{form.steps.length}）</label>
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
                    padding: '20px',
                    textAlign: 'center',
                    color: 'var(--secondary-foreground)',
                    fontSize: '13px',
                  }}
                >
                  还没有步骤，在下方添加第一步吧
                </div>
              )}
              {form.steps.map((step, idx) => (
                <div
                  key={step.id}
                  className="step-editor-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '10px 12px',
                    borderBottom:
                      idx < form.steps.length - 1
                        ? '1px solid var(--border)'
                        : 'none',
                  }}
                >
                  <span
                    style={{
                      width: '20px',
                      fontSize: '12px',
                      fontWeight: 600,
                      color: 'var(--accent)',
                      textAlign: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <input
                    value={step.title}
                    onChange={(e) =>
                      updateStepTitle(step.id, e.target.value)
                    }
                    style={{
                      flex: 1,
                      border: 'none',
                      background: 'transparent',
                      fontSize: '14px',
                      color: 'var(--foreground)',
                      outline: 'none',
                      minWidth: 0,
                    }}
                  />
                  <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => moveStep(step.id, -1)}
                      style={{
                        width: '28px',
                        height: '28px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: idx === 0 ? '#ddd' : 'var(--secondary-foreground)',
                      }}
                      disabled={idx === 0}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => moveStep(step.id, 1)}
                      style={{
                        width: '28px',
                        height: '28px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color:
                          idx === form.steps.length - 1
                            ? '#ddd'
                            : 'var(--secondary-foreground)',
                      }}
                      disabled={idx === form.steps.length - 1}
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteStepLocal(step.id)}
                      style={{
                        width: '28px',
                        height: '28px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: '#ccc',
                      }}
                    >
                      <IconTrash style={{ width: '14px', height: '14px' }} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* 添加步骤输入框 */}
            <div
              style={{
                display: 'flex',
                gap: '8px',
                marginTop: '8px',
                padding: '0 2px',
              }}
            >
              <input
                className="input-field"
                placeholder="输入步骤名称"
                value={newStepTitle}
                onChange={(e) => setNewStepTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addStep();
                  }
                }}
                style={{ flex: 1, padding: '10px 12px' }}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={addStep}
                style={{
                  padding: '0 16px',
                  borderRadius: '10px',
                  fontSize: '14px',
                }}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================ 主组件 ============================

export default function TemplateSettings() {
  const navigate = useNavigate();

  const templates = useLiveQuery(
    () => db.taskTemplates.toArray().then((arr) => arr ?? []),
    [],
  );

  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(
    null,
  );
  const [showForm, setShowForm] = useState(false);

  // 删除二次确认（应用内确认框，层级高于遮罩）
  const [pendingDelete, setPendingDelete] = useState<TaskTemplate | null>(null);

  // 复制为自建的名称输入
  const [copySource, setCopySource] = useState<TaskTemplate | null>(null);
  const [copyName, setCopyName] = useState('');

  // 排序：preset 在前，custom 按创建时间倒序
  const sortedTemplates = (templates ?? [])
    .slice()
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'preset' ? -1 : 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const handleNew = () => {
    setEditingTemplate(null);
    setShowForm(true);
  };

  const handleEdit = (tpl: TaskTemplate) => {
    if (tpl.source === 'preset') return; // 内置置灰，不打开编辑
    setEditingTemplate(tpl);
    setShowForm(true);
  };

  const handleDelete = (tpl: TaskTemplate) => {
    if (tpl.source === 'preset') return;
    setPendingDelete(tpl);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteTaskTemplate(pendingDelete.id);
      toast('模板已删除');
      setPendingDelete(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  const handleCopy = (tpl: TaskTemplate) => {
    if (tpl.source !== 'preset') return; // 仅内置可复制
    setCopySource(tpl);
    setCopyName(`${tpl.name} 副本`);
  };

  const confirmCopy = async () => {
    if (!copySource) return;
    const name = copyName.trim();
    if (!name) {
      toast('名称不能为空', 'error');
      return;
    }
    try {
      await copyPresetTemplateAsCustom(copySource.id, { name });
      toast('已复制为自建模板');
      setCopySource(null);
      setCopyName('');
    } catch (err) {
      toast(err instanceof Error ? err.message : '复制失败', 'error');
    }
  };

  const handleSaved = () => {
    setShowForm(false);
    setEditingTemplate(null);
  };

  const handleBack = () => navigate('/settings');

  // ======================== 渲染 ========================
  if (templates === undefined) return null; // useLiveQuery 未解析

  return (
    <div className="page">
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={handleBack}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">任务模板</h1>
        <div className="right-actions">
          <button className="icon-btn" onClick={handleNew}>
            <IconPlus
              style={{ width: '20px', height: '20px', color: 'var(--accent)' }}
            />
          </button>
        </div>
      </div>

      <div className="page-content with-bottom-nav">
        <div className="template-list">
          {sortedTemplates.map((tpl) => {
            const isPreset = tpl.source === 'preset';
            return (
              <div
                key={tpl.id}
                className="template-item"
                onClick={() => handleEdit(tpl)}
                style={{
                  cursor: isPreset ? 'default' : 'pointer',
                  opacity: isPreset ? 0.7 : 1,
                }}
              >
                <div className="template-icon">
                  <IconTask
                    style={{
                      width: '20px',
                      height: '20px',
                      color: 'var(--accent)',
                    }}
                  />
                </div>
                <div className="template-info">
                  <div className="template-name">
                    {tpl.name}
                    {isPreset ? (
                      <span className="template-tag">预设</span>
                    ) : (
                      <span className="template-tag tag-custom">自建</span>
                    )}
                  </div>
                  <div className="template-sub">
                    {tpl.steps?.length || 0} 个步骤
                  </div>
                </div>
                {isPreset ? (
                  <button
                    className="btn btn-secondary"
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      flexShrink: 0,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopy(tpl);
                    }}
                  >
                    复制为自建
                  </button>
                ) : (
                  <button
                    className="template-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(tpl);
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: '8px',
                      cursor: 'pointer',
                      color: '#ccc',
                    }}
                  >
                    <IconTrash style={{ width: '16px', height: '16px' }} />
                  </button>
                )}
              </div>
            );
          })}
          {sortedTemplates.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: '40px 20px',
                color: 'var(--secondary-foreground)',
                fontSize: '13px',
              }}
            >
              还没有模板，点击右上角 + 新建一个吧
            </div>
          )}
        </div>
      </div>

      {/* 表单浮层（新建 / 编辑） */}
      {showForm && (
        <TemplateForm
          template={editingTemplate}
          onCancel={() => {
            setShowForm(false);
            setEditingTemplate(null);
          }}
          onSaved={handleSaved}
        />
      )}

      {/* 删除二次确认（应用内居中确认框，z-index 高于 form-overlay） */}
      {pendingDelete && (
        <div
          className="confirm-overlay"
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-title">
              确定删除模板「{pendingDelete.name}」？
            </div>
            <div
              style={{
                fontSize: '13px',
                color: 'var(--secondary-foreground)',
                marginBottom: '16px',
              }}
            >
              已经用过该模板的任务不受影响。
            </div>
            <div className="confirm-actions">
              <button
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => setPendingDelete(null)}
              >
                取消
              </button>
              <button
                className="btn btn-danger"
                style={{ flex: 1 }}
                onClick={confirmDelete}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 复制为自建输入名称 */}
      {copySource && (
        <div
          className="confirm-overlay"
          onClick={() => setCopySource(null)}
        >
          <div
            className="confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-title">
              复制「{copySource.name}」为自建模板
            </div>
            <div
              style={{
                fontSize: '13px',
                color: 'var(--secondary-foreground)',
                marginBottom: '8px',
              }}
            >
              模板名称（trim 后 1–30 字）
            </div>
            <input
              className="input-field"
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
              maxLength={30}
              autoFocus
              style={{ marginBottom: '12px' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmCopy();
              }}
            />
            <div className="confirm-actions">
              <button
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => setCopySource(null)}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={confirmCopy}
              >
                确认复制
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}