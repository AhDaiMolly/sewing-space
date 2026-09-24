// src/components/DeleteGarmentConfirm.tsx — 删除成衣确认弹窗
// PRD §8.14；任务 3-6。
// UI 基线：demo/src/components/DeleteGarmentConfirm.jsx
// 不复刻清单：无（demo 结构与本版一致，逐行对应）
//
// 逐行列出将还原的物料名称与数量（来自 garmentMaterials 快照活跃行），
// 确认后调 garmentService.deleteGarmentWithRestore（P3c 事务、写 revert 流水），
// toast 提示「已删除 · 库存已还原」。

import { useState } from 'react';
import type { Garment } from '@/db/types';
import { deleteGarmentWithRestore } from '@/services/garmentService';
import { toast } from '@/store/toastStore';

interface DeleteGarmentConfirmProps {
  garment: Garment;
  onCancel: () => void;
  onDeleted: () => void;
}

export default function DeleteGarmentConfirm({
  garment,
  onCancel,
  onDeleted,
}: DeleteGarmentConfirmProps) {
  const [submitting, setSubmitting] = useState(false);

  // 活跃行（deducted 且 quantityUsed > 0）
  const revertItems = (garment.materialSnapshot ?? []).filter(
    (s) => !('retiredAt' in s) && s.quantityUsed > 0,
  );

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await deleteGarmentWithRestore({ id: garment.id });
      toast('已删除 · 库存已还原');
      onDeleted();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '删除失败';
      toast(msg);
      setSubmitting(false);
    }
  };

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div
        className="confirm-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-icon">⚠</div>
        <div className="confirm-title">
          确认删除「{garment.name}」？
        </div>

        {revertItems.length > 0 ? (
          <div className="confirm-detail-box">
            <div className="confirm-detail-title">
              删除后将还原库存：
            </div>
            <div className="confirm-revert-list">
              {revertItems.map((item) => (
                <div
                  key={item.materialId}
                  className="confirm-revert-item"
                >
                  <span className="confirm-revert-name">
                    {item.name}
                  </span>
                  <span className="confirm-revert-qty">
                    +{item.quantityUsed}
                    {item.unit}
                  </span>
                </div>
              ))}
            </div>
            <div className="confirm-detail-note">
              库存将按实际扣减量逐物料回补，成本统计随之回退。
            </div>
          </div>
        ) : (
          <div className="confirm-detail-box">
            <div className="confirm-detail-note">
              该成衣无已扣减的物料记录，删除后不影响库存。
            </div>
          </div>
        )}

        <div className="confirm-actions">
          <button
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className="btn btn-danger"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}