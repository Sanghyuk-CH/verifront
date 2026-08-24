import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { normalize, sameRgb, sameAlpha, perceptualDistance } from './normalize.js';
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

export type Verdict = 'ok' | 'near' | 'violation' | 'alpha-variant';

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
  value: string;
  rgb: Rgb;
}

export function loadTokens(json: Record<string, Record<string, string>>): Token[] {
  const out: Token[] = [];
  for (const [group, entries] of Object.entries(json)) {
    for (const [name, value] of Object.entries(entries)) {
      const n = normalize(value);
      if (n.kind !== 'color') continue;
      out.push({ name: `${group}.${name}`, value, rgb: n.rgb });
    }
  }
  return out;
}

function extractColorCandidates(value: string): string[] {
  const found: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type === 'function') {
      if (node.value === 'var') return false;
      if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i.test(node.value)) {
        found.push(valueParser.stringify(node));
        return false;
      }
      return true;
    }
    if (node.type === 'word') found.push(node.value);
    return true;
  });
  return found;
}

function judge(rgb: Rgb, tokens: Token[]): Omit<Finding, 'file' | 'line' | 'prop' | 'raw'> {
  const exact = tokens.find((t) => sameRgb(rgb, t.rgb) && sameAlpha(rgb, t.rgb));
  if (exact) return { verdict: 'ok', token: exact.name, tokenValue: exact.value };

  const alphaOnly = tokens.find((t) => sameRgb(rgb, t.rgb));
  if (alphaOnly) {
    return { verdict: 'alpha-variant', token: alphaOnly.name, tokenValue: alphaOnly.value };
  }

  const nearest = tokens
    .map((t) => ({ t, d: perceptualDistance(rgb, t.rgb) }))
    .sort((a, b) => a.d - b.d)[0];

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
  opts: { includeEffects?: boolean } = {}
): Finding[] {
  const props = new Set(opts.includeEffects ? [...DEFAULT_PROPS, ...EFFECT_PROPS] : DEFAULT_PROPS);
  const findings: Finding[] = [];

  postcss.parse(css).walkDecls((decl) => {
    if (!props.has(decl.prop.toLowerCase())) return;
    for (const candidate of extractColorCandidates(decl.value)) {
      const n = normalize(candidate);
      if (n.kind !== 'color') continue; // 리터럴·키워드·파싱 불가는 조용히 넘어간다
      findings.push({
        file,
        line: decl.source?.start?.line ?? 0,
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
  return f.verdict === 'near' || f.verdict === 'violation';
}
