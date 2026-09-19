import { chromium, type Browser } from 'playwright';
import type { Rgb } from 'culori';
import { formatHex } from 'culori';
import { normalize, sameRgb, sameAlpha, perceptualDistance } from './normalize.ts';
import { NEAR_THRESHOLD, type Token } from './check.ts';
import { EPS_RENDER, judgeSpacing, minStep, type SpaceToken, type SpacingVerdict } from './spacing.ts';
import { isPureGroup, leafCount, pathName, walkDesign, type Box, type DesignNode } from './figma.ts';

/**
 * 스케일 검사는 "이 값이 토큰인가" 를 묻는다. 시안 검사는 "이 자리의 값이 시안의 값인가" 를 묻는다.
 * 앞의 질문으로는 16px 이 들어갈 자리에 들어간 8px 을 잡지 못한다. 둘 다 토큰이기 때문이다.
 *
 * 판정은 두 단계다.
 *   짝짓기 — 피그마 노드마다 화면의 요소를 찾는다. 클래스 이름은 생성물마다 달라서 쓰지 않는다.
 *   대조 — 짝이 정해진 자리에서 여백과 색을 시안의 값과 맞춘다.
 *
 * 여백은 좌표로 잰다. 시안도 좌표(absoluteBoundingBox)로 읽는다.
 * 피그마의 패딩 값을 CSS 의 padding 선언과 바로 맞추지 않는 이유는 두 도구의 선이 다르게 배치되기 때문이다.
 * 피그마는 기본값에서 선이 배치에 끼지 않고 CSS 의 border 는 항상 낀다.
 */
export type DesignVerdict =
  /** 시안과 같다 */
  | 'ok'
  /** 여백은 최소 스텝의 절반 안, 색은 ΔE00 1.0 안에서 어긋났다 */
  | 'near'
  /** 토큰이긴 한데 이 자리의 토큰이 아니다. 스케일 검사가 통과시키는 자리 */
  | 'wrong-token'
  /** 여백이 시안과도 스케일과도 맞지 않는다 */
  | 'off-scale'
  /** 두 노드의 순서나 배치 방향이 시안과 다르다. 간격은 판정하지 않는다 */
  | 'misplaced'
  /** 색이 시안과도 토큰과도 맞지 않는다 */
  | 'violation'
  /** 색은 같고 알파만 다르다 */
  | 'alpha-variant'
  /** 시안에 있는 선이 화면에 없다 */
  | 'missing'
  /** 시안의 노드에 짝이 되는 요소를 찾지 못했다 */
  | 'unmatched'
  /** 짝은 있지만 조건 밖이라 재지 않았다 */
  | 'unmeasurable';

export interface DesignFinding {
  node: string;
  target: string | null;
  prop: string;
  expected: string;
  actual: string | null;
  verdict: DesignVerdict;
  /** wrong-token 일 때 화면의 값이 해당하는 토큰 */
  token?: string;
  /** 여백 판정일 때 화면의 값만 스케일에 대 본 결과. 5편의 검사기가 이 자리에 낼 판정이다 */
  scale?: SpacingVerdict;
  note?: string;
}

export interface MatchStats {
  /** 짝을 찾아야 하는 노드. 글자, 도형, 채우기나 선이 있는 프레임 */
  visual: number;
  byText: number;
  byLift: number;
  byOrder: number;
  /** 요소가 아니라 이웃 요소의 테두리로 그려진 선 */
  byBorder: number;
  unmatched: number;
  /** 화면에 상자로 남지 않은 묶음 프레임 */
  flattened: number;
}

export interface DesignPair {
  node: string;
  type: string;
  /** 짝지어진 화면 요소. 풀어헤친 묶음이나 못 찾은 노드는 null */
  target: string | null;
  how: 'text' | 'lift' | 'order' | 'border' | 'flattened' | null;
}

export interface DesignResult {
  findings: DesignFinding[];
  match: MatchStats;
  pairs: DesignPair[];
}

export interface DesignOptions {
  root?: string | null;
  viewport?: { width: number; height: number };
  executablePath?: string;
}

/* ─────────────────────────────────────────────────────────────
 * 페이지 안에서 실행되는 짝짓기
 * ───────────────────────────────────────────────────────────── */

interface PNode {
  id: string;
  parent: string | null;
  kids: string[];
  kind: 'frame' | 'text' | 'shape';
  text: string | null;
  pure: boolean;
  leaves: number;
  hasText: boolean;
  /** 선처럼 얇은 도형. h 는 가로선, v 는 세로선 */
  line: 'h' | 'v' | null;
}

interface ElInfo {
  path: string;
  rect: { x: number; y: number; w: number; h: number };
  /** 일반 흐름 안의 인라인 레벨 요소. 옆 요소와의 거리에 사이 공백이 섞인다 */
  inlineInFlow: boolean;
  /**
   * 줄 상자가 이 요소의 마진 상자보다 위(아래)로 더 크다. 그 차이는 부모 글꼴의 half-leading 이라 폰트가 정한다.
   * 인라인 요소라고 다 빼지 않는다. 탐침으로 줄 상자를 재서 실제로 여백을 보탠 변만 뺀다.
   */
  leadTop: boolean;
  leadBottom: boolean;
  /** top, right, bottom, left */
  border: number[];
  borderColor: string[];
  padding: number[];
  /** 자신 또는 가장 가까운 조상의 불투명 배경 */
  bg: string;
  color: string;
  /** 자신이나 조상의 opacity 가 1 미만. 계산된 색이 화면의 색이 아니다 */
  dimmed: boolean;
  /** 짝지어진 요소 중 이 요소의 조상 */
  anc: number[];
}

