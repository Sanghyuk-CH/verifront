import { chromium, type Browser, type Page } from 'playwright';
import { normalize } from './normalize.ts';
import { judge, type Token, type Verdict } from './check.ts';

/**
 * 런타임 검사의 판정 단위는 (선택자 경로, 속성, 상태) 다.
 * 정적 검사의 단위(파일, 줄, 선언)와 다르다.
 * getComputedStyle 은 값이 어느 CSS 줄에서 왔는지 모른다. 그 손실을 그대로 드러낸다.
 */
export type State = 'default' | 'hover' | 'disabled';

export interface RuntimeFinding {
  file: string;
  selector: string;
  state: State;
  prop: string;
  /** 브라우저가 돌려준 문자열 원문 */
  raw: string;
  verdict: Verdict;
  token?: string;
  tokenValue?: string;
  distance?: number;
}

/**
 * 검사 속성. 정적 검사와 같은 기준으로 그림자·그라디언트는 뺀다.
 * 런타임에는 shorthand 가 없다. 브라우저는 longhand 로만 답한다.
 */
export const RUNTIME_PROPS = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
] as const;

/** 브라우저에서 읽어온 한 요소의 한 속성 값 */
interface Reading {
  selector: string;
  prop: string;
  value: string;
}

/**
 * 페이지 안에서 실행되는 함수. 그려지는 값만 읽는다.
 *
 * getComputedStyle 은 묻는 것마다 답한다. border 가 없는 요소도 border-top-color 를 돌려주고
 * (currentcolor 가 풀린 글자색) 배경이 없는 요소도 rgba(0, 0, 0, 0) 을 돌려준다.
 * 전부 세면 요소 수 × 속성 수가 판정 대상이 되고 그 대부분은 아무것도 칠하지 않는 값이다.
 * 그래서 속성마다 "실제로 그려지는가" 를 먼저 묻는다.
 */
function readPage(arg: { root: string | null; skipDisabled: boolean }): Reading[] {
  const { root: rootSelector, skipDisabled } = arg;
  const out: Reading[] = [];

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
  const hasOwnText = (el: Element): boolean =>
    [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
  const transparent = (v: string) => /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)$/.test(v) || v === 'transparent';

  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return out;
  const elements = [root, ...root.querySelectorAll('*')];

  const readOne = (selector: string, cs: CSSStyleDeclaration, hasText: boolean) => {
    const push = (prop: string, value: string) => out.push({ selector, prop, value });
    if (hasText && !transparent(cs.color)) push('color', cs.color);
    if (!transparent(cs.backgroundColor)) push('background-color', cs.backgroundColor);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const style = cs.getPropertyValue(`border-${side}-style`);
      const width = parseFloat(cs.getPropertyValue(`border-${side}-width`));
      if (style !== 'none' && style !== 'hidden' && width > 0) {
        const v = cs.getPropertyValue(`border-${side}-color`);
        if (!transparent(v)) push(`border-${side}-color`, v);
      }
    }
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) push('outline-color', cs.outlineColor);
    if (cs.textDecorationLine !== 'none' && hasText) push('text-decoration-color', cs.textDecorationColor);
  };

  for (const el of elements) {
    // 상태 분류는 요소 단위다. 선택자 경로는 disabled 버튼과 활성 버튼을 구분하지 못한다.
    if (skipDisabled && el.closest('[data-verifront-disabled]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const selector = el === document.body ? 'body' : pathOf(el);
    readOne(selector, cs, hasOwnText(el));

    // 가상 요소도 그려진다. content 가 있는 ::before / ::after 만 읽는다.
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
      readOne(`${selector}${pseudo}`, ps, /^"(?!\s*")/.test(ps.content));
    }
  }
  return out;
}

