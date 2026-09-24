import React, { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Material, MaterialType } from '@/db/types';
import { IconStar } from './Icons';
import { UserIconCatFabric, UserIconCatAccessory, UserIconCatTool, UserIconCatPattern } from './UserIcons';

interface MaterialCardProps {
  material: Material;
  onClick: () => void;
  onConsume?: (id: string) => void;
}

const iconMap: Record<MaterialType, React.ComponentType<{ style?: React.CSSProperties }>> = {
  fabric: UserIconCatFabric,
  accessory: UserIconCatAccessory,
  tool: UserIconCatTool,
  pattern: UserIconCatPattern,
};

const typeLabels: Record<MaterialType, string> = {
  fabric: '面料',
  accessory: '辅料',
  tool: '工具',
  pattern: '纸样',
};

function renderStars(rating: number) {
  if (!rating) return null;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <IconStar
          key={i}
          filled={i < rating}
          style={{
            width: '11px',
            height: '11px',
            color: i < rating ? '#FFC107' : '#DDD',
            display: 'inline-block',
          }}
        />
      ))}
    </span>
  );
}

export default function MaterialCard({ material, onClick, onConsume }: MaterialCardProps) {
  const IconComp = iconMap[material.type];

  // 纸样已使用状态：按落库字段 used 判定（PRD §8.2）
  const isUsed = material.used === 1;

  // 图片：从 images 表取首图 blob URL（useState 触发重渲染，P1-2 修复）
  const firstImageId = material.images?.[0];
  const firstImageRec = useLiveQuery(
    () => (firstImageId ? db.images.get(firstImageId) : undefined),
    [firstImageId],
  );
  const [thumbSrc, setThumbSrc] = useState('');
  useEffect(() => {
    if (firstImageRec?.blob) {
      const url = URL.createObjectURL(firstImageRec.blob);
      setThumbSrc(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    setThumbSrc('');
  }, [firstImageRec]);

  return (
    <div className="material-card" onClick={onClick}>
      <div
        className={`material-thumb ${material.type}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
      >
        {material.images && material.images.length > 0 && thumbSrc ? (
          <img
            src={thumbSrc}
            alt={material.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ display: 'inline-flex', color: 'var(--accent)' }}>
            <IconComp style={{ width: '42px', height: '42px' }} />
          </span>
        )}
        {material.type === 'pattern' && (
          <>
            {isUsed && <span className="used-badge">已使用</span>}
            <span className="rating" style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
              {renderStars(material.rating || 0)}
            </span>
          </>
        )}
      </div>
      {(material.type === 'accessory' || material.type === 'tool') && onConsume && (
        <button
          className="card-consume-btn"
          onClick={(e) => {
            e.stopPropagation();
            onConsume(material.id);
          }}
          title="记损耗"
        >
          −
        </button>
      )}
      <div className="material-info">
        <div className="material-name">{material.name}</div>
        <span className="material-type-badge">{typeLabels[material.type]}</span>
        <div className="material-qty">
          剩余 {material.quantity} {material.unit}
        </div>
      </div>
    </div>
  );
}