/**
 * 검사기 자가 검증용 합성 스냅숏을 만든다. 실제 시안이 아니다.
 *
 *   npx tsx scripts/make-design-fixture.ts > fixtures/figma/card.json
 *
 * 모양은 GET /v1/files/:key/nodes 응답을 따른다. 좌표는 오토 레이아웃 규칙대로 계산한다.
 *   세로 배치: 자식을 위에서부터 쌓고 사이에 itemSpacing 을 둔다
 *   가로 배치: 자식을 왼쪽부터 늘어놓고 위쪽에 붙인다
 *   strokesIncludedInLayout 이 true 면 선 두께만큼 안쪽으로 밀린다
 * 글자 폭은 폰트가 정하는데 여기서는 임의의 수를 쓴다. 판정은 폭이 아니라 간격을 본다.
 */

type Hex = string;
interface Spec {
  name: string;
  type?: 'FRAME' | 'TEXT' | 'RECTANGLE';
  layout?: 'VERTICAL' | 'HORIZONTAL';
  gap?: number;
  pad?: [number, number, number, number];
  fill?: Hex;
  stroke?: Hex;
  strokeIn?: boolean;
  radius?: number;
  width?: number | 'FILL' | 'HUG';
  height?: number;
  text?: string;
  size?: number;
  weight?: number;
  lh?: number;
  lines?: number;
  textW?: number;
  kids?: Spec[];
}

let seq = 0;
const rgb = (hex: Hex) => {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
};
const solid = (hex: Hex) => [{ blendMode: 'NORMAL', type: 'SOLID', color: rgb(hex) }];

interface Placed {
  node: Record<string, unknown>;
  w: number;
  h: number;
}

function place(s: Spec, x: number, y: number, availW: number): Placed {
  const id = `1:${++seq}`;
  const type = s.type ?? 'FRAME';
  const base: Record<string, unknown> = { id, name: s.name, type, scrollBehavior: 'SCROLLS', blendMode: 'PASS_THROUGH' };

  if (type === 'TEXT') {
    const w = s.width === 'FILL' ? availW : (s.textW ?? 40);
    const h = (s.lines ?? 1) * (s.lh ?? 20);
    return {
      w,
      h,
      node: {
        ...base,
        absoluteBoundingBox: { x, y, width: w, height: h },
        fills: solid(s.fill ?? '#000000'),
        strokes: [],
        strokeWeight: 1,
        strokeAlign: 'OUTSIDE',
        characters: s.text ?? '',
        style: {
          fontFamily: 'Pretendard',
          fontPostScriptName: null,
          fontWeight: s.weight ?? 400,
          fontSize: s.size ?? 14,
          textAlignHorizontal: 'LEFT',
          textAlignVertical: 'TOP',
          letterSpacing: 0,
          lineHeightPx: s.lh ?? 20,
          lineHeightPercentFontSize: ((s.lh ?? 20) / (s.size ?? 14)) * 100,
          lineHeightUnit: 'PIXELS',
          textAutoResize: s.width === 'FILL' ? 'HEIGHT' : 'WIDTH_AND_HEIGHT',
        },
        layoutAlign: 'INHERIT',
        layoutGrow: 0,
        layoutSizingHorizontal: s.width === 'FILL' ? 'FILL' : 'HUG',
        layoutSizingVertical: 'HUG',
      },
    };
  }

  if (type === 'RECTANGLE') {
    const w = s.width === 'FILL' ? availW : (s.width as number);
    const h = s.height ?? 1;
    return {
      w,
      h,
      node: {
        ...base,
        absoluteBoundingBox: { x, y, width: w, height: h },
        fills: s.fill ? solid(s.fill) : [],
        strokes: [],
        strokeWeight: 1,
        strokeAlign: 'INSIDE',
        layoutSizingHorizontal: s.width === 'FILL' ? 'FILL' : 'FIXED',
        layoutSizingVertical: 'FIXED',
      },
    };
  }

  const [pt, pr, pb, pl] = s.pad ?? [0, 0, 0, 0];
  const sw = s.stroke && s.strokeIn ? 1 : 0;
  const gap = s.gap ?? 0;
  const fixedW = typeof s.width === 'number' ? s.width : s.width === 'FILL' ? availW : null;
  const kids: Placed[] = [];
  let w: number;
  let h: number;

  if (s.layout === 'VERTICAL') {
    const innerW = fixedW !== null ? fixedW - pl - pr - 2 * sw : NaN;
    let cy = y + sw + pt;
    for (const k of s.kids ?? []) {
      const p = place(k, x + sw + pl, cy, innerW);
      kids.push(p);
      cy += p.h + gap;
    }
    const contentH = kids.length ? cy - gap - (y + sw + pt) : 0;
    h = contentH + pt + pb + 2 * sw;
    w = fixedW ?? Math.max(0, ...kids.map((k) => k.w)) + pl + pr + 2 * sw;
  } else {
    let cx = x + sw + pl;
    for (const k of s.kids ?? []) {
      const p = place(k, cx, y + sw + pt, NaN);
      kids.push(p);
      cx += p.w + gap;
    }
    const contentW = kids.length ? cx - gap - (x + sw + pl) : 0;
    w = fixedW ?? contentW + pl + pr + 2 * sw;
    h = Math.max(0, ...kids.map((k) => k.h)) + pt + pb + 2 * sw;
  }

  return {
    w,
    h,
    node: {
      ...base,
      children: kids.map((k) => k.node),
      absoluteBoundingBox: { x, y, width: w, height: h },
      fills: s.fill ? solid(s.fill) : [],
      strokes: s.stroke ? solid(s.stroke) : [],
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      ...(s.radius !== undefined ? { cornerRadius: s.radius } : {}),
      clipsContent: false,
      layoutMode: s.layout ?? 'NONE',
      itemSpacing: gap,
      paddingTop: pt,
      paddingRight: pr,
      paddingBottom: pb,
      paddingLeft: pl,
      primaryAxisAlignItems: 'MIN',
      counterAxisAlignItems: 'MIN',
      strokesIncludedInLayout: !!s.strokeIn,
      layoutSizingHorizontal: s.width === 'FILL' ? 'FILL' : typeof s.width === 'number' ? 'FIXED' : 'HUG',
      layoutSizingVertical: 'HUG',
      effects: [],
    },
  };
}