/** 스타일시트에서 :hover 가 붙은 선택자를 모아 그 대상 요소를 찾는다. 추정하지 않고 CSS 가 말한 곳만 간다. */
function findHoverTargets(): string[] {
  const selectors = new Set<string>();
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin
    }
    const walk = (list: CSSRuleList) => {
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) {
          for (const part of rule.selectorText.split(',')) {
            if (!part.includes(':hover')) continue;
            // .card:hover .title 같은 후손 선택자는 hover 되는 쪽만 남긴다.
            const idx = part.indexOf(':hover');
            const base = part.slice(0, idx).trim();
            if (base) selectors.add(base);
          }
        } else if ('cssRules' in rule) {
          walk((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    walk(rules);
  }
  // 요소마다 고유 마커를 붙여 Node 쪽에서 다시 찾을 수 있게 한다.
  const targets: string[] = [];
  let i = 0;
  for (const sel of selectors) {
    let els: NodeListOf<Element>;
    try {
      els = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of els) {
      if (el.hasAttribute('data-verifront-hover')) continue;
      if (el.matches(':disabled')) continue; // disabled 는 별도 상태로 읽는다
      const id = `h${i++}`;
      el.setAttribute('data-verifront-hover', id);
      targets.push(`[data-verifront-hover="${id}"]`);
    }
  }
  return targets;
}

function markDisabled(): string[] {
  const out: string[] = [];
  let i = 0;
  for (const el of document.querySelectorAll(':disabled, [aria-disabled="true"]')) {
    const id = `d${i++}`;
    el.setAttribute('data-verifront-disabled', id);
    out.push(`[data-verifront-disabled="${id}"]`);
  }
  return out;
}

/**
 * 안정화. 같은 값이 두 번 연속 읽힐 때까지 기다린다.
 * transition 도중에 읽으면 보간 중간값이 나오고 무엇이 나올지는 실행마다 다르다 (probe 7b).
 * transition 을 끄지 않는다. 측정을 위해 대상을 바꾸지 않는다.
 */
async function readStable(
  page: Page,
  arg: { root: string | null; skipDisabled: boolean },
  opts: { interval: number; timeout: number },
) {
  const started = Date.now();
  let prev = JSON.stringify(await page.evaluate(readPage, arg));
  let settleAttempts = 0;
  for (;;) {
    await page.waitForTimeout(opts.interval);
    const cur = JSON.stringify(await page.evaluate(readPage, arg));
    if (cur === prev) return { readings: JSON.parse(cur) as Reading[], settled: true, attempts: settleAttempts };
    settleAttempts++;
    prev = cur;
    if (Date.now() - started > opts.timeout) {
      return { readings: JSON.parse(cur) as Reading[], settled: false, attempts: settleAttempts };
    }
  }
}

export interface RuntimeOptions {
  states?: State[];
  /** 안정화 읽기 간격(ms). 기본 100. */
  interval?: number;
  /** 안정화 상한(ms). 넘기면 마지막 값을 쓰고 unstable 로 표시한다. */
  timeout?: number;
  executablePath?: string;
  browser?: Browser;
}

export interface RuntimeResult {
  findings: RuntimeFinding[];
  /** 안정화 상한 안에 값이 멈추지 않은 (상태, 대상) */
  unstable: { state: State; target: string }[];
  browserVersion: string;
}

function dedupe(readings: Reading[]): Reading[] {
  const seen = new Set<string>();
  return readings.filter((r) => {
    const k = `${r.selector}\u0000${r.prop}\u0000${r.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function toFindings(file: string, state: State, readings: Reading[], tokens: Token[]): RuntimeFinding[] {
  return dedupe(readings).map((r) => {
    const n = normalize(r.value);
    if (n.kind !== 'color') {
      // 브라우저가 준 값을 파서가 못 읽는다. 런타임에서는 원칙적으로 나오면 안 되는 자리다.
      return { file, selector: r.selector, state, prop: r.prop, raw: r.value, verdict: 'uncomputable' as const };
    }
    return { file, selector: r.selector, state, prop: r.prop, raw: r.value, ...judge(n.rgb, tokens) };
  });
}

/**
 * HTML 파일(또는 URL)을 브라우저에 띄우고 실제 적용된 색을 읽어 토큰과 대조한다.
 * 기존 판정(ΔE00, 6종 척도)은 정적 검사와 같은 코드를 쓴다. 다른 것은 색을 어디서 가져오느냐뿐이다.
 */
export async function checkRuntime(target: string, tokens: Token[], opts: RuntimeOptions = {}): Promise<RuntimeResult> {
  const states = opts.states ?? ['default', 'hover', 'disabled'];
  const stab = { interval: opts.interval ?? 100, timeout: opts.timeout ?? 2000 };
  const executablePath = opts.executablePath ?? process.env.VERIFRONT_CHROME ?? undefined;
  const browser =
    opts.browser ?? (await chromium.launch({ executablePath, args: executablePath ? ['--no-sandbox'] : [] }));
  const ownsBrowser = !opts.browser;

  const url = /^https?:\/\//.test(target) ? target : 'file://' + (await import('node:path')).resolve(target);
  const file = target;
  const findings: RuntimeFinding[] = [];
  const unstable: RuntimeResult['unstable'] = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // tsx(esbuild) 가 함수 이름 보존용 __name 헬퍼를 끼워 넣는다. 페이지에는 그게 없다.
    await page.addInitScript(() => {
      (globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    const disabledTargets = await page.evaluate(markDisabled);

    const baseline = new Set<string>();
    {
      const { readings, settled } = await readStable(page, { root: null, skipDisabled: true }, stab);
      for (const r of readings) baseline.add(`${r.selector}\u0000${r.prop}\u0000${r.value}`);
      if (!settled) unstable.push({ state: 'default', target: 'body' });
      if (states.includes('default')) findings.push(...toFindings(file, 'default', readings, tokens));
    }

    if (states.includes('disabled')) {
      const dis: Reading[] = [];
      for (const t of disabledTargets) {
        const { readings, settled } = await readStable(page, { root: t, skipDisabled: false }, stab);
        if (!settled) unstable.push({ state: 'disabled', target: t });
        dis.push(...readings);
      }
      findings.push(...toFindings(file, 'disabled', dis, tokens));
    }

    if (states.includes('hover')) {
      const targets = await page.evaluate(findHoverTargets);
      const hoverReadings: Reading[] = [];
      for (const t of targets) {
        await page.hover(t);
        const { readings, settled } = await readStable(page, { root: t, skipDisabled: true }, stab);
        if (!settled) unstable.push({ state: 'hover', target: t });
        // hover 가 바꾼 값만 남긴다. 안 바뀐 값은 default 에서 이미 판정했다.
        hoverReadings.push(...readings.filter((r) => !baseline.has(`${r.selector}\u0000${r.prop}\u0000${r.value}`)));
        // 다음 대상으로 가기 전에 hover 를 푼다. 풀리는 transition 도 기다린다.
        await page.mouse.move(0, 0);
        await readStable(page, { root: t, skipDisabled: true }, stab);
      }
      findings.push(...toFindings(file, 'hover', hoverReadings, tokens));
    }

    return { findings, unstable, browserVersion: browser.version() };
  } finally {
    if (ownsBrowser) await browser.close();
  }
}
