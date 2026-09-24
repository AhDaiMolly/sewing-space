// 卡通风格 SVG 图标组件集
// 风格：柔和粉色系、圆润造型、描边 + 浅粉填充
// 所有图标 viewBox="0 0 24 24"，通过 CSS color 控制主色

import React from 'react';

const iconStroke = 'currentColor';
const iconFillLight = 'hsla(345, 100%, 78%, 0.2)';

interface IconProps {
  style?: React.CSSProperties;
}

// —— 导航 / 操作图标 ——

export function IconSearch({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <circle cx="10.5" cy="10.5" r="5.5" fill={iconFillLight} fillOpacity={0.3} />
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15 15l4.5 4.5" />
    </svg>
  );
}

export function IconPlus({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={2} strokeLinecap="round" style={style}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconBack({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M16 4L7 12l9 8" />
    </svg>
  );
}

export function IconEdit({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M15.5 5.5l3 3L7 20H4v-3L15.5 5.5z" fill={iconFillLight} fillOpacity={0.3} />
      <path d="M15.5 5.5l3 3M7 20H4v-3L15.5 5.5z" />
    </svg>
  );
}

export function IconTrash({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M5 7h14l-1 14H6L5 7z" fill={iconFillLight} fillOpacity={0.3} />
      <path d="M5 7h14l-1 14H6L5 7z" />
      <path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

export function IconStar({ style, filled }: IconProps & { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" style={style}>
      <path
        d="M12 2l2.8 6.6L22 9.5l-5 5.4 1 7.1-6-3.6-6 3.6 1-7.1-5-5.4 7.2-1L12 2z"
        fill={filled ? 'currentColor' : 'none'}
        stroke={iconStroke}
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconScissors({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <circle cx="7" cy="7" r="3" fill={iconFillLight} fillOpacity={0.3} />
      <circle cx="7" cy="7" r="3" />
      <circle cx="7" cy="17" r="3" fill={iconFillLight} fillOpacity={0.3} />
      <circle cx="7" cy="17" r="3" />
      <path d="M9 8l10 6M9 16l10-6" />
    </svg>
  );
}

export function IconWarning({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M12 2L2 22h20L12 2z" fill={iconFillLight} fillOpacity={0.3} />
      <path d="M12 2L2 22h20L12 2z" />
      <path d="M12 10v4M12 18v1" />
    </svg>
  );
}

export function IconNote({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <rect x="5" y="3" width="14" height="18" rx="2" fill={iconFillLight} fillOpacity={0.3} />
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

export function IconDress({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M9 3h6v3l2 4-2 2v9H9v-9L7 10l2-4V3z" fill={iconFillLight} fillOpacity={0.3} />
      <path d="M9 3h6v3l2 4-2 2v9H9v-9L7 10l2-4V3z" />
      <path d="M10.5 7c0 .8.7 1.5 1.5 1.5s1.5-.7 1.5-1.5" fill="none" />
    </svg>
  );
}

export function IconTask({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <rect x="4" y="4" width="16" height="16" rx="3" fill={iconFillLight} fillOpacity={0.3} />
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 8l3 3 5-5" />
    </svg>
  );
}

export function IconTag({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M3 3h8l10 10-8 8L3 11V3z" fill={iconFillLight} fillOpacity={0.3} />
      <path d="M3 3h8l10 10-8 8L3 11V3z" />
      <circle cx="8" cy="8" r="1.5" />
    </svg>
  );
}

// —— S5-B 新增图标（PRD §8.1 / 完工登记浮层所需） ——

export function IconGear({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" fill={iconFillLight} fillOpacity={0.3} />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconHeart({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" fill="currentColor" fillOpacity={0.2} />
      <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
    </svg>
  );
}

export function IconArrowRight({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconPattern({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M8 4h8l2 4v2l-2 2v10H8V12L6 10V8l2-4z" fill={iconFillLight} fillOpacity={0.3} />
      <path d="M8 4h8l2 4v2l-2 2v10H8V12L6 10V8l2-4z" />
      <path d="M12 8v6" strokeDasharray="2 2" />
      <path d="M9 4c0 1.1-.9 2-2 2s-2-.9-2-2" />
      <circle cx="12" cy="6.5" r="0.6" fill={iconStroke} stroke="none" />
    </svg>
  );
}

export function IconCheck({ style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke={iconStroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}