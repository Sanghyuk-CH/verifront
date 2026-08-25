import postcss from 'postcss';
import { normalize } from '../src/normalize.js';

export interface ExtractedToken {
  cssVar: string;
  value: string;
  selector: string;
  line: number;
}

/**
 * CSS 커스텀 프로퍼티 선언 중 색으로 파싱되는 것만 토큰으로 본다.
 * --kp-sans 같은 폰트 스택이나 --ease 같은 베지어는 파싱에 실패해 자연히 빠진다.
 */
export function extractTokens(css: string): ExtractedToken[] {
  const out: ExtractedToken[] = [];
  postcss.parse(css).walkDecls((decl) => {
    if (!decl.prop.startsWith('--')) return;
    const n = normalize(decl.value.trim());
    if (n.kind !== 'color') return;
    out.push({
      cssVar: decl.prop.toLowerCase(),
      value: decl.value.trim(),
      selector: (decl.parent as any)?.selector ?? '',
      line: decl.source?.start?.line ?? 0,
    });
  });
  return out;
}