interface PageResult {
  info: ElInfo[];
  map: Record<string, number>;
  how: Record<string, 'text' | 'lift' | 'order' | 'border'>;
  flattened: string[];
}

/**
 * 1. 글자 앵커 — 시안의 글자와 화면의 글자가 같으면 짝이다. 같은 글자가 여러 번 나오면 순서로 맞춘다.
 *    배지 라벨과 버튼 라벨은 명세가 고정한 글자라 생성물이 달라도 걸린다.
 *    카드 제목은 생성물마다 다른데 우연히 시안의 다른 카드 제목과 같을 수 있다. 그러면 앵커가 다른 카드에 붙는다.
 *    그래서 앵커를 받은 뒤 칠이나 선이 있는 프레임(카드, 배지, 버튼)마다 위에서부터 영역을 정한다.
 *    영역은 부모 영역 안에서 이 프레임의 앵커가 가장 많이 모인 요소다. 영역 밖에 떨어진 앵커는 뗀다.
 * 2. 끌어올리기 — 프레임은 짝지어진 자손들의 가장 가까운 공통 조상이다.
 *    짝이 요소 하나뿐이면 같은 글자만 품은 조상 중 배경이나 테두리가 있는 가장 바깥 요소로 올린다.
 *    <button><span>열기</span></button> 에서 버튼 프레임은 span 이 아니라 button 이다.
 * 3. 순서 채우기 — 짝을 찾은 프레임 안에서 남은 자식을 문서 순서대로 맞춘다.
 *    채우기도 선도 없는 묶음 프레임은 화면에 상자가 없을 수 있어서 풀어헤친 뒤 맞춘다.
 *    글자가 있는 노드는 글자가 있는 요소와만, 없는 노드는 없는 요소와만 짝짓는다.
 * 4. 테두리 선 — 짝이 남지 않은 얇은 선은 앞뒤 이웃 요소의 테두리에서 찾는다.
 *    구분선을 요소로 두지 않고 아래 요소의 border-top 으로 그리는 구현이 흔하다.
 */
