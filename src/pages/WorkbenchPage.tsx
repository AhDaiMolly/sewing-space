// src/pages/WorkbenchPage.tsx —— 工作台页（看板 + 列表双视图 + 已完成详情浮层）
// UI 基线：docs/demo/src/pages/WorkbenchPage.jsx
// 落实 PRD §8.10 + 缺陷表 + §15.5 不复刻清单 + S2/S3 教训：
//   - useLiveQuery「可判已结算」写法：undefined=未解析(null=不存在)
//   - 浮层容器 stopPropagation 守卫
//   - 完成入口走 handleTaskComplete 单函数
//   - 完成任务不改 garment.status
//   - 标签 chips 最多 2 + 「+N」
//   - 真实 today，不写死
//   - 日期显示 YYYY.MM.DD
//   - 「开始任务」按钮 stopPropagation + setTaskStatus
//   - W-C 新增任务2：任务卡上的成衣制作启动按钮移除——「开始任务」已由
//     服务层联动触发成衣开始制作（planning→in_progress + 扣库存），双入口
//     收敛为单通道；成衣库详情页的成衣侧入口保留不动。
//   - 列表视图任务按日期分组：今天/明天/本周/更早/无日期
//   - 已完成任务点开 → DoneTaskDetail 浮层（应用内删除确认，z-index 高于主浮层）

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Garment, Task, TaskStatus } from '@/db/types';
import {
  handleTaskComplete,
  setTaskStatus,
  toggleTaskStep,
} from '@/services/taskService';
import { toast } from '@/store/toastStore';
import {
  sortTasks,
} from '@/lib/date';
import EmptyState from '@/components/EmptyState';
import TaskCard from '@/components/TaskCard';
import TaskListItem from '@/components/TaskListItem';
import DoneTaskDetail from '@/components/DoneTaskDetail';
import TaskFormSheet from '@/components/TaskFormSheet';
import { IconPlus } from '@/components/Icons';

interface WorkbenchPageProps {
  /** 兼容旧用法（S4-B 期间的占位）。S4-C 后由本地状态管理表单弹层，
   *  父级若仍传入则会被忽略——TaskFormSheet 已直接挂在 WorkbenchPage 上。 */
  onOpenTaskForm?: (task: Task | null) => void;
}

type ViewMode = 'kanban' | 'list';

// AH-A Q3：日期分组（今天/明天/本周/更早/无截止日期）随截止日期展示一并移除——
// 分组标签本身就是截止日期信息的展示形态；列表视图改为按 sortTasks 平铺。

