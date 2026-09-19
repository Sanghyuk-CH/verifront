import type { Rgb } from 'culori';

/**
 * 스냅숏(GET /v1/files/:key/nodes 응답)을 판정에 쓸 모양으로 옮긴다.
 *
 * 값은 전부 해석된 값이다. 변수가 바인딩돼 있어도 응답에는 변수 id 만 온다.
 * id 를 이름으로 바꾸는 Variables 엔드포인트는 Enterprise 플랜 전용이라 쓰지 않는다.
 * 이름이 없어도 판정은 선다. 해석된 값을 토큰 값과 대조하면 된다.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Kind = 'frame' | 'text' | 'shape';

export interface Paint {
  rgb: Rgb;
  /** 변수 바인딩이 있었는가. 이름은 모른다 */
  bound: boolean;
}

export interface DesignNode {
  id: string;
  name: string;
  type: string;
  kind: Kind;
  /** 루트 프레임 기준 좌표. absoluteBoundingBox 에서 루트의 x, y 를 뺐다 */
  box: Box;
  children: DesignNode[];
  parent: DesignNode | null;
  text: string | null;
  layout: {
    mode: 'VERTICAL' | 'HORIZONTAL';
    itemSpacing: number;
    /** top, right, bottom, left */
    padding: [number, number, number, number];
    /** false 면 선이 배치에 끼지 않는다. CSS 의 border 는 항상 낀다 */
    strokesIncludedInLayout: boolean;
  } | null;
  /** 오토 레이아웃 안에서 absolute 로 빠진 자식 */
  absolute: boolean;
  /** 보이는 단색 채우기가 정확히 하나일 때만 값이 있다. 여러 겹이면 'complex' */
  fill: Paint | 'complex' | null;
  stroke: (Paint & { weight: number; align: string }) | 'complex' | null;
  /** 이 노드와 조상 중 하나라도 레이어 불투명도가 1 미만이면 true */
  translucent: boolean;
  font: {
    size: number;
    weight: number;
    lineHeightPx: number | null;
    lineHeightUnit: string | null;
    /** LEFT, RIGHT, CENTER, JUSTIFIED */
    align: string;
    /** 폭이 글자에 맞춰 줄어든다. 이때만 글자 상자의 양 옆 변이 화면에 보이는 변이다 */
    autoWidth: boolean;
  } | null;
}

interface RawPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a: number };
  boundVariables?: Record<string, unknown>;
}

interface RawNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: RawNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  characters?: string;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  strokesIncludedInLayout?: boolean;
  layoutPositioning?: string;
  fills?: RawPaint[];
  strokes?: RawPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  opacity?: number;
  layoutSizingHorizontal?: string;
  style?: {
    fontSize?: number;
    fontWeight?: number;
    lineHeightPx?: number;
    lineHeightUnit?: string;
    textAlignHorizontal?: string;
    textAutoResize?: string;
  };
}

export interface Snapshot {
  source: string;
  pulledAt: string;
  file: { name: string; version: string; lastModified: string };
  index: Record<string, string>;
  nodes: Record<string, { document: RawNode } | null>;
}

const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

/** 피그마 색은 0~1 실수다. 페인트 불투명도는 색의 알파와 곱해진다 */
function paintOf(list: RawPaint[] | undefined): Paint | 'complex' | null {
  const visible = (list ?? []).filter((p) => p.visible !== false && (p.opacity ?? 1) > 0);
  if (visible.length === 0) return null;
  if (visible.length > 1 || visible[0]!.type !== 'SOLID' || !visible[0]!.color) return 'complex';
  const p = visible[0]!;
  const c = p.color!;
  return {
    rgb: { mode: 'rgb', r: c.r, g: c.g, b: c.b, alpha: c.a * (p.opacity ?? 1) },
    bound: !!p.boundVariables && Object.keys(p.boundVariables).length > 0,
  };
}