function matchPage(arg: { nodes: PNode[]; rootId: string; root: string | null; eps: number }): PageResult {
  const { nodes, rootId, eps } = arg;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const rootEl = arg.root ? document.querySelector(arg.root) : document.body;
  if (!rootEl) throw new Error(`root 를 찾지 못했다: ${arg.root}`);

  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META']);
  const shown = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const all = [rootEl, ...rootEl.querySelectorAll('*')].filter((el) => !SKIP.has(el.tagName) && shown(el));
  const present = new Set(all);
  const own = (el: Element) =>
    norm(
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? '')
        .join(' '),
    );
  const full = (el: Element) => norm(el.textContent ?? '');

  const map = new Map<string, Element>();
  const how = new Map<string, 'text' | 'lift' | 'order' | 'border'>();
  const edges = new Map<string, { el: Element; side: 'top' | 'right' | 'bottom' | 'left' }>();
  const bw = (el: Element, side: string) => {
    const cs = getComputedStyle(el);
    return cs.getPropertyValue(`border-${side}-style`) === 'none' ? 0 : parseFloat(cs.getPropertyValue(`border-${side}-width`)) || 0;
  };
  const clear = (v: string) => v === 'transparent' || /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)$/.test(v);
  const decorated = (el: Element) =>
    !clear(getComputedStyle(el).backgroundColor) || ['top', 'right', 'bottom', 'left'].some((s) => bw(el, s) > 0);
  const pre: PNode[] = [];
  const visit = (id: string) => {
    const n = byId.get(id)!;
    pre.push(n);
    n.kids.forEach(visit);
  };
  visit(rootId);

  // 1. 글자 앵커
  const groups = new Map<string, PNode[]>();
  for (const n of pre) {
    if (n.kind !== 'text' || !n.text) continue;
    const t = norm(n.text);
    if (!t) continue;
    groups.set(t, [...(groups.get(t) ?? []), n]);
  }
  for (const [t, fig] of groups) {
    let cands = all.filter((el) => own(el) === t);
    if (cands.length === 0) cands = all.filter((el) => full(el) === t && ![...el.children].some((c) => full(c) === t));
    if (cands.length !== fig.length) continue;
    fig.forEach((n, i) => {
      map.set(n.id, cands[i]!);
      how.set(n.id, 'text');
    });
  }

  const lca = (els: Element[]): Element | null => {
    let a: Element | null = els[0] ?? null;
    for (const e of els.slice(1)) while (a && !a.contains(e)) a = a.parentElement;
    return a;
  };
  const mappedDescIds = (id: string): string[] => {
    const out: string[] = [];
    const rec = (x: string) => {
      for (const k of byId.get(x)!.kids) {
        if (map.has(k)) out.push(k);
        rec(k);
      }
    };
    rec(id);
    return out;
  };
  const mappedDesc = (id: string): Element[] => [...new Set(mappedDescIds(id).map((k) => map.get(k)!))];
  const inSubtree = (x: string, top: string): boolean => {
    for (let p: string | null = x; p; p = byId.get(p)!.parent) if (p === top) return true;
    return false;
  };

  // 1-2. 영역 가르기 — 위에서부터
  const isBox = (n: PNode) => n.kind === 'frame' && !n.pure;
  const boxAncestor = (id: string): string | null => {
    for (let p = byId.get(id)!.parent; p; p = byId.get(p)!.parent) if (isBox(byId.get(p)!)) return p;
    return null;
  };
  const anchorsUnder = (id: string | null): string[] =>
    (id ? pre.filter((n) => n.id !== id && inSubtree(n.id, id)) : pre).map((n) => n.id).filter((k) => how.get(k) === 'text');
  const region = new Map<string, Element>();
  for (const n of pre) {
    if (!isBox(n)) continue;
    const A = boxAncestor(n.id);
    const R = (A && region.get(A)) || rootEl;
    const mine = anchorsUnder(n.id);
    if (mine.length === 0) continue;
    const others = anchorsUnder(A).filter((k) => !inSubtree(k, n.id));
    let cur = R;
    for (;;) {
      const tally = new Map<Element, number>();
      for (const k of mine) {
        const c = [...cur.children].find((x) => x.contains(map.get(k)!));
        if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
      }
      const ranked = [...tally].sort((a, b) => b[1] - a[1]);
      if (ranked.length === 0 || (ranked.length > 1 && ranked[0]![1] === ranked[1]![1])) break;
      const [win, cnt] = ranked[0]!;
      cur = win;
      // 이 요소 안에 남의 앵커가 이 프레임의 앵커보다 적으면 여기가 이 프레임의 영역이다
      if (others.filter((k) => map.has(k) && win.contains(map.get(k)!)).length < cnt) break;
    }
    region.set(n.id, cur);
    for (const k of mine) {
      if (cur.contains(map.get(k)!)) continue;
      map.delete(k);
      how.delete(k);
    }
  }

  // 2. 끌어올리기 — 자식부터
  const lift = (id: string) => {
    const n = byId.get(id)!;
    n.kids.forEach(lift);
    if (n.kind !== 'frame' || map.has(id)) return;
    const els = mappedDesc(id);
    if (els.length === 0) return;
    let e = lca(els);
    if (!e || !(e === rootEl || rootEl.contains(e))) return;
    if (els.length === 1) {
      // 짝지어진 요소가 하나뿐이면 어느 조상이 이 프레임인지 알 수 없다. 잎이 하나인 프레임만 받는다
      if (n.leaves !== 1) return;
      const t = full(e);
      const chain: Element[] = [];
      for (let c: Element | null = e; c && (c === rootEl || rootEl.contains(c)); c = c.parentElement) {
        if (full(c) !== t || (t === '' && c !== e && c.children.length !== 1)) break;
        chain.push(c);
        if (c === rootEl) break;
      }
      if (!n.pure) e = [...chain].reverse().find(decorated) ?? e;
    }
    map.set(id, e);
    how.set(id, 'lift');
  };
  lift(rootId);

  // 조상 프레임과 같은 요소에 붙은 프레임은 화면에 따로 상자가 없는 것이다. 칠이 없는 쪽을 뗀다
  const mappedFrameAncestor = (id: string): string | null => {
    let p = byId.get(id)!.parent;
    while (p) {
      if (map.has(p) && byId.get(p)!.kind === 'frame') return p;
      p = byId.get(p)!.parent;
    }
    return null;
  };
  for (const n of pre) {
    if (n.kind !== 'frame' || !map.has(n.id)) continue;
    const a = mappedFrameAncestor(n.id);
    if (!a || map.get(a) !== map.get(n.id)) continue;
    const drop = !n.pure && byId.get(a)!.pure ? a : n.id;
    map.delete(drop);
    how.delete(drop);
  }

  // 3. 순서 채우기
  const domKids = (e: Element): Element[] => {
    const out: Element[] = [];
    for (const c of e.children) {
      if (SKIP.has(c.tagName)) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'contents') {
        out.push(...domKids(c));
        continue;
      }
      if (!present.has(c)) continue;
      if (cs.position === 'absolute' || cs.position === 'fixed') continue;
      out.push(c);
    }
    return out;
  };
  const kindOk = (n: PNode, el: Element) => {
    const t = full(el) !== '';
    if (n.kind === 'text') return t;
    if (n.kind === 'shape') return !t;
    return n.hasText === t;
  };
  const flattened = new Set<string>();

  const expand = (id: string, dk: Element[]): string[] => {
    const n = byId.get(id)!;
    if (map.has(id) || n.kind !== 'frame') return [id];
    // 짝지어진 자손이 전부 한 자식 요소 안에 있으면 그 요소가 이 묶음의 상자다
    const ds = mappedDesc(id);
    if (ds.length > 0) {
      const holders = dk.filter((d) => ds.every((m) => d === m || d.contains(m)));
      if (holders.length === 1 && !ds.includes(holders[0]!)) {
        map.set(id, holders[0]!);
        how.set(id, 'lift');
        return [id];
      }
    }
    if (!n.pure) return [id];
    flattened.add(id);
    return n.kids.flatMap((k) => expand(k, dk));
  };

  const aligned = new Set<string>();
  const align = (id: string) => {
    if (aligned.has(id)) return;
    const n = byId.get(id)!;
    const e = map.get(id);
    if (!e || n.kind !== 'frame') return;
    aligned.add(id);
    const dk = domKids(e);
    const seq = n.kids.flatMap((k) => expand(k, dk));
    const posOf = (fid: string) => {
      const m = map.get(fid);
      return m ? dk.findIndex((d) => d === m || d.contains(m)) : -1;
    };
    let di = 0;
    let pending: string[] = [];
    const flush = (end: number) => {
      let p = di;
      for (const fid of pending) {
        const fn = byId.get(fid)!;
        while (p < end && !kindOk(fn, dk[p]!)) p++;
        if (p >= end) break;
        map.set(fid, dk[p]!);
        how.set(fid, 'order');
        p++;
      }
      pending = [];
    };
    for (const fid of seq) {
      const p = posOf(fid);
      if (p >= di) {
        flush(p);
        di = p + 1;
      } else if (!map.has(fid)) pending.push(fid);
    }
    flush(dk.length);

    // 4. 테두리 선. 선의 길이가 부모 안쪽 폭(높이)의 절반은 넘어야 구분선으로 본다. 버튼 테두리를 잡지 않으려는 것이다
    const ecs = getComputedStyle(e);
    const inner = {
      w: e.clientWidth - parseFloat(ecs.paddingLeft) - parseFloat(ecs.paddingRight),
      h: e.clientHeight - parseFloat(ecs.paddingTop) - parseFloat(ecs.paddingBottom),
    };
    const chain = (f: string): Element[] => {
      const m = map.get(f);
      const p = posOf(f);
      if (!m || p < 0) return [];
      const out: Element[] = [];
      for (let c: Element | null = m; c; c = c.parentElement) {
        out.unshift(c);
        if (c === dk[p]) break;
      }
      return out;
    };
    seq.forEach((fid, i) => {
      const ln = byId.get(fid)!.line;
      if (!ln || map.has(fid) || edges.has(fid)) return;
      const [before, after] = ln === 'h' ? (['bottom', 'top'] as const) : (['right', 'left'] as const);
      const long = (el: Element) => {
        const r = el.getBoundingClientRect();
        return ln === 'h' ? r.width >= inner.w / 2 : r.height >= inner.h / 2;
      };
      const next = seq.slice(i + 1).find((f) => posOf(f) >= 0);
      const prev = seq.slice(0, i).reverse().find((f) => posOf(f) >= 0);
      const hit =
        (next && chain(next).find((el) => bw(el, after) > 0 && long(el)) && { f: next, side: after }) ||
        (prev && chain(prev).find((el) => bw(el, before) > 0 && long(el)) && { f: prev, side: before }) ||
        null;
      if (!hit) return;
      const el = chain(hit.f).find((x) => bw(x, hit.side) > 0 && long(x))!;
      edges.set(fid, { el, side: hit.side });
      how.set(fid, 'border');
    });
    seq.forEach(align);
  };
  align(rootId);
  for (const n of pre) align(n.id);

  // 짝지어진 요소의 정보를 모은다
  const uniq = [...new Set(map.values())];
  const indexOf = new Map(uniq.map((el, i) => [el, i] as const));
  const px = (v: string) => parseFloat(v) || 0;
  const sig = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const cls = [...el.classList].sort().join('.');
    return cls ? `${tag}.${cls}` : tag;
  };
  const pathOf = (el: Element) => {
    if (el === document.body) return 'body';
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      const p: Element | null = cur.parentElement;
      const same = p ? [...p.children].filter((c) => sig(c) === sig(cur!)) : [];
      parts.unshift(same.length > 1 ? `${sig(cur)}:${same.indexOf(cur) + 1}` : sig(cur));
      cur = p;
    }
    return parts.join(' > ');
  };
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const dimmedOf = (el: Element) => {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (parseFloat(getComputedStyle(cur).opacity) < 1) return true;
    }
    return false;
  };
  // 사각형을 전부 먼저 읽는다. 탐침은 그다음에 넣는다
  const rects = uniq.map((el) => el.getBoundingClientRect());
  const info: ElInfo[] = uniq.map((el, i) => {
    const cs = getComputedStyle(el);
    const r = rects[i]!;
    const pd = el.parentElement ? getComputedStyle(el.parentElement).display : 'block';
    const inFlow = !/flex|grid/.test(pd);
    let bg = 'rgba(0, 0, 0, 0)';
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const b = getComputedStyle(cur).backgroundColor;
      if (!clear(b)) {
        bg = b;
        break;
      }
    }
    return {
      path: pathOf(el),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      inlineInFlow: inFlow && cs.display.startsWith('inline'),
      leadTop: false,
      leadBottom: false,
      border: SIDES.map((s) => bw(el, s)),
      borderColor: SIDES.map((s) => cs.getPropertyValue(`border-${s}-color`)),
      padding: SIDES.map((s) => px(cs.getPropertyValue(`padding-${s}`))),
      bg,
      color: cs.color,
      dimmed: dimmedOf(el),
      anc: [],
    };
  });

  /**
   * 줄 상자 탐침. 폭과 높이가 0 인 inline-block 을 요소 바로 뒤에 넣고 vertical-align 을 top, bottom 으로 바꿔 가며 잰다.
   * top 으로 정렬된 0 높이 상자의 위치가 줄 상자의 윗변이고 bottom 이 아랫변이다. 크기가 0 이라 줄 높이를 바꾸지 않는다.
   * 원자 인라인이 아닌 inline 요소는 상자 높이 자체가 글꼴 지표라 위아래 모두 뺀다.
   */
  const probe = (el: Element, va: 'top' | 'bottom') => {
    const p = document.createElement('span');
    p.style.cssText = `display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:${va}`;
    el.after(p);
    const y = p.getBoundingClientRect().top;
    p.remove();
    return y;
  };
  uniq.forEach((el, i) => {
    const e = info[i]!;
    if (!e.inlineInFlow) return;
    const cs = getComputedStyle(el);
    if (!/^inline-(block|flex|grid|table)$/.test(cs.display)) {
      e.leadTop = e.leadBottom = true;
      return;
    }
    const r = rects[i]!;
    e.leadTop = r.top - px(cs.marginTop) - probe(el, 'top') > eps;
    e.leadBottom = probe(el, 'bottom') - (r.bottom + px(cs.marginBottom)) > eps;
  });

  // 테두리로 그려진 선은 그 변의 띠를 하나의 요소처럼 다룬다
  const edgeIds = [...edges.keys()];
  for (const fid of edgeIds) {
    const { el, side } = edges.get(fid)!;
    const r = el.getBoundingClientRect();
    const w = bw(el, side);
    const c = getComputedStyle(el).getPropertyValue(`border-${side}-color`);
    const anc: number[] = [];
    for (let p: Element | null = el; p; p = p.parentElement) {
      const j = indexOf.get(p);
      if (j !== undefined) anc.push(j);
    }
    info.push({
      path: `${pathOf(el)} ::border-${side}`,
      rect:
        side === 'top'
          ? { x: r.left, y: r.top, w: r.width, h: w }
          : side === 'bottom'
            ? { x: r.left, y: r.bottom - w, w: r.width, h: w }
            : side === 'left'
              ? { x: r.left, y: r.top, w, h: r.height }
              : { x: r.right - w, y: r.top, w, h: r.height },
      inlineInFlow: false,
      leadTop: false,
      leadBottom: false,
      border: [0, 0, 0, 0],
      borderColor: [c, c, c, c],
      padding: [0, 0, 0, 0],
      bg: c,
      color: c,
      dimmed: dimmedOf(el),
      anc,
    });
  }
  uniq.forEach((el, i) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const j = indexOf.get(p);
      if (j !== undefined) info[i]!.anc.push(j);
    }
  });

  return {
    info,
    map: {
      ...Object.fromEntries([...map].map(([k, el]) => [k, indexOf.get(el)!])),
      ...Object.fromEntries(edgeIds.map((k, i) => [k, uniq.length + i])),
    },
    how: Object.fromEntries(how),
    flattened: [...flattened],
  };
}

