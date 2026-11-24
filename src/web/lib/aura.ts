import type { CSSProperties } from "react";

/**
 * 会话卡上“流动的氤氲”（scene.css 的 `.a-aura`）每张卡各有一组起始相位。
 * 两团氤氲各有横、纵两条往返的“腿”，共四条；每条腿的相位是 (0, 1) 里的一个数，样式表里把它乘上一整个往返的时长、写成负的 animation-delay，
 * 动画一出生就已经走到那一帧。
 * 相位取自会话标识的哈希，而不是 Math.random：同一个会话在每次渲染、刷新、换一个浏览器打开时都是同一帧，不会因为节点重渲染而重新起跳；
 * 不同会话各在各的位置，二十张卡同时在跑也不会整齐划一地同进同退。纯函数，不依赖任何状态。
 */
export const AURA_PHASE_VARS = ["--aura-ax", "--aura-ay", "--aura-bx", "--aura-by"] as const;

/** FNV-1a，32 位：把字符串摊成一个整数种子。不是密码学用途，只要“相近的标识也能摊开”。 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** murmur3 的收尾混合：同一个种子加上不同的序号，得到彼此无关的四个数——直接把一个哈希切成四段，标识相近的会话四个数会一起相近。 */
function mix(seed: number): number {
  let hash = seed | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * 四条腿的相位，都落在 [0.001, 0.999]，保留三位小数：不取 0，因为相位为 0 时动画从头开始，
 * 减弱动效下“起点帧”会在这一张卡上多停一瞬，与别的卡不一致；不取 1，因为它与 0 是同一帧。
 */
export function auraPhases(id: string): [number, number, number, number] {
  const seed = fnv1a(id);
  const phase = (index: number): number => ((mix(seed + Math.imul(index + 1, 0x9e3779b9)) % 999) + 1) / 1000;
  return [phase(0), phase(1), phase(2), phase(3)];
}

/** 写在 `.a-aura` 上的行内样式：四个自定义属性，样式表里的 animation-delay 读它们（没有它们时回落到 0，即从头开始）。 */
export function auraStyle(id: string): CSSProperties {
  const style: Record<string, string> = {};
  auraPhases(id).forEach((value, index) => {
    style[AURA_PHASE_VARS[index]!] = value.toFixed(3);
  });
  return style as CSSProperties;
}
