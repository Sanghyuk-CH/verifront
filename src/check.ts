import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { normalize, sameRgb, sameAlpha, perceptualDistance } from './normalize.ts';
import type { Rgb } from 'culori';

/** ΔE00 1.0 미만은 표준적인 육안 구분 한계. 그 아래를 미세차로 본다. */
export const NEAR_THRESHOLD = 1.0;

/**
 * 기본 검사 대상.
 * box-shadow / background-image / background 는 제외한다.
 * 그림자와 그라디언트의 색은 토큰에 없는 것이 정상인 경우가 많아
 * 기본으로 켜면 오탐이 신호를 덮는다. --include-effects 로 켤 수 있다.
 */
export const DEFAULT_PROPS = [
  'color',
  'background-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'outline',
  'outline-color',
  'fill',
  'stroke',
];

export const EFFECT_PROPS = ['box-shadow', 'text-shadow', 'background-image', 'background'];

export type Verdict = 'ok' | 'near' | 'violation' | 'alpha-variant' | 'unknown-token' | 'uncomputable';

export interface Finding {
  file: string;
  line: number;
  prop: string;
  raw: string;
  verdict: Verdict;
  token?: string;
  tokenValue?: string;
  distance?: number;
}

export interface Token {
  name: string;
  /** 토큰 이름에 대응하는 CSS 커스텀 프로퍼티. color.primary -> --color-primary */
  cssVar: string;
  value: string;
  rgb: Rgb;
}

export function loadTokens(json: Record<string, Record<string, string>>): Token[] {
  const out: Token[] = [];
  for (const [group, entries] of Object.entries(json)) {
    for (const [name, value] of Object.entries(entries)) {
      const n = normalize(value);
      if (n.kind !== 'color') continue;
      out.push({
        name: `${group}.${name}`,
        cssVar: `--${group}-${name}`.toLowerCase(),
        value,
        rgb: n.rgb,
      });
    }
  }
  return out;
}

/** 문서 안의 커스텀 프로퍼티 선언을 모은다. 나중 선언이 앞선 것을 덮는다. */
function collectLocalVars(root: postcss.Root): Map<string, string> {
  const map = new Map<string, string>();
  root.walkDecls((decl) => {
    if (decl.prop.startsWith('--')) map.set(decl.prop.toLowerCase(), decl.value.trim());
  });
  return map;
}

/**
 * var() 참조를 따라가 최종 값을 얻는다.
 * 브라우저가 하는 일이다. 이름만 대조하면 값이 맞는데도 위반으로 잡거나,
 * 이름이 맞으면 값이 틀려도 통과시킨다.
 */
function resolveVar(name: string, locals: Map<string, string>, depth = 0): string | null {
  if (depth > 10) return null; // 순환 참조 방어
  const raw = locals.get(name);
  if (raw === undefined) return null;

  const inner = raw.match(/^var\(\s*(--[\w-]+)/i)?.[1];
  if (inner) return resolveVar(inner.toLowerCase(), locals, depth + 1);
  return raw;
}

/**
 * 정적으로 값을 알 수 없는 색 함수.
 * color-mix 는 브라우저가 런타임에 보간하고, light-dark 는 사용자 설정에 따라 갈린다.
 * 상대 색 문법 rgb(from …) 도 기준 색이 정해져야 값이 나온다.
 * 이런 자리를 ok 로 찍으면 검사기가 보지도 않은 색을 통과시킨 것이 된다.
 */
const UNCOMPUTABLE_FN = /^(color-mix|light-dark)$/i;

function isRelativeColor(node: valueParser.FunctionNode): boolean {
  return node.nodes.some((n) => n.type === 'word' && n.value.toLowerCase() === 'from');
}

interface Candidates {
  colors: string[];
  /** 참조된 커스텀 프로퍼티 이름 */
  varRefs: string[];
  /** 정적으로 값을 계산할 수 없는 자리 */
  uncomputable: string[];
}

function extractCandidates(value: string): Candidates {
  const colors: string[] = [];
  const varRefs: string[] = [];
  const uncomputable: string[] = [];

  valueParser(value).walk((node) => {
    if (node.type === 'function') {
      if (UNCOMPUTABLE_FN.test(node.value)) {
        uncomputable.push(valueParser.stringify(node));
        return false; // 안으로 들어가지 않는다. 인자를 세면 계산되지 않은 색이 ok 가 된다.
      }
      if (node.value === 'var') {
        const name = node.nodes.find((n) => n.type === 'word' && n.value.startsWith('--'));
        // 폴백을 보고 이 참조가 색 토큰인지 판단한다.
        // var(--mx, 50%) 처럼 폴백이 색이 아니면 색 토큰이 아니다.
        const div = node.nodes.findIndex((n) => n.type === 'div' && n.value === ',');
        if (div !== -1) {
          const fb = valueParser.stringify(node.nodes.slice(div + 1)).trim();
          if (normalize(fb).kind !== 'color') return false;
        }
        if (name) varRefs.push(name.value.toLowerCase());
        return true;
      }
      if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i.test(node.value)) {
        if (isRelativeColor(node)) {
          uncomputable.push(valueParser.stringify(node));
          return false;
        }
        colors.push(valueParser.stringify(node));
        return false;
      }
      return true;
    }
    if (node.type === 'word' && !node.value.startsWith('--')) colors.push(node.value);
    return true;
  });

  return { colors, varRefs, uncomputable };
}

