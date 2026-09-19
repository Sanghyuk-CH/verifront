// 스냅숏의 노드 트리를 검사기가 보는 속성만 남겨 한 줄씩 적는다.
// 실행: npx tsx scripts/describe-design.ts [스냅숏] [이름]
//
// 두 가지에 쓴다.
//   1. 시안을 피그마에 옮길 때의 값 목록. 합성 스냅숏을 넣으면 그대로 따라 만들 수 있다.
//   2. 옮긴 결과 확인. 합성본과 실제 스냅숏의 출력을 diff 하면 손으로 옮기다 틀린 곳이 나온다.
// 글자 상자의 폭과 높이는 글꼴이 정하니 적지 않는다. id 도 파일마다 달라서 적지 않는다.

import { readFileSync } from 'node:fs';
import type { Snapshot } from '../src/figma.ts';

interface Raw {
  name: string;
  type: string;
  visible?: boolean;
  children?: Raw[];
  absoluteBoundingBox?: { width: number; height: number } | null;
  characters?: string;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  strokesIncludedInLayout?: boolean;
  layoutPositioning?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  fills?: Array<{ type: string; visible?: boolean; opacity?: number; color?: { r: number; g: number; b: number; a: number } }>;
  strokes?: Raw['fills'];
  strokeWeight?: number;
  strokeAlign?: string;
  cornerRadius?: number;
  opacity?: number;
  style?: { fontSize?: number; fontWeight?: number; lineHeightPx?: number; lineHeightUnit?: string; textAlignHorizontal?: string; textAutoResize?: string };
}

const [snapPath = 'experiments/figma/snapshot.json', label = 'card-list'] = process.argv.slice(2);
const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
const id = snap.index[label] ?? label;
const root = snap.nodes[id]?.document as unknown as Raw | undefined;
if (!root) {
  console.error(`스냅숏에 ${label} 이 없다`);
  process.exit(1);
}

const hex = (c: { r: number; g: number; b: number; a: number }, opacity = 1) => {
  const h = [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const a = c.a * opacity;
  return a < 1 ? `#${h} ${Math.round(a * 100)}%` : `#${h}`;
};
const paints = (list: Raw['fills']) => {
  const vis = (list ?? []).filter((p) => p.visible !== false);
  if (vis.length === 0) return null;
  return vis.map((p) => (p.type === 'SOLID' && p.color ? hex(p.color, p.opacity ?? 1) : p.type)).join(' + ');
};
const r = (n: number | undefined) => String(Math.round((n ?? 0) * 100) / 100);
const SIZING: Record<string, string> = { FIXED: '고정', HUG: '내용에 맞춤', FILL: '채우기' };

function describe(n: Raw, depth: number, out: string[]) {
  if (n.visible === false) return;
  const parts: string[] = [];
  const bb = n.absoluteBoundingBox;
  const w = n.layoutSizingHorizontal;
  const h = n.layoutSizingVertical;
  if (n.type === 'TEXT') {
    const s = n.style ?? {};
    parts.push(`글자 "${(n.characters ?? '').replace(/\n/g, '⏎')}"`);
    parts.push(`${r(s.fontSize)}/${r(s.fontWeight)}`);
    parts.push(s.lineHeightUnit === 'PIXELS' ? `줄 높이 ${r(s.lineHeightPx)}` : `줄 높이 ${s.lineHeightUnit ?? '-'}`);
    parts.push(`정렬 ${s.textAlignHorizontal ?? '-'}`);
    parts.push(`폭 ${w ? SIZING[w] ?? w : s.textAutoResize === 'WIDTH_AND_HEIGHT' ? '내용에 맞춤' : (s.textAutoResize ?? '-')}`);
  } else {
    const isFrame = ['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP', 'SECTION', 'COMPONENT_SET'].includes(n.type);
    parts.push(isFrame ? '프레임' : n.type === 'RECTANGLE' ? '사각형' : n.type);
    if (n.layoutMode === 'VERTICAL' || n.layoutMode === 'HORIZONTAL') {
      parts.push(n.layoutMode === 'VERTICAL' ? '세로' : '가로');
      parts.push(`간격 ${r(n.itemSpacing)}`);
      const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(r);
      parts.push(`패딩 ${pad.every((v) => v === pad[0]) ? pad[0] : pad.join('/')}`);
      parts.push(`정렬 ${n.primaryAxisAlignItems ?? 'MIN'}/${n.counterAxisAlignItems ?? 'MIN'}`);
    } else if (isFrame) {
      parts.push('오토 레이아웃 없음');
    }
    if (w) parts.push(`폭 ${SIZING[w] ?? w}${w === 'FIXED' && bb ? ` ${r(bb.width)}` : ''}`);
    else if (bb && !isFrame) parts.push(`폭 ${r(bb.width)}`);
    if (h) parts.push(`높이 ${SIZING[h] ?? h}${h === 'FIXED' && bb ? ` ${r(bb.height)}` : ''}`);
    else if (bb && !isFrame) parts.push(`높이 ${r(bb.height)}`);
    if (n.cornerRadius) parts.push(`모서리 ${r(n.cornerRadius)}`);
  }
  const fill = paints(n.fills);
  if (fill) parts.push(n.type === 'TEXT' ? `색 ${fill}` : `칠 ${fill}`);
  const stroke = paints(n.strokes);
  if (stroke && (n.strokeWeight ?? 0) > 0) {
    parts.push(`선 ${stroke} ${r(n.strokeWeight)} ${n.strokeAlign ?? 'INSIDE'}`);
    if (n.layoutMode === 'VERTICAL' || n.layoutMode === 'HORIZONTAL') parts.push(n.strokesIncludedInLayout ? '선 배치 포함' : '선 배치 제외');
  }
  if (n.opacity !== undefined && n.opacity < 1) parts.push(`불투명도 ${Math.round(n.opacity * 100)}%`);
  if (n.layoutPositioning === 'ABSOLUTE') parts.push('절대 위치');
  out.push(`${'  '.repeat(depth)}${n.name} — ${parts.join(' · ')}`);
  for (const c of n.children ?? []) describe(c, depth + 1, out);
}

const lines: string[] = [];
describe(root, 0, lines);
console.log(lines.join('\n'));