// ============================ 主组件 ============================
export default function WorkbenchPage({ onOpenTaskForm: _legacy }: WorkbenchPageProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');
  const [statusFilter, setStatusFilter] = useState<TaskStatus>('todo');

  // 已完成详情浮层状态：doneTaskId 非空即渲染
  const [doneTaskId, setDoneTaskId] = useState<string>('');

  // 任务表单浮层状态：formOpen=true 时渲染 TaskFormSheet；
  // formTask=null 时为新建模式，非 null 时为编辑该任务
  const [formOpen, setFormOpen] = useState(false);
  const [formTask, setFormTask] = useState<Task | null>(null);

  // ── 数据源 ──
  // 全表读（PRD §8.10：派生「看板列」「筛选列表」都在前端做）
  const tasks = useLiveQuery(
    () => db.tasks.toArray().then((arr) => arr ?? []),
    [],
  );
  const garments = useLiveQuery(
    () => db.garments.toArray().then((arr) => arr ?? []),
    [],
  );

  // 加载中：tasks 未解析（undefined）→ 整页不渲染
  if (tasks === undefined || garments === undefined) return null;

  // ── 派生 ──
  // 按状态分桶（看板/列表复用）
  const byStatus: Record<TaskStatus, Task[]> = {
    todo: [],
    in_progress: [],
    done: [],
  };
  for (const t of tasks) {
    byStatus[t.status].push(t);
  }
  // 每个桶内按 sortTasks 排序（三级键）
  byStatus.todo.sort(sortTasks);
  byStatus.in_progress.sort(sortTasks);
  byStatus.done.sort(sortTasks);

  // 关联成衣 map（id → garment），用于判断 planning 状态
  const garmentById = new Map<string, Garment>();
  for (const g of garments) garmentById.set(g.id, g);

  // ── 操作回调 ──
  // 「开始任务」：taskService.setTaskStatus 显式入口（不在 UI 层硬写 status）
  const handleStartTask = async (taskId: string) => {
    try {
      await setTaskStatus(taskId, 'in_progress');
    } catch (err) {
      toast(err instanceof Error ? err.message : '开始任务失败', 'error');
    }
  };

  // 显式「完成」按钮：仅调 handleTaskComplete 单函数（架构 §13.4 S4 DoD）
  const handleCompleteClick = async (taskId: string) => {
    try {
      await handleTaskComplete(taskId);
      toast('任务已完成');
    } catch (err) {
      toast(err instanceof Error ? err.message : '完成任务失败', 'error');
    }
  };

  // 行内步骤勾选：调 toggleTaskStep；todo 时由组件拦截提示（不在此重复判断）
  const handleToggleStep = async (taskId: string, stepId: string, done: boolean) => {
    try {
      await toggleTaskStep(taskId, stepId, done);
    } catch (err) {
      toast(err instanceof Error ? err.message : '勾选失败', 'error');
    }
  };

  // 新建 / 编辑任务：S4-C 直接挂载 TaskFormSheet
  const openForm = (task: Task | null) => {
    setFormTask(task);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setFormTask(null);
  };

  // 完成任务：只读详情浮层
  const openDoneDetail = (task: Task) => {
    setDoneTaskId(task.id);
  };
  const closeDoneDetail = () => setDoneTaskId('');

  // ── 渲染子段 ──
  // ── 渲染 ──
  return (
    <div className="page workbench-page">
      {/* 页头 */}
      <div className="page-header">
        <div className="left-actions" />
        <h1 className="title">工作台</h1>
        <div className="right-actions">
          <button
            type="button"
            className="btn-new-task"
            onClick={() => openForm(null)}
          >
            <span className="new-icon">
              <IconPlus style={{ width: '16px', height: '16px' }} />
            </span>
            <span>新建</span>
          </button>
        </div>
      </div>

      {/* 视图切换 tabs */}
      <div className="tabs-row">
        <button
          type="button"
          className={`tab-item ${viewMode === 'kanban' ? 'active' : ''}`}
          onClick={() => setViewMode('kanban')}
        >
          看板视图
        </button>
        <button
          type="button"
          className={`tab-item ${viewMode === 'list' ? 'active' : ''}`}
          onClick={() => setViewMode('list')}
        >
          列表视图
        </button>
      </div>

      {viewMode === 'kanban' ? (
        <KanbanView
          byStatus={byStatus}
          garmentById={garmentById}
          onCardClick={(t) => openForm(t)}
          onStartTask={handleStartTask}
          onComplete={handleCompleteClick}
          onToggleStep={handleToggleStep}
          onOpenDoneDetail={openDoneDetail}
        />
      ) : (
        <ListView
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          byStatus={byStatus}
          onCardClick={(t) => openForm(t)}
          onStartTask={handleStartTask}
          onComplete={handleCompleteClick}
          onToggleStep={handleToggleStep}
          onOpenDoneDetail={openDoneDetail}
        />
      )}

      {/* 已完成详情浮层 */}
      {doneTaskId && (
        <DoneTaskDetail taskId={doneTaskId} onClose={closeDoneDetail} />
      )}

      {/* 任务新建/编辑浮层（S4-C 接入：本地状态管理 + 显式 navigate） */}
      {formOpen && (
        <TaskFormSheet task={formTask} onClose={closeForm} />
      )}
    </div>
  );
}

// ============================ 看板视图 ============================
interface KanbanViewProps {
  byStatus: Record<TaskStatus, Task[]>;
  garmentById: Map<string, Garment>;
  onCardClick: (t: Task) => void;
  onStartTask: (id: string) => void;
  onComplete: (id: string) => void;
  /** AH-A Q4：看板卡片步骤行内勾选（与列表视图同一服务） */
  onToggleStep: (taskId: string, stepId: string, done: boolean) => void;
  onOpenDoneDetail: (t: Task) => void;
}