/* ─────────────────────────────────────────────────────────────
 * 대조
 * ───────────────────────────────────────────────────────────── */

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => `${r3(n)}px`;

function hexOf(rgb: Rgb): string {
  const hex = formatHex(rgb);
  const a = rgb.alpha ?? 1;
  return a < 1 ? `${hex} / ${Math.round(a * 100)}%` : hex;
}

function tokenOfColor(rgb: Rgb, tokens: Token[]): Token | undefined {
  return tokens.find((t) => sameRgb(t.rgb, rgb) && sameAlpha(t.rgb, rgb));
}

function colorVerdict(exp: Rgb, raw: string, tokens: Token[]): { verdict: DesignVerdict; token?: string } {
  const n = normalize(raw);
  if (n.kind !== 'color') return { verdict: 'unmeasurable' };
  const act = n.rgb;
  if (sameRgb(exp, act) && sameAlpha(exp, act)) return { verdict: 'ok' };
  if (sameRgb(exp, act)) return { verdict: 'alpha-variant' };
  if (perceptualDistance(exp, act) < NEAR_THRESHOLD) return { verdict: 'near' };
  const t = tokenOfColor(act, tokens);
  if (t) return { verdict: 'wrong-token', token: t.name };
  return { verdict: 'violation' };
}

