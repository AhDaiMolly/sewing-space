// ConsumptionSheet — 记损耗浮层（PRD §8.13）
// 从物料详情页打开；超库存回退并中文提示；写 consume 流水。
// UI 基线：demo/src/components/ConsumptionSheet.jsx
// 不复刻清单（PRD §8.13 缺陷表）：
//   #1 超库存时传封顶值不传原始值（demo 传原始值导致负数）
//   #2 备注留空写空串不写 null
//   #3 扣减后库存不显示负数（demo 只改红色仍允许提交）
//   #4 "−"以 0 为下界（demo 无下界保护）

import { useState, useCallback } from 'react';
import type { Material } from '@/db/types';
import { recordLoss } from '@/services/materialService';
import { toast } from '@/store/toastStore';

interface ConsumptionSheetProps {
  material: Material;
  onCancel: () => void;
  /** 扣减成功后的回调。调用方负责关闭浮层并刷新数据。 */
  onDone: () => void;
}

export default function ConsumptionSheet({
  material,
  onCancel,
  onDone,
}: ConsumptionSheetProps) {
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const stock = Number(material.quantity) || 0;
  const unit = material.unit || '';
  const currentQty = parseFloat(quantity) || 0;
  const afterQty = Math.max(0, +(stock - currentQty).toFixed(1));
  const isOver = currentQty > stock;

  const clampToStock = useCallback(
    (val: number): { clamped: number; over: boolean } => {
      if (val > stock) {
        return { clamped: stock, over: true };
      }
      return { clamped: val, over: false };
    },
    [stock],
  );

  const handleQuantityChange = useCallback(
    (val: string) => {
      if (val === '' || /^\d*\.?\d*$/.test(val)) {
        const num = val === '' ? 0 : parseFloat(val) || 0;
        if (num > stock) {
          setQuantity(String(stock));
          toast(`用量不能超过库存 ${stock}${unit}`);
        } else {
          setQuantity(val);
        }
        setError('');
      }
    },
    [stock, unit],
  );

  const handleMinus = useCallback(() => {
    const current = parseFloat(quantity) || 0;
    const next = Math.max(0, +(current - 0.5).toFixed(1));
    setQuantity(next === 0 ? '' : String(next));
    setError('');
  }, [quantity]);

  const handlePlus = useCallback(() => {
    const current = parseFloat(quantity) || 0;
    const next = +(current + 0.5).toFixed(1);
    const { clamped, over } = clampToStock(next);
    if (over) {
      toast(`用量不能超过库存 ${stock}${unit}`);
    }
    setQuantity(String(clamped));
    setError('');
  }, [quantity, clampToStock, stock, unit]);

  const handleConfirm = useCallback(async () => {
    const qty = parseFloat(quantity);
    if (!qty || qty <= 0) {
      setError('请输入大于 0 的扣减量');
      return;
    }

    // 兜底封顶（PRD 不复刻#1：必须传封顶值）
    const finalQty = qty > stock ? stock : qty;
    if (finalQty <= 0) {
      setError('请输入大于 0 的扣减量');
      return;
    }

    setSubmitting(true);
    try {
      const cleanNote = note.trim() || ''; // 不复刻#2：空串非 null
      await recordLoss(material.id, finalQty, cleanNote);
      const remaining = +(stock - finalQty).toFixed(1);
      toast(`已扣减 ${finalQty}${unit}，剩余 ${remaining}${unit}`);
      onDone();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '扣减失败';
      toast(msg);
    } finally {
      setSubmitting(false);
    }
  }, [quantity, stock, unit, note, material.id, onDone]);

  return (
    <div className="form-overlay" onClick={onCancel}>
      <div
        className="form-sheet consumption-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-header">
          <button className="cancel" onClick={onCancel}>
            取消
          </button>
          <div className="title">记损耗</div>
          <div className="cancel" style={{ visibility: 'hidden' }}>
            取消
          </div>
        </div>

        <div className="form-body">
          {/* 当前库存 */}
          <div className="consumption-current-stock">
            <span className="stock-label">当前库存</span>
            <span className="stock-value">
              {stock} {unit}
            </span>
          </div>

          {/* 扣减量 */}
          <div className="form-group">
            <label className="form-label">扣减量</label>
            <div className="quantity-input-row">
              <button className="qty-btn qty-minus" onClick={handleMinus}>
                −
              </button>
              <input
                type="text"
                className={`qty-input${error ? ' error' : ''}`}
                value={quantity}
                placeholder="0"
                onChange={(e) => handleQuantityChange(e.target.value)}
                inputMode="decimal"
              />
              <button className="qty-btn qty-plus" onClick={handlePlus}>
                +
              </button>
            </div>
            {error && <div className="form-error">{error}</div>}
          </div>

          {/* 备注 */}
          <div className="form-group">
            <label className="form-label">备注（可选）</label>
            <input
              type="text"
              className="form-input"
              value={note}
              placeholder="如：样布剪取、制作测试等"
              onChange={(e) => setNote(e.target.value)}
              maxLength={50}
            />
          </div>

          {/* 扣减后库存（不复刻#3：永远不显示负数） */}
          <div className="consumption-hint">
            <span>扣减后库存：</span>
            <span className={`after-qty${isOver ? ' error-text' : ''}`}>
              {afterQty} {unit}
            </span>
          </div>
        </div>

        <div className="form-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? '提交中…' : '确认扣减'}
          </button>
        </div>
      </div>
    </div>
  );
}