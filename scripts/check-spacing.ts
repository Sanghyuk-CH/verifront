// 간격 검사기를 HTML 하나에 돌려 판정을 표로 낸다.
// 실행: npx tsx scripts/check-spacing.ts fixtures/spacing-dirty.html
//
// 두 층을 나눠 낸다.
//   값 층 — getComputedStyle 이 답한 선언을 토큰과 대조한다
//   기하 층 — 인접한 두 형제의 좌표 차로 화면의 빈 거리를 재고, 선언으로 예측한 값과 맞춰 본다

import { readFileSync } from 'node:fs';
import { loadSpaceTokens, checkSpacingHtml, summarize, minStep, EPS_RENDER } from '../src/spacing.ts';

const TOKENS_PATH = process.env.VERIFRONT_SPACE_TOKENS ?? 'experiments/tokens-space.json';

function table(rows: string[][]) {
  if (rows.length <= 1) {
    console.log('(없음)');
    return;
  }
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  for (const [i, r] of rows.entries()) {
    console.log('| ' + r.map((c, j) => (c ?? '').padEnd(w[j]!)).join(' | ') + ' |');
    if (i === 0) console.log('|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|');
  }
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('사용법: npx tsx scripts/check-spacing.ts <html 경로>');
    process.exit(1);
  }

  const tokens = loadSpaceTokens(JSON.parse(readFileSync(TOKENS_PATH, 'utf8')));
  const step = minStep(tokens);

  const findings = await checkSpacingHtml(readFileSync(target, 'utf8'), tokens, {
    executablePath: process.env.VERIFRONT_CHROME,
  });

  console.log(`대상: ${target}`);
  console.log(`토큰: ${tokens.length}개, 최소 스텝 ${step}px`);
  console.log(`허용오차: ε_render ${EPS_RENDER}px, ε_design ${step / 2}px 미만\n`);

  console.log('## 판정 집계\n');
  const s = summarize(findings);
  table([
    ['ok', 'near', 'off-scale', 'unresolved', 'mismatch'],
    [s.ok, s.near, s['off-scale'], s.unresolved, s.mismatch].map(String),
  ]);

  console.log('\n\n## 값 층 — 토큰에서 벗어난 선언\n');
  table([
    ['판정', '속성', '값', '가장 가까운 토큰', '거리', '선택자'],
    ...findings
      .filter((f) => f.kind === 'value' && f.verdict !== 'ok')
      .map((f) => {
        const v = f as Extract<typeof f, { kind: 'value' }>;
        return [
          v.verdict,
          v.prop,
          v.raw,
          v.token ?? '-',
          v.distance === undefined ? '-' : `${v.distance}px`,
          v.selector,
        ];
      }),
  ]);

  console.log('\n\n## 기하 층 — 선언으로 예측한 여백과 화면의 여백\n');
  table([
    ['판정', '예측', '실제', '축', '사이'],
    ...findings
      .filter((f) => f.kind === 'gap')
      .map((f) => {
        const g = f as Extract<typeof f, { kind: 'gap' }>;
        return [
          g.verdict,
          `${g.predicted}px`,
          `${g.actual}px`,
          g.axis === 'vertical' ? '세로' : '가로',
          `${g.between[0]}  |  ${g.between[1]}`,
        ];
      }),
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
