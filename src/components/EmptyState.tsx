import React from 'react';
import { IconNote, IconDress, IconTask, IconSearch } from './Icons';
import { UserIconCatFabric, UserIconCatAccessory, UserIconCatTool, UserIconCatPattern, UserIconNavGarments } from './UserIcons';

interface EmptyStateProps {
  icon?: string;
  title?: string;
  desc?: string;
  description?: string;
}

export default function EmptyState({ icon = 'default', title = '暂无数据', desc = '', description = '' }: EmptyStateProps) {
  const actualDesc = desc || description;

  const iconMap: Record<string, React.ComponentType<{ style?: React.CSSProperties }>> = {
    default: IconNote,
    fabric: UserIconCatFabric,
    accessory: UserIconCatAccessory,
    tool: UserIconCatTool,
    pattern: UserIconCatPattern,
    dress: IconDress,
    garments: UserIconNavGarments,
    task: IconTask,
    search: IconSearch,
  };

  const IconComp = typeof icon === 'string' ? iconMap[icon] || iconMap.default : null;

  return (
    <div className="empty-state">
      <div className="icon" style={{ color: 'var(--accent)', opacity: 0.5 }}>
        {IconComp ? <IconComp style={{ width: '48px', height: '48px' }} /> : icon}
      </div>
      <div className="title">{title}</div>
      {actualDesc && <div className="desc">{actualDesc}</div>}
    </div>
  );
}