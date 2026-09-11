import { chromium, type Browser } from 'playwright';

/**
 * 간격에는 ΔE00 같은 지각 상수가 없다. 그래서 허용오차를 빌려오지 않고 두 개로 쪼개 유도한다.
 *
 * ε_render — 브라우저 좌표계의 격자. Chromium 은 레이아웃을 1/64 CSS px 단위로 끊는다.
 *   141 과 151 에서 실측한 최대 편차는 0.014625px 였다. 여유를 두고 0.02px 로 잡는다.
 *   배율(DPR)을 바꿔도 변하지 않는다. 격자가 기기 픽셀이 아니라 CSS px 기준이기 때문이다.
 *
 * ε_design — "이만큼 어긋나면 틀린 것으로 본다" 의 경계. 이건 고르는 값인데 상한이 정해져 있다.
 *   토큰 스케일의 최소 간격이 s 라면 허용오차가 s/2 이상인 순간
 *   어떤 값이 두 토큰에서 등거리가 되어 "어느 토큰을 의도했는가" 가 성립하지 않는다.
 *   그래서 ε_design < s/2 이고, 이 검사기는 상한을 그대로 쓴다.
 *
 * 4px 스케일에서 둘의 비는 0.02 : 2, 약 100배다.
 * 노이즈가 판정 경계보다 훨씬 작아야 검사가 성립한다. 픽셀 비교가 실패한 자리가 여기였다.
 */
export const EPS_RENDER = 0.02;

export type SpacingVerdict =
  /** 토큰과 일치한다 */
  | 'ok'
  /** 토큰에서 어긋났지만 최소 스텝의 절반 안이다. 의도한 토큰이 밀린 자리로 본다 */
  | 'near'
  /** 어느 토큰과도 가깝지 않다. 손으로 고른 숫자 */
  | 'off-scale'
  /** 브라우저가 px 로 답하지 않았다. gap:5% 는 계산되지 않은 채 돌아온다 */
  | 'unresolved'
  /** 선언된 값으로 예측한 여백과 화면에 그려진 여백이 다르다 */
  | 'mismatch';

export interface SpaceToken {
  name: string;
  /** space.4 -> --space-4 */
  cssVar: string;
  value: string;
  px: number;
}

export function loadSpaceTokens(json: Record<string, Record<string, string>>): SpaceToken[] {
  const out: SpaceToken[] = [];
  for (const [group, entries] of Object.entries(json)) {
    if (group !== 'space') continue;
    for (const [name, value] of Object.entries(entries)) {
      const px = parsePx(value);
      if (px === null) continue;
      out.push({ name: `${group}.${name}`, cssVar: `--${group}-${name}`.toLowerCase(), value, px });
    }
  }
  return out.sort((a, b) => a.px - b.px);
}

export function parsePx(v: string): number | null {
  const m = /^(-?\d*\.?\d+)px$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}

/**
 * 스케일의 최소 스텝. 토큰이 하나뿐이면 그 값 자체를 스텝으로 본다.
 * 스케일이 촘촘할수록 s/2 가 작아져 판정이 엄격해지고, 동시에
 * 어긋난 값이 이웃 토큰 위에 떨어질 확률이 높아져 검사기가 잡아낼 수 있는 실수가 줄어든다.
 * 4px 스케일에서 22px 은 20 과 24 중 어느 쪽에서도 2px 떨어져 판정이 서지 않는다.
 */
export function minStep(tokens: SpaceToken[]): number {
  if (tokens.length === 0) return 0;
  if (tokens.length === 1) return tokens[0]!.px;
  let s = Infinity;
  for (let i = 1; i < tokens.length; i++) {
    const d = tokens[i]!.px - tokens[i - 1]!.px;
    if (d > 0 && d < s) s = d;
  }
  return Number.isFinite(s) ? s : tokens[0]!.px;
}

export interface SpacingJudgement {
  verdict: SpacingVerdict;
  token?: string;
  tokenValue?: string;
  /** 가장 가까운 토큰과의 거리(px) */
  distance?: number;
}

/**
 * 한 값을 스케일에 대고 판정한다.
 * 0 은 토큰에 없어도 통과시킨다. "여백 없음" 은 스케일 밖의 정상값이다.
 */
export function judgeSpacing(raw: string, tokens: SpaceToken[]): SpacingJudgement {
  const px = parsePx(raw);
  if (px === null) return { verdict: 'unresolved' };
  if (px === 0) return { verdict: 'ok' };
  if (tokens.length === 0) return { verdict: 'unresolved' };

  let best = tokens[0]!;
  let bestD = Math.abs(px - best.px);
  for (const t of tokens) {
    const d = Math.abs(px - t.px);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }

  const base = { token: best.name, tokenValue: best.value, distance: round(bestD) };
  if (bestD <= EPS_RENDER) return { verdict: 'ok', ...base };
  if (bestD < minStep(tokens) / 2) return { verdict: 'near', ...base };
  return { verdict: 'off-scale', ...base };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* ─────────────────────────────────────────────────────────────
 * 값 층과 기하 층
 * ───────────────────────────────────────────────────────────── */

export const SPACING_PROPS = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'row-gap',
  'column-gap',
] as const;