function KanbanView({
  byStatus,
  onCardClick,
  onStartTask,
  onComplete,
  onToggleStep,
}: KanbanViewProps) {
  // W-B（工作台1）：栏位标题前的 icon 移除，仅保留圆点指示。
  // 核对结论：看板视图仅渲染「待办/进行中」两栏，「已完成」无看板栏位
  // （已完成任务在列表视图用极简行展示，无同类 icon），三栏一致性天然成立。
  const columns: { key: TaskStatus; label: string; dot: string; show: boolean }[] = [
    {
      key: 'todo',
      label: '待办',
      dot: 'var(--status-todo)',
      show: true,
    },
    {
      key: 'in_progress',
      label: '进行中',
      dot: 'var(--status-in-progress)',
      show: true,
    },
  ];

  return (
    <div className="page-content with-bottom-nav kanban-container">
      <div className="kanban-board">
        {columns.map((col) => {
          const colTasks = byStatus[col.key];
          return (
            <div key={col.key} className="kanban-column">
              <div className="kanban-col-header">
                <span className="dot" style={{ background: col.dot }} />
                <span className="title">{col.label}</span>
                <span className="count">{colTasks.length}</span>
              </div>

              {colTasks.map((task) => (
                <div key={task.id} className="kanban-task-wrap">
                  <TaskCard
                    task={task}
                    onClick={() => onCardClick(task)}
                    onToggleStep={onToggleStep}
                  />
                  {task.status === 'todo' && (
                    <div className="kanban-task-actions">
                      <button
                        type="button"
                        className="btn-start-task"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStartTask(task.id);
                        }}
                      >
                        开始任务
                      </button>
                    </div>
                  )}
                  {task.status === 'in_progress' && (
                    <div className="kanban-task-actions">
                      <button
                        type="button"
                        className="btn-start-task"
                        onClick={(e) => {
                          e.stopPropagation();
                          onComplete(task.id);
                        }}
                      >
                        完成
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {colTasks.length === 0 && (
                <div className="kanban-column-empty">暂无任务</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================ 列表视图 ============================
interface ListViewProps {
  statusFilter: TaskStatus;
  setStatusFilter: (s: TaskStatus) => void;
  byStatus: Record<TaskStatus, Task[]>;
  onCardClick: (t: Task) => void;
  onStartTask: (id: string) => void;
  onComplete: (id: string) => void;
  onToggleStep: (taskId: string, stepId: string, done: boolean) => void;
  onOpenDoneDetail: (t: Task) => void;
}

const STATUS_FILTER_OPTIONS: { key: TaskStatus; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'in_progress', label: '进行中' },
  { key: 'done', label: '已完成' },
];

function ListView({
  statusFilter,
  setStatusFilter,
  byStatus,
  onCardClick,
  onStartTask,
  onComplete,
  onToggleStep,
  onOpenDoneDetail,
}: ListViewProps) {
  const filteredTasks = byStatus[statusFilter];

  return (
    <div className="page-content with-bottom-nav" style={{ paddingTop: 0 }}>
      {/* 筛选 chips（无「全部」） */}
      <div className="list-filter-bar">
        <div className="filter-chips-row">
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`filter-chip ${statusFilter === opt.key ? 'active' : ''}`}
              onClick={() => setStatusFilter(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 已完成：极简行（PRD §8.10 + demo） */}
      {statusFilter === 'done' ? (
        filteredTasks.length > 0 ? (
          <div className="task-list-container">
            {filteredTasks.map((task) => (
              <div
                key={task.id}
                className="task-done-item"
                onClick={() => onOpenDoneDetail(task)}
              >
                <span className="task-done-title">{task.title}</span>
                <span className="task-done-arrow">›</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="task"
            title="暂无任务"
            description="点击右上角 + 添加第一个任务"
          />
        )
      ) : filteredTasks.length === 0 ? (
        <EmptyState
          icon="task"
          title="暂无任务"
          description="点击右上角 + 添加第一个任务"
        />
      ) : (
        <div className="task-list-container">
          {/* AH-A Q3：日期分组移除，按 sortTasks 平铺（桶内已在主组件排好序） */}
          {filteredTasks.map((task) => (
            <div key={task.id} className="task-list-item-wrap">
              <TaskListItem
                task={task}
                onClick={() => onCardClick(task)}
                onToggleStep={onToggleStep}
              />
              {task.status === 'todo' && (
                <div className="task-list-actions">
                  <button
                    type="button"
                    className="btn-action btn-action-primary"
                    onClick={() => onStartTask(task.id)}
                  >
                    开始任务
                  </button>
                </div>
              )}
              {task.status === 'in_progress' && (
                <div className="task-list-actions">
                  <button
                    type="button"
                    className="btn-action btn-action-primary"
                    onClick={() => onComplete(task.id)}
                  >
                    完成
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// （AH-A Q3：日期分组列表组件已随截止日期展示一并移除）
