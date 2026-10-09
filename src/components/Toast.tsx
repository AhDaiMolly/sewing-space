// Toast 提示组件 — 队列式（toastStore §4.4）
// 架构 §4.4：队列最多 3 条，同消息去重，默认 2000ms
// S2-FIX-4 N-5：消费 duration 字段，自动消失 + 推进队列

import { useEffect } from 'react';
import { useToastStore } from '@/store/toastStore';

export default function ToastContainer() {
  const current = useToastStore((s) => s.current);
  const dismiss = useToastStore((s) => s.dismiss);

  // S2-FIX-4 N-5：自动消失定时器。
  // duration === 0 表示常驻（架构 §4.4：0 = 常驻），跳过定时器。
  useEffect(() => {
    if (!current) return;
    if (current.duration <= 0) return;
    const timer = setTimeout(() => {
      dismiss();
    }, current.duration);
    return () => clearTimeout(timer);
  }, [current, dismiss]);

  if (!current) return null;

  return (
    <div className="toast-container">
      <div className={`toast ${current.kind !== 'default' ? `toast-${current.kind}` : ''}`}>
        {current.message}
      </div>
    </div>
  );
}