export interface ValueFinding {
  kind: 'value';
  selector: string;
  prop: string;
  raw: string;
  verdict: SpacingVerdict;
  token?: string;
  tokenValue?: string;
  distance?: number;
}

export interface GapFinding {
  kind: 'gap';
  /** 여백을 사이에 둔 두 요소 */
  between: [string, string];
  axis: 'vertical' | 'horizontal';
  /** 선언된 값으로 예측한 여백 */
  predicted: number;
  /** 좌표로 잰 실제 여백 */
  actual: number;
  verdict: SpacingVerdict;
  token?: string;
  tokenValue?: string;
  distance?: number;
}

export type SpacingFinding = ValueFinding | GapFinding;

interface RawValue {
  selector: string;
  prop: string;
  value: string;
}
interface RawGap {
  between: [string, string];
  axis: 'vertical' | 'horizontal';
  predicted: number;
  actual: number;
}

/**
 * 페이지 안에서 실행된다.
 *
 * 값 층은 getComputedStyle 로 선언을 읽는다.
 * 기하 층은 인접한 두 형제의 좌표 차로 화면의 빈 거리를 잰다.
 *
 * 두 층을 나눈 이유는 값 층이 "화면의 여백이 몇 px 인가" 에 답할 수 없기 때문이다.
 * 마주 본 마진은 더해지지 않고 큰 쪽만 남는다. 사이에 낀 빈 요소의 마진은 사라진다.
 * transform 은 계산된 값에 흔적을 남기지 않고 여백만 늘린다.
 *
 * 짝짓기는 인접 형제로만 끊는다. 임의의 두 요소 사이 여백은
 * 어느 쌍을 재야 하는지가 정해지지 않아 화면만 보고는 답이 나오지 않는다.
 */
function readPage(rootSelector: string | null): { values: RawValue[]; gaps: RawGap[] } {
  const values: RawValue[] = [];
  const gaps: RawGap[] = [];

  const sig = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const cls = [...el.classList].sort().join('.');
    return cls ? `${tag}.${cls}` : tag;
  };
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      parts.unshift(sig(cur));
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return { values, gaps };
  const elements = [root, ...root.querySelectorAll('*')];

  /**
   * margin: 0 auto 는 계산된 값으로 읽으면 296px 같은 수가 나온다.
   * 가운데 정렬의 결과일 뿐 스케일과 아무 관계가 없어서, 토큰에 대고 판정하면
   * 거의 항상 스케일 밖으로 잡힌다. 선언이 auto 인 자리는 판정에서 뺀다.
   */
  const autoMargins: Array<[string, Set<string>]> = [];
  const SIDES = ['top', 'right', 'bottom', 'left'];
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 교차 출처 스타일시트
    }
    for (const rule of [...rules]) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const props = new Set<string>();
      const short = rule.style.getPropertyValue('margin').trim();
      if (short.includes('auto')) {
        const parts = short.split(/\s+/);
        const four =
          parts.length === 1
            ? [parts[0], parts[0], parts[0], parts[0]]
            : parts.length === 2
              ? [parts[0], parts[1], parts[0], parts[1]]
              : parts.length === 3
                ? [parts[0], parts[1], parts[2], parts[1]]
                : parts;
        four.forEach((v, i) => {
          if (v === 'auto') props.add(`margin-${SIDES[i]}`);
        });
      }
      for (const side of SIDES) {
        if (rule.style.getPropertyValue(`margin-${side}`).trim() === 'auto') props.add(`margin-${side}`);
      }
      for (const [logical, physical] of [
        ['margin-inline', ['margin-left', 'margin-right']],
        ['margin-block', ['margin-top', 'margin-bottom']],
      ] as const) {
        if (rule.style.getPropertyValue(logical).includes('auto')) physical.forEach((p) => props.add(p));
      }
      if (props.size > 0) autoMargins.push([rule.selectorText, props]);
    }
  }
  const isAuto = (el: Element, prop: string): boolean =>
    autoMargins.some(([sel, props]) => {
      if (!props.has(prop)) return false;
      try {
        return el.matches(sel);
      } catch {
        return false;
      }
    });

  const PROPS = [
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'row-gap',
    'column-gap',
  ];

  for (const el of elements) {
    const cs = getComputedStyle(el);
    const path = pathOf(el);

    for (const prop of PROPS) {
      const v = cs.getPropertyValue(prop);
      // gap 은 쓰이지 않으면 normal 로 답한다. 0px 마진·패딩은 판정에서 통과하지만
      // 전부 세면 요소 수 × 10 이 대상이 되므로 아무것도 만들지 않는 값은 버린다.
      if (v === 'normal' || v === '0px' || v === '') continue;
      if (prop.startsWith('margin-') && isAuto(el, prop)) continue;
      values.push({ selector: path, prop, value: v });
    }

    // 기하 층 — 이 요소의 자식들을 인접한 쌍으로 훑는다
    const kids = [...el.children].filter((k) => {
      const s = getComputedStyle(k);
      return s.display !== 'none' && s.position !== 'absolute' && s.position !== 'fixed';
    });
    if (kids.length < 2) continue;

    const csEl = getComputedStyle(el);
    const isFlex = csEl.display === 'flex' || csEl.display === 'inline-flex';
    const isGrid = csEl.display === 'grid' || csEl.display === 'inline-grid';
    const row = isFlex && csEl.flexDirection.startsWith('row');
    const axis: 'vertical' | 'horizontal' = row ? 'horizontal' : 'vertical';

    const gapProp = axis === 'vertical' ? csEl.rowGap : csEl.columnGap;
    const gapPx = /^(-?\d*\.?\d+)px$/.test(gapProp) ? Number(gapProp.replace('px', '')) : 0;

    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1]!;
      const b = kids[i]!;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (ra.width === 0 && ra.height === 0) continue;
      if (rb.width === 0 && rb.height === 0) continue;

      const actual = axis === 'vertical' ? rb.top - ra.bottom : rb.left - ra.right;

      // 값만 보고 예측하면 이렇게 된다. 마주 본 마진을 더하고 부모의 gap 을 얹는다.
      // 상쇄도 transform 도 모르는 계산이다. 그 무지가 어디서 드러나는지를 세려는 것이다.
      const ma = axis === 'vertical' ? getComputedStyle(a).marginBottom : getComputedStyle(a).marginRight;
      const mb = axis === 'vertical' ? getComputedStyle(b).marginTop : getComputedStyle(b).marginLeft;
      const num = (v: string) => (/^(-?\d*\.?\d+)px$/.test(v) ? Number(v.replace('px', '')) : 0);
      const predicted = isFlex || isGrid ? gapPx + num(ma) + num(mb) : num(ma) + num(mb);

      // 아무 여백도 선언되지 않았고 화면에도 붙어 있는 쌍은 판정할 것이 없다.
      if (predicted === 0 && Math.abs(actual) <= 0.02) continue;

      gaps.push({
        between: [pathOf(a), pathOf(b)],
        axis,
        predicted: Math.round(predicted * 1000) / 1000,
        actual: Math.round(actual * 1000) / 1000,
      });
    }
  }

  return { values, gaps };
}

export interface SpacingOptions {
  root?: string | null;
  viewport?: { width: number; height: number };
  /** playwright 번들 대신 쓸 브라우저 실행 파일 */
  executablePath?: string;
}

export async function checkSpacingHtml(
  html: string,
  tokens: SpaceToken[],
  opts: SpacingOptions = {},
): Promise<SpacingFinding[]> {
  const browser: Browser = await chromium.launch({
    executablePath: opts.executablePath,
    args: opts.executablePath ? ['--no-sandbox'] : [],
  });
  try {
    const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1280, height: 900 } });
    // tsx(esbuild) 가 함수 이름 보존용 __name 헬퍼를 끼워 넣는다. 페이지에는 그게 없다.
    await page.addInitScript(() => {
      (globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => {
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
    });
    const { values, gaps } = await page.evaluate(readPage, opts.root ?? null);

    const out: SpacingFinding[] = [];

    for (const v of values) {
      const j = judgeSpacing(v.value, tokens);
      out.push({ kind: 'value', selector: v.selector, prop: v.prop, raw: v.value, ...j });
    }

    for (const g of gaps) {
      // 예측과 실측이 갈라지면 값 층이 화면을 못 본 자리다. 토큰 판정보다 이쪽이 먼저다.
      if (Math.abs(g.predicted - g.actual) > EPS_RENDER) {
        out.push({ kind: 'gap', ...g, verdict: 'mismatch' });
        continue;
      }
      const j = judgeSpacing(`${g.actual}px`, tokens);
      out.push({ kind: 'gap', ...g, ...j });
    }

    return out;
  } finally {
    await browser.close();
  }
}

export function summarize(findings: SpacingFinding[]): Record<SpacingVerdict, number> {
  const acc: Record<SpacingVerdict, number> = {
    ok: 0,
    near: 0,
    'off-scale': 0,
    unresolved: 0,
    mismatch: 0,
  };
  for (const f of findings) acc[f.verdict]++;
  return acc;
}
