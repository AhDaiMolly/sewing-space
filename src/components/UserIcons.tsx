// 用户设计 SVG 图标组件
// 猫系列（面料/辅料/工具/纸样）：V-ICON 起替换为用户补发的 VTracer 原设计素材
// （2048×2048 固定配色描摹稿，svgo 压缩 ~80% 后置于 public/icons/，经 <img> 加载：
//   不进 JS bundle、浏览器按需拉取；src 用 import.meta.env.BASE_URL 前缀，
//   适配 /sewing-space/ 部署形态。SVG 为固定配色，不随 currentColor 变色，
//   选中态沿用 .type-option.selected 既有边框/底色区分，不改色。）
// 导航·成衣库：维持原内联 SVG 不变（用户未提供替换素材）。

import React from 'react';

function makeUserIcon(innerHtml: string) {
  return function UserIcon({ style }: { style?: React.CSSProperties }) {
    return (
      <svg
        viewBox="0 0 2048 2048"
        width="1em"
        height="1em"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={style}
        dangerouslySetInnerHTML={{ __html: innerHtml }}
      />
    );
  };
}

// 猫系列：public/icons/ 静态资源引用（用户原设计 SVG，V-ICON）
function makeUserImgIcon(src: string, alt: string) {
  return function UserImgIcon({ style }: { style?: React.CSSProperties }) {
    return (
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{ width: '1em', height: '1em', objectFit: 'contain', ...style }}
      />
    );
  };
}

const __iconsBase = `${import.meta.env.BASE_URL}icons/`;

export const UserIconCatFabric = makeUserImgIcon(`${__iconsBase}cat-fabric.svg`, '面料');
export const UserIconCatAccessory = makeUserImgIcon(`${__iconsBase}cat-accessory.svg`, '辅料');
export const UserIconCatTool = makeUserImgIcon(`${__iconsBase}cat-tool.svg`, '工具');
export const UserIconCatPattern = makeUserImgIcon(`${__iconsBase}cat-pattern.svg`, '纸样');

// 导航·成衣库
const __navGarmentsHtml = `<path fill="#FDD3D9" d="M320 280h1320q25 0 42 17t17 42v1250q0 25-17 42t-42 17H320q-25 0-42-17t-17-42V339q0-25 17-42t42-17z"/><path fill="#FDECF1" d="M320 280h1320q25 0 42 17t17 42v1250q0 25-17 42t-42 17H320q-25 0-42-17t-17-42V339q0-25 17-42t42-17z"/><path fill="#CE3763" d="M320 280h1320q12 0 21 8t9 20v1250q0 12-9 20t-21 8H320q-12 0-21-8t-9-20V308q0-12 9-20t21-8z"/><path fill="#fff" d="M700 580h520q16 0 28 12t12 28v400q0 16-12 28t-28 12H700q-16 0-28-12t-12-28V620q0-16 12-28t28-12z"/><path fill="#FDD3D9" d="M800 680h320v40H800zM800 760h240v40H800zM800 840h200v40H800z"/><path fill="#CE3763" d="M800 680h320v40H800zM800 760h240v40H800zM800 840h200v40H800z"/><circle cx="690" cy="700" r="20" fill="#FDECF1"/><circle cx="690" cy="780" r="20" fill="#FDECF1"/><circle cx="1230" cy="700" r="20" fill="#FDECF1"/><circle cx="1230" cy="780" r="20" fill="#FDECF1"/>`;

export const UserIconNavGarments = makeUserIcon(__navGarmentsHtml);
