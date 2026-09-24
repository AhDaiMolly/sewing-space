// src/pages/SettingsPage.tsx —— 设置主页（S4-C 接入模板管理入口）
// UI 基线：docs/demo/src/pages/SettingsPage.jsx
// 仅实现「任务模板管理」入口按钮，其余设置二级页（备份 / GitHub / 预设管理 /
// 个人信息 / 关于）由 S7 接手，本文件只占位。

import { useNavigate } from 'react-router-dom';
import PageHeader from '@/components/PageHeader';
import { IconTask } from '@/components/Icons';

export default function SettingsPage() {
  const navigate = useNavigate();

  return (
    <div className="page">
      <PageHeader title="设置" />
      <div className="page-content with-bottom-nav">
        <div className="settings-list">
          <button
            type="button"
            className="settings-item"
            onClick={() => navigate('/settings/templates')}
          >
            <div className="settings-icon">
              <IconTask
                style={{
                  width: '20px',
                  height: '20px',
                  color: 'var(--accent)',
                }}
              />
            </div>
            <div className="settings-info">
              <div className="settings-name">任务模板管理</div>
              <div className="settings-subtitle">
                新建、编辑、删除任务模板
              </div>
            </div>
            <span className="settings-arrow">›</span>
          </button>
        </div>
      </div>
    </div>
  );
}