function build(raw: RawNode, origin: { x: number; y: number }, parent: DesignNode | null, parentTranslucent: boolean): DesignNode | null {
  if (raw.visible === false) return null;
  const bb = raw.absoluteBoundingBox;
  if (!bb) return null;

  const kind: Kind = raw.type === 'TEXT' ? 'text' : CONTAINERS.has(raw.type) ? 'frame' : 'shape';
  const mode = raw.layoutMode === 'VERTICAL' || raw.layoutMode === 'HORIZONTAL' ? raw.layoutMode : null;
  const translucent = parentTranslucent || (raw.opacity ?? 1) < 1;

  const stroke = paintOf(raw.strokes);
  const node: DesignNode = {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    kind,
    box: { x: bb.x - origin.x, y: bb.y - origin.y, w: bb.width, h: bb.height },
    children: [],
    parent,
    text: kind === 'text' ? (raw.characters ?? '') : null,
    layout: mode
      ? {
          mode,
          itemSpacing: raw.itemSpacing ?? 0,
          padding: [raw.paddingTop ?? 0, raw.paddingRight ?? 0, raw.paddingBottom ?? 0, raw.paddingLeft ?? 0],
          strokesIncludedInLayout: raw.strokesIncludedInLayout ?? false,
        }
      : null,
    absolute: raw.layoutPositioning === 'ABSOLUTE',
    fill: paintOf(raw.fills),
    stroke:
      stroke && stroke !== 'complex' && (raw.strokeWeight ?? 0) > 0
        ? { ...stroke, weight: raw.strokeWeight ?? 0, align: raw.strokeAlign ?? 'INSIDE' }
        : stroke === 'complex'
          ? 'complex'
          : null,
    translucent,
    font:
      kind === 'text' && raw.style
        ? {
            size: raw.style.fontSize ?? 0,
            weight: raw.style.fontWeight ?? 400,
            lineHeightPx: raw.style.lineHeightPx ?? null,
            lineHeightUnit: raw.style.lineHeightUnit ?? null,
            align: raw.style.textAlignHorizontal ?? 'LEFT',
            autoWidth: raw.style.textAutoResize === 'WIDTH_AND_HEIGHT' || raw.layoutSizingHorizontal === 'HUG',
          }
        : null,
  };
  if (kind === 'frame' || raw.children) {
    for (const c of raw.children ?? []) {
      const k = build(c, origin, node, translucent);
      if (k) node.children.push(k);
    }
  }
  return node;
}

export function loadDesign(snapshot: Snapshot, label: string): DesignNode {
  const id = snapshot.index[label] ?? label;
  const entry = snapshot.nodes[id];
  if (!entry) throw new Error(`스냅숏에 ${label} 이 없다. index: ${Object.keys(snapshot.index).join(', ')}`);
  const bb = entry.document.absoluteBoundingBox;
  if (!bb) throw new Error(`${label} 에 좌표가 없다. 숨김 노드인지 확인한다`);
  const root = build(entry.document, { x: bb.x, y: bb.y }, null, false);
  if (!root) throw new Error(`${label} 이 숨김 상태다`);
  return root;
}

export function walkDesign(n: DesignNode, fn: (n: DesignNode) => void): void {
  fn(n);
  for (const c of n.children) walkDesign(c, fn);
}

/** 채우기도 선도 없는 프레임. 배치만 하는 묶음이라 화면에 상자로 남지 않을 수 있다 */
export function isPureGroup(n: DesignNode): boolean {
  return n.kind === 'frame' && n.fill === null && n.stroke === null;
}

/** 이 노드 아래에 보이는 잎(글자, 도형)이 몇 개인가 */
export function leafCount(n: DesignNode): number {
  if (n.kind !== 'frame') return 1;
  return n.children.reduce((s, c) => s + leafCount(c), 0);
}

export function pathName(n: DesignNode): string {
  const parts: string[] = [];
  let cur: DesignNode | null = n;
  while (cur) {
    // 형제 중 같은 이름이 있으면 순번을 붙인다. 카드 세 장이 모두 Card 다
    const sibs = cur.parent ? cur.parent.children.filter((c) => c.name === cur!.name) : [];
    parts.unshift(sibs.length > 1 ? `${cur.name}#${sibs.indexOf(cur) + 1}` : cur.name);
    cur = cur.parent;
  }
  return parts.join(' / ');
}