/**
 * 여백 판정. 5편에서 유도한 두 허용오차를 그대로 쓴다.
 * valuePart 는 화면의 거리에서 테두리를 뺀 값이다. 스케일에 올라 있는지는 이 값으로 묻는다.
 */
function spacingVerdict(
  expected: number,
  actual: number,
  valuePart: number,
  tokens: SpaceToken[],
): { verdict: DesignVerdict; token?: string; scale: SpacingVerdict } {
  const j = judgeSpacing(fmt(valuePart), tokens);
  const scale = j.verdict;
  const d = Math.abs(actual - expected);
  if (d <= EPS_RENDER) return { verdict: 'ok', scale };
  if (d < minStep(tokens) / 2) return { verdict: 'near', scale };
  if (j.verdict === 'ok') return { verdict: 'wrong-token', token: r3(valuePart) === 0 ? '0' : j.token, scale };
  return { verdict: 'off-scale', scale };
}

interface Span {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** 각 변을 정한 요소 */
  edge: { top: number; bottom: number; left: number; right: number };
}

export async function checkDesign(
  html: string,
  design: DesignNode,
  tokens: { color: Token[]; space: SpaceToken[] },
  opts: DesignOptions = {},
): Promise<DesignResult> {
  const all: DesignNode[] = [];
  walkDesign(design, (n) => all.push(n));
  const hasText = (n: DesignNode): boolean => n.kind === 'text' || n.children.some(hasText);
  const pnodes: PNode[] = all.map((n) => ({
    id: n.id,
    parent: n.parent?.id ?? null,
    kids: n.children.map((c) => c.id),
    kind: n.kind,
    text: n.text,
    pure: isPureGroup(n),
    leaves: leafCount(n),
    hasText: hasText(n),
    line:
      n.kind === 'shape' && n.children.length === 0
        ? n.box.h <= 2 && n.box.w > n.box.h * 4
          ? 'h'
          : n.box.w <= 2 && n.box.h > n.box.w * 4
            ? 'v'
            : null
        : null,
  }));

  const browser: Browser = await chromium.launch({
    executablePath: opts.executablePath,
    args: opts.executablePath ? ['--no-sandbox'] : [],
  });
  let page: PageResult;
  try {
    const p = await browser.newPage({ viewport: opts.viewport ?? { width: 1280, height: 900 } });
    await p.addInitScript(() => {
      (globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    });
    await p.setContent(html, { waitUntil: 'load' });
    await p.evaluate(() => {
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
    });
    page = await p.evaluate(matchPage, { nodes: pnodes, rootId: design.id, root: opts.root ?? null, eps: EPS_RENDER });
  } finally {
    await browser.close();
  }

  const flattened = new Set(page.flattened);
  const elOf = (n: DesignNode): ElInfo | null => {
    if (flattened.has(n.id)) return null;
    const i = page.map[n.id];
    return i === undefined ? null : page.info[i]!;
  };
  const idxOf = (n: DesignNode): number | null => (flattened.has(n.id) ? null : (page.map[n.id] ?? null));

  /**
   * 보이는 범위. 칠도 선도 없는 묶음은 상자가 보이지 않으니 자식들의 합집합으로 잰다.
   * 화면에서도 같다. 묶음에 짝지어진 요소가 패딩이나 테두리를 갖고 있어도 그 상자로 재지 않는다.
   * 시안의 묶음 상자는 내용에 맞춰 줄고 화면의 요소는 블록으로 차거나 패딩을 가져서 둘이 어긋나기 쉽다.
   */
  interface DSpan {
    box: Box;
    /** 각 변을 정한 노드 */
    edge: Record<'top' | 'right' | 'bottom' | 'left', DesignNode>;
  }
  const dspans = new Map<string, DSpan>();
  const dspan = (n: DesignNode): DSpan => {
    const hit = dspans.get(n.id);
    if (hit) return hit;
    let d: DSpan = { box: n.box, edge: { top: n, right: n, bottom: n, left: n } };
    const kids = isPureGroup(n) ? n.children.filter((k) => !k.absolute).map(dspan) : [];
    if (kids.length) {
      const pick = (f: (k: DSpan) => number, better: (a: number, b: number) => boolean, side: keyof DSpan['edge']) =>
        kids.reduce((a, b) => (better(f(b), f(a)) ? b : a)).edge[side];
      const x = Math.min(...kids.map((k) => k.box.x));
      const y = Math.min(...kids.map((k) => k.box.y));
      const r = Math.max(...kids.map((k) => k.box.x + k.box.w));
      const btm = Math.max(...kids.map((k) => k.box.y + k.box.h));
      const lt = (a: number, b: number) => a < b - 0.01;
      const gt = (a: number, b: number) => a > b + 0.01;
      d = {
        box: { x, y, w: r - x, h: btm - y },
        edge: {
          top: pick((k) => k.box.y, lt, 'top'),
          right: pick((k) => k.box.x + k.box.w, gt, 'right'),
          bottom: pick((k) => k.box.y + k.box.h, gt, 'bottom'),
          left: pick((k) => k.box.x, lt, 'left'),
        },
      };
    }
    dspans.set(n.id, d);
    return d;
  };
  /**
   * 글자 상자의 옆 변은 정렬된 쪽만 보인다. 왼쪽 정렬 글자의 오른쪽 변은 상자의 끝일 뿐 글자의 끝이 아니다.
   * 폭이 글자에 맞춰 줄어든 글자는 양쪽이 다 보인다.
   */
  const shows = (n: DesignNode, side: 'top' | 'right' | 'bottom' | 'left'): boolean => {
    if (n.kind !== 'text' || side === 'top' || side === 'bottom' || n.font?.autoWidth) return true;
    const a = n.font?.align ?? 'LEFT';
    return a === 'JUSTIFIED' ? side === 'left' : a === (side === 'left' ? 'LEFT' : 'RIGHT');
  };

  const spans = new Map<string, Span | null>();
  const spanOf = (n: DesignNode): Span | null => {
    if (spans.has(n.id)) return spans.get(n.id)!;
    const i = idxOf(n);
    const own = (): Span | null => {
      if (i === null) return null;
      const r = page.info[i]!.rect;
      return { top: r.y, bottom: r.y + r.h, left: r.x, right: r.x + r.w, edge: { top: i, bottom: i, left: i, right: i } };
    };
    const union = (): Span | null => {
      let s: Span | null = null;
      for (const c of n.children) {
        if (c.absolute) continue;
        const cs = spanOf(c);
        if (!cs) continue;
        if (!s) {
          s = { ...cs, edge: { ...cs.edge } };
          continue;
        }
        if (cs.top < s.top) [s.top, s.edge.top] = [cs.top, cs.edge.top];
        if (cs.bottom > s.bottom) [s.bottom, s.edge.bottom] = [cs.bottom, cs.edge.bottom];
        if (cs.left < s.left) [s.left, s.edge.left] = [cs.left, cs.edge.left];
        if (cs.right > s.right) [s.right, s.edge.right] = [cs.right, cs.edge.right];
      }
      return s;
    };
    const s = isPureGroup(n) ? (union() ?? own()) : (own() ?? union());
    spans.set(n.id, s);
    return s;
  };

  const findings: DesignFinding[] = [];
  const push = (f: DesignFinding) => findings.push(f);

  // 짝을 못 찾은 노드
  let visual = 0;
  const count = { text: 0, lift: 0, order: 0, border: 0 };
  for (const n of all) {
    const isVisual = n.kind !== 'frame' || !isPureGroup(n);
    if (!isVisual) continue;
    visual++;
    const how = page.how[n.id];
    if (how && !flattened.has(n.id)) {
      count[how]++;
      continue;
    }
    push({ node: pathName(n), target: null, prop: 'node', expected: n.type, actual: null, verdict: 'unmatched' });
  }

  // 여백 — 오토 레이아웃 자식 사이
  for (const F of all) {
    if (!F.layout) continue;
    const vertical = F.layout.mode === 'VERTICAL';
    const kids = F.children.filter((k) => !k.absolute);
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1]!;
      const b = kids[i]!;
      const da = dspan(a).box;
      const db = dspan(b).box;
      const expected = vertical ? db.y - (da.y + da.h) : db.x - (da.x + da.w);
      const sa = spanOf(a);
      const sb = spanOf(b);
      if (!sa || !sb) continue;
      const ea = vertical ? sa.edge.bottom : sa.edge.right;
      const eb = vertical ? sb.edge.top : sb.edge.left;
      const A = page.info[ea]!;
      const B = page.info[eb]!;
      const base = {
        node: `${pathName(a)} ↔ ${b.name}`,
        target: `${A.path} ↔ ${B.path}`,
        prop: vertical ? 'gap-y' : 'gap-x',
        expected: fmt(expected),
      };
      if (ea === eb || A.anc.includes(eb) || B.anc.includes(ea)) {
        push({ ...base, actual: null, verdict: 'unmeasurable', note: '두 노드가 화면에서 한 상자 안에 겹친다' });
        continue;
      }
      const actual = vertical ? sb.top - sa.bottom : sb.left - sa.right;
      // 배치가 시안과 다르면 간격은 의미가 없다. 순서가 반대이거나, 주축에서 겹치면서 교차축으로 떨어져 있는 경우다
      const E = EPS_RENDER;
      const reversed = vertical ? sb.top < sa.top - E : sb.left < sa.left - E;
      const across = vertical
        ? sb.top < sa.bottom - E && (sb.left >= sa.right - E || sa.left >= sb.right - E)
        : sb.left < sa.right - E && (sb.top >= sa.bottom - E || sa.top >= sb.bottom - E);
      if (expected >= 0 && (reversed || across)) {
        const back = vertical ? sa.top - sb.bottom : sa.left - sb.right;
        const note = reversed && back >= -E ? `순서가 시안과 반대다. 화면 순서로 잰 간격 ${fmt(back)}` : '시안과 배치 방향이 다르다';
        push({ ...base, actual: fmt(actual), verdict: 'misplaced', note });
        continue;
      }
      if (vertical ? A.leadBottom || B.leadTop : A.inlineInFlow || B.inlineInFlow) {
        const note = vertical ? '줄 상자가 여백을 보탠다. 부모 글꼴이 정하는 값이다' : '일반 흐름의 인라인 요소. 사이 공백이 섞인다';
        push({ ...base, actual: fmt(actual), verdict: 'unmeasurable', note });
        continue;
      }
      push({ ...base, actual: fmt(actual), ...spacingVerdict(expected, actual, actual, tokens.space) });
    }
  }

  /**
   * 여백 — 프레임 안쪽. 시안에서 자식이 패딩에 붙어 있는 변만 잰다. 정렬이 정한 변은 패딩이 아니다.
   * 칠도 선도 없는 프레임은 재지 않는다. 테두리가 보이지 않으니 안쪽 여백도 화면에 없다.
   * 피그마에서 내용에 맞춰 줄어든 묶음이 화면에서는 블록으로 꽉 차는 일이 흔하다.
   * 그 차이는 형제 사이 간격과 부모의 안쪽 여백으로 이미 잡힌다.
   */
  const SIDE = ['top', 'right', 'bottom', 'left'] as const;
  for (const F of all) {
    if (!F.layout || isPureGroup(F)) continue;
    const fi = idxOf(F);
    if (fi === null) continue;
    const fe = page.info[fi]!;
    const kids = F.children.filter((k) => !k.absolute);
    if (kids.length === 0) continue;
    const vertical = F.layout.mode === 'VERTICAL';
    const sw = F.layout.strokesIncludedInLayout && F.stroke && F.stroke !== 'complex' ? F.stroke.weight : 0;
    const gapTo = (kid: DesignNode, side: (typeof SIDE)[number]) => {
      const k = dspan(kid).box;
      return side === 'top'
        ? k.y - F.box.y
        : side === 'bottom'
          ? F.box.y + F.box.h - (k.y + k.h)
          : side === 'left'
            ? k.x - F.box.x
            : F.box.x + F.box.w - (k.x + k.w);
    };
    const attached = (kid: DesignNode, side: (typeof SIDE)[number]) =>
      Math.abs(gapTo(kid, side) - (F.layout!.padding[SIDE.indexOf(side)]! + sw)) <= 0.01;
    /**
     * 주축의 시작과 끝은 첫 자식과 마지막 자식이 정한다. 교차축은 패딩에 붙어 있고 그 변이 보이는 자식 중 첫 번째로 잰다.
     * 카드의 오른쪽 패딩은 폭을 채운 제목이 아니라 폭을 채운 구분선으로 잰다.
     */
    const cross = (side: (typeof SIDE)[number]) =>
      kids.find((k) => attached(k, side) && shows(dspan(k).edge[side], side) && spanOf(k)) ?? kids[0]!;
    const plan: Array<[(typeof SIDE)[number], DesignNode]> = vertical
      ? [['top', kids[0]!], ['bottom', kids[kids.length - 1]!], ['left', cross('left')], ['right', cross('right')]]
      : [['left', kids[0]!], ['right', kids[kids.length - 1]!], ['top', cross('top')], ['bottom', cross('bottom')]];
    for (const [side, kid] of plan) {
      const si = SIDE.indexOf(side);
      const expected = gapTo(kid, side);
      if (!attached(kid, side)) continue;
      const s = spanOf(kid);
      if (!s) continue;
      const ei = s.edge[side];
      const E = page.info[ei]!;
      // 프레임과 글자가 한 요소면 패딩을 비교하니 글자 변이 보이는지와 상관없다
      if (ei !== fi && !shows(dspan(kid).edge[side], side)) continue;
      const base = { node: `${pathName(F)} ▸ ${kid.name}`, target: fe.path, prop: `inset-${side}`, expected: fmt(expected) };
      let actual: number;
      let valuePart: number;
      if (ei === fi) {
        // 프레임과 그 안의 글자가 화면에서 한 요소다. 배지, 버튼
        actual = fe.border[si]! + fe.padding[si]!;
        valuePart = fe.padding[si]!;
      } else {
        if (!E.anc.includes(fi)) {
          push({ ...base, actual: null, verdict: 'unmeasurable', note: '자식이 화면에서 이 상자 밖에 있다' });
          continue;
        }
        const R = fe.rect;
        actual =
          side === 'top' ? s.top - R.y : side === 'bottom' ? R.y + R.h - s.bottom : side === 'left' ? s.left - R.x : R.x + R.w - s.right;
        valuePart = actual - fe.border[si]!;
        if ((side === 'top' && E.leadTop) || (side === 'bottom' && E.leadBottom)) {
          push({ ...base, actual: fmt(actual), verdict: 'unmeasurable', note: '줄 상자가 여백을 보탠다. 부모 글꼴이 정하는 값이다' });
          continue;
        }
      }
      push({ ...base, actual: fmt(actual), ...spacingVerdict(expected, actual, valuePart, tokens.space) });
    }
  }

  // 색
  for (const n of all) {
    const el = elOf(n);
    if (!el) continue;
    const name = pathName(n);
    const expLabel = (rgb: Rgb) => {
      const t = tokenOfColor(rgb, tokens.color);
      return t ? `${hexOf(rgb)} (${t.name})` : hexOf(rgb);
    };
    const judgeColor = (prop: string, exp: Rgb, raw: string) => {
      if (n.translucent || el.dimmed) {
        push({ node: name, target: el.path, prop, expected: expLabel(exp), actual: raw, verdict: 'unmeasurable', note: '불투명도가 1 미만이다' });
        return;
      }
      push({ node: name, target: el.path, prop, expected: expLabel(exp), actual: raw, ...colorVerdict(exp, raw, tokens.color) });
    };

    if (n.fill && n.fill !== 'complex') {
      judgeColor(n.kind === 'text' ? 'text-color' : 'fill', n.fill.rgb, n.kind === 'text' ? el.color : el.bg);
    }
    if (n.stroke && n.stroke !== 'complex') {
      const sides = el.border.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
      if (n.kind === 'shape' && !n.fill) {
        // 선 도구로 그린 구분선. 화면에서는 테두리이거나 배경일 수 있다
        judgeColor('line', n.stroke.rgb, sides.length ? el.borderColor[sides[0]!]! : el.bg);
      } else if (sides.length === 0) {
        push({ node: name, target: el.path, prop: 'stroke', expected: expLabel(n.stroke.rgb), actual: null, verdict: 'missing' });
      } else {
        for (const c of new Set(sides.map((i) => el.borderColor[i]!))) judgeColor('stroke', n.stroke.rgb, c);
      }
    }
  }

  const pairs: DesignPair[] = all.map((n) => {
    const i = idxOf(n);
    return {
      node: pathName(n),
      type: n.type,
      target: i === null ? null : page.info[i]!.path,
      how: flattened.has(n.id) ? 'flattened' : (page.how[n.id] ?? null),
    };
  });

  return {
    findings,
    pairs,
    match: {
      visual,
      byText: count.text,
      byLift: count.lift,
      byOrder: count.order,
      byBorder: count.border,
      unmatched: findings.filter((f) => f.verdict === 'unmatched').length,
      flattened: flattened.size,
    },
  };
}

export function summarizeDesign(findings: DesignFinding[]): Record<DesignVerdict, number> {
  const acc: Record<DesignVerdict, number> = {
    ok: 0,
    near: 0,
    'wrong-token': 0,
    'off-scale': 0,
    misplaced: 0,
    violation: 0,
    'alpha-variant': 0,
    missing: 0,
    unmatched: 0,
    unmeasurable: 0,
  };
  for (const f of findings) acc[f.verdict]++;
  return acc;
}