function judge(rgb: Rgb, tokens: Token[]): Omit<Finding, 'file' | 'line' | 'prop' | 'raw'> {
  const exact = tokens.find((t) => sameRgb(rgb, t.rgb) && sameAlpha(rgb, t.rgb));
  if (exact) return { verdict: 'ok', token: exact.name, tokenValue: exact.value };

  const alphaOnly = tokens.find((t) => sameRgb(rgb, t.rgb));
  if (alphaOnly) {
    return { verdict: 'alpha-variant', token: alphaOnly.name, tokenValue: alphaOnly.value };
  }

  const nearest = tokens.map((t) => ({ t, d: perceptualDistance(rgb, t.rgb) })).sort((a, b) => a.d - b.d)[0];

  // 토큰 목록이 비어 있으면 비교 대상이 없다. 견줄 토큰 없이 위반으로만 기록한다.
  if (!nearest) return { verdict: 'violation' };

  return {
    verdict: nearest.d < NEAR_THRESHOLD ? 'near' : 'violation',
    token: nearest.t.name,
    tokenValue: nearest.t.value,
    distance: Number(nearest.d.toFixed(2)),
  };
}

export function checkCss(
  css: string,
  file: string,
  tokens: Token[],
  opts: { includeEffects?: boolean } = {},
): Finding[] {
  const props = new Set(opts.includeEffects ? [...DEFAULT_PROPS, ...EFFECT_PROPS] : DEFAULT_PROPS);
  const findings: Finding[] = [];
  const root = postcss.parse(css);
  const locals = collectLocalVars(root);

  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    // 커스텀 프로퍼티 선언도 검사한다. --shadow 처럼 색을 품은 합성 값이 있다.
    if (!props.has(prop) && !prop.startsWith('--')) return;
    const line = decl.source?.start?.line ?? 0;
    const { colors, varRefs, uncomputable } = extractCandidates(decl.value);

    for (const raw of uncomputable) {
      // 값이 브라우저에서 정해진다. 통과도 위반도 아니고, 검사하지 못한 자리다.
      findings.push({ file, line, prop: decl.prop, raw, verdict: 'uncomputable' });
    }

    for (const ref of varRefs) {
      const known = tokens.find((t) => t.cssVar === ref);
      const resolved = resolveVar(ref, locals);

      if (resolved === null) {
        // 문서 안에 선언이 없다.
        if (known) {
          // 토큰 파일에 있는 이름이다. 다른 파일에서 정의됐다고 보고 통과시킨다.
          findings.push({
            file,
            line,
            prop: decl.prop,
            raw: `var(${ref})`,
            verdict: 'ok',
            token: known.name,
            tokenValue: known.value,
          });
        } else {
          // 어디에도 없다. 값을 알 수 없어 검사가 불가능하다.
          findings.push({
            file,
            line,
            prop: decl.prop,
            raw: `var(${ref})`,
            verdict: 'unknown-token',
          });
        }
        continue;
      }

      // 선언이 있으면 이름이 토큰과 같아도 값을 따라간다.
      // 이름만 보고 통과시키면 토큰 이름으로 다른 값을 정의한 경우를 놓친다.
      const rn = normalize(resolved);
      if (rn.kind !== 'color') continue;
      findings.push({
        file,
        line,
        prop: decl.prop,
        raw: `var(${ref}) → ${resolved}`,
        ...judge(rn.rgb, tokens),
      });
    }

    for (const candidate of colors) {
      const n = normalize(candidate);
      if (n.kind !== 'color') continue; // 리터럴·키워드·파싱 불가는 조용히 넘어간다
      findings.push({
        file,
        line,
        prop: decl.prop,
        raw: candidate,
        ...judge(n.rgb, tokens),
      });
    }
  });

  return findings;
}

/** 종료 코드에 반영할 위반. alpha-variant 는 리포트만 하고 실패로 치지 않는다. */
export function isFailure(f: Finding): boolean {
  return f.verdict === 'near' || f.verdict === 'violation' || f.verdict === 'unknown-token';
}