const C = {
  surface: '#ffffff',
  border: '#e5e7eb',
  text: '#111827',
  muted: '#6b7280',
  primary: '#3b82f6',
  primaryFg: '#ffffff',
  success: '#16a34a',
  successSoft: '#dcfce7',
  warning: '#ca8a04',
  warningSoft: '#fef9c3',
  disabled: '#d1d5db',
  disabledFg: '#9ca3af',
};

const cards = [
  { badge: '진행중', bg: C.primary, fg: C.primaryFg, bw: 36, title: '검색 필터 개선', desc: '검색 결과에 기간과 작성자 필터를 추가합니다. 필터 상태는 주소에 남깁니다.', meta: '김하늘 · 9월 3일 수정', disabled: false },
  { badge: '완료', bg: C.successSoft, fg: C.success, bw: 24, title: '알림 설정 화면', desc: '알림 종류별로 켜고 끌 수 있게 했습니다. 기본값은 모두 켜짐입니다.', meta: '박서준 · 8월 21일 수정', disabled: false },
  { badge: '보류', bg: C.warningSoft, fg: C.warning, bw: 24, title: '빌드 캐시 정리', desc: '캐시 키 규칙이 정해지면 다시 시작합니다. 지금은 수동으로 비웁니다.', meta: '이도윤 · 7월 30일 수정', disabled: true },
];

const label = (text: string, fill: Hex, textW: number, size = 14, weight = 500, lh = 20): Spec => ({
  name: 'Label',
  type: 'TEXT',
  text,
  fill,
  textW,
  size,
  weight,
  lh,
});

const spec: Spec = {
  name: 'Card list',
  layout: 'VERTICAL',
  gap: 16,
  width: 560,
  kids: cards.map((c) => ({
    name: 'Card',
    layout: 'VERTICAL',
    width: 'FILL',
    pad: [20, 20, 20, 20],
    gap: 16,
    fill: C.surface,
    stroke: C.border,
    strokeIn: true,
    radius: 12,
    kids: [
      {
        name: 'Header',
        layout: 'VERTICAL',
        width: 'FILL',
        gap: 8,
        kids: [
          { name: 'Badge', layout: 'HORIZONTAL', pad: [4, 8, 4, 8], fill: c.bg, radius: 999, kids: [label(c.badge, c.fg, c.bw, 12, 600, 16)] },
          { name: 'Title', type: 'TEXT', text: c.title, fill: C.text, width: 'FILL', size: 16, weight: 600, lh: 24 },
        ],
      },
      {
        name: 'Body',
        layout: 'VERTICAL',
        width: 'FILL',
        gap: 4,
        kids: [
          { name: 'Description', type: 'TEXT', text: c.desc, fill: C.muted, width: 'FILL', size: 14, lh: 20, lines: 2 },
          { name: 'Meta', type: 'TEXT', text: c.meta, fill: C.muted, width: 'FILL', size: 13, lh: 20 },
        ],
      },
      { name: 'Divider', type: 'RECTANGLE', width: 'FILL', height: 1, fill: C.border },
      {
        name: 'Actions',
        layout: 'HORIZONTAL',
        gap: 8,
        kids: [
          { name: 'Button/Primary', layout: 'HORIZONTAL', pad: [8, 16, 8, 16], fill: C.primary, radius: 6, kids: [label('열기', C.primaryFg, 28)] },
          c.disabled
            ? { name: 'Button/Secondary', layout: 'HORIZONTAL', pad: [8, 16, 8, 16], fill: C.disabled, radius: 6, kids: [label('보관', C.disabledFg, 28)] }
            : { name: 'Button/Secondary', layout: 'HORIZONTAL', pad: [8, 16, 8, 16], fill: C.surface, stroke: C.border, strokeIn: true, radius: 6, kids: [label('보관', C.text, 28)] },
        ],
      },
    ],
  })),
};

// 루트를 캔버스 원점에서 떨어뜨려 둔다. 좌표를 루트 기준으로 옮기는지 확인하려는 것이다
const root = place(spec, 1200, -340, NaN);

const snapshot = {
  source: 'synthetic — scripts/make-design-fixture.ts',
  pulledAt: '2026-09-16T00:00:00.000Z',
  file: { name: 'verifront fixture', version: '0', lastModified: '2026-09-16T00:00:00Z', editorType: 'figma' },
  index: { 'card-list': '1:1' },
  nodes: { '1:1': { document: root.node, components: {}, componentSets: {}, schemaVersion: 0, styles: {} } },
};

console.log(JSON.stringify(snapshot, null, 2));
