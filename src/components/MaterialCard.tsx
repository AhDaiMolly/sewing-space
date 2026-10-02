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

/**
 * AA-D 物料7：纸样卡片五颗星级评分（粉色星，恒渲染 5 个槽位，
 * 实心数 = rating；未评分显示 5 颗空心星，与参考图一致）。
 */
function PatternStars({ rating }: { rating: number }) {
  return (
    <span className="pattern-card-stars" aria-label={`评分 ${rating} 星`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <IconStar
          key={i}
          filled={i < rating}
          style={{
            width: '13px',
            height: '13px',
            color: i < rating ? '#FF7FA5' : '#E8CDD6',
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

  // ===== AA-D 物料7：纸样卡片改版（参考图口径）=====
  // 两列圆角卡片（外层 .material-grid 不变）、粉色系、图片右上角「已使用」粉色胶囊
  // （仅已使用显示）、名称黑色加粗单行截断、尺码紫色胶囊、五颗粉色星级、底部灰色品牌名。
  // 必须展示：纸样名称 / 尺码 / 评分 / 是否使用 / 纸样品牌（值为空的自然省略对应元素）。
  if (material.type === 'pattern') {
    return (
      <div className="material-card pattern-card" onClick={onClick}>
        <div className="material-thumb pattern pattern-card-thumb">
          {material.images && material.images.length > 0 && thumbSrc ? (
            <img
              src={thumbSrc}
              alt={material.name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <span style={{ display: 'inline-flex', color: '#FF9DBB' }}>
              <IconComp style={{ width: '42px', height: '42px' }} />
            </span>
          )}
          {isUsed && <span className="pattern-used-pill">已使用</span>}
        </div>
        <div className="pattern-card-info">
          <div className="pattern-card-name">{material.name}</div>
          {material.size && <span className="pattern-card-size">{material.size}</span>}
          <PatternStars rating={material.rating || 0} />
          {material.brand && <div className="pattern-card-brand">{material.brand}</div>}
        </div>
      </div>
    );
  }

  // ===== 其余三类：原布局（AA-D 物料8：名称下方「XX」类型标签全部去掉）=====
  // AD-A 物料2：库存展示改版——无库存（quantity <= 0）预览图置灰淡化 + 名称灰色 +
  // 灰色文字「已用完」；有库存名称黑色加粗 + 灰色文字「库存 当前量 / 购买量 单位」
  // （购买量 = 开账量 initialQuantity，如「库存 0.3 / 2 米」）。纸样无库存概念，不走本分支。
  const outOfStock = material.quantity <= 0;
  return (
    <div
      className={`material-card${outOfStock ? ' out-of-stock' : ''}`}
      onClick={onClick}
    >
      <div
        className={`material-thumb ${material.type}${outOfStock ? ' thumb-grayed' : ''}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
      >
        {material.images && material.images.length > 0 && thumbSrc ? (
          <img
            src={thumbSrc}
            alt={material.name}
            className={outOfStock ? 'thumb-img-grayed' : undefined}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ display: 'inline-flex', color: outOfStock ? 'var(--muted)' : 'var(--accent)' }}>
            <IconComp style={{ width: '42px', height: '42px' }} />
          </span>
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
        <div className={`material-name${outOfStock ? ' name-grayed' : ' in-stock-name'}`}>
          {material.name}
        </div>
        {/* AD-A 物料2：无库存显示「已用完」；有库存显示「库存 当前量 / 购买量 单位」 */}
        <div className="material-qty">
          {outOfStock
            ? '已用完'
            : `库存 ${material.quantity} / ${material.initialQuantity} ${material.unit}`}
        </div>
      </div>
    </div>
  );
}
