import { parse, differenceCiede2000, type Rgb } from 'culori';

const deltaE = differenceCiede2000();

/**
 * 검사 대상에서 제외하는 값.
 * culori는 transparent 를 #00000000 으로 파싱하므로,
 * 이 목록을 파서보다 반드시 먼저 통과시켜야 한다.
 * 그러지 않으면 transparent 가 "검정과 알파만 다른 값"으로 판정된다.
 */
const LITERALS = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'none',
  'auto',
]);

export type Normalized =
  | { kind: 'literal'; raw: string }
  | { kind: 'color'; raw: string; rgb: Rgb }
  | { kind: 'unparsable'; raw: string };

export function normalize(raw: string): Normalized {
  const s = raw.trim();
  if (LITERALS.has(s.toLowerCase())) return { kind: 'literal', raw: s };

  const parsed = parse(s);
  if (!parsed) return { kind: 'unparsable', raw: s };

  const rgb = parsed as Rgb;
  return { kind: 'color', raw: s, rgb: { ...rgb, alpha: rgb.alpha ?? 1 } };
}

const ch = (v: number | undefined) => Math.round((v ?? 0) * 255);

export function sameRgb(a: Rgb, b: Rgb): boolean {
  return ch(a.r) === ch(b.r) && ch(a.g) === ch(b.g) && ch(a.b) === ch(b.b);
}

export function sameAlpha(a: Rgb, b: Rgb): boolean {
  return Math.round((a.alpha ?? 1) * 255) === Math.round((b.alpha ?? 1) * 255);
}

/** 알파를 제외한 지각 거리. 알파는 색 거리에 섞지 않는다. */
export function perceptualDistance(a: Rgb, b: Rgb): number {
  return deltaE({ ...a, alpha: 1 }, { ...b, alpha: 1 });
}
