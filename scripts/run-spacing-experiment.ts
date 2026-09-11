// 생성물 12개를 간격 검사기로 판정한다.
// 실행: npx tsx scripts/run-spacing-experiment.ts
//
// A·B·C 아홉 개는 간격에 대한 지시를 한 줄도 받지 않았다. 대조군이다.
// 이 아홉 개를 "위반" 으로 부르지 않는다. 주지 않은 정답으로 채점하는 것이 되기 때문이다.
// 재는 것은 하나다 — 아무도 시키지 않았을 때 모델이 고른 숫자가 4px 스케일 위에 떨어지는가.
//
// D 세 개는 같은 명세에 간격 토큰을 얹어 받았다. 실험군이다.
// 색 조건은 B 와 동일하게 두어 바뀐 변수를 간격 하나로 묶었다.

import fs from 'node:fs';
import path from 'node:path';
import { loadSpaceTokens, checkSpacingHtml, minStep, type SpacingVerdict } from '../src/spacing.ts';

const dir = path.join(process.cwd(), 'experiments');
const tokens = loadSpaceTokens(JSON.parse(fs.readFileSync(path.join(dir, 'tokens-space.json'), 'utf8')));
const step = minStep(tokens);

const CONDITIONS = ['A', 'B', 'C', 'D'] as const;
const VERDICTS: SpacingVerdict[] = ['ok', 'near', 'off-scale', 'unresolved', 'mismatch'];

interface Row {
  run: string;
  /** 값 층 판정 */
  value: Record<SpacingVerdict, number>;
  /** 선언에 var(--space-*) 를 쓴 횟수 */
  byName: number;
  /** 간격 속성에 px 를 직접 쓴 횟수 */
  literal: number;
  /** 기하 층에서 예측과 실측이 갈라진 쌍 */
  mismatch: number;
  /** 기하 층에서 잰 실제 여백이 스케일 밖인 쌍 */
  gapOffScale: number;
}

function styleOf(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  return [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
}

/** 간격 속성 선언만 골라 원문을 센다. 검사기는 계산된 값을 보고, 이쪽은 개발자가 쓴 글자를 본다. */
function countDeclarations(css: string): { byName: number; literal: number } {
  const re = /(?:^|[;{])\s*(padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?\s*:\s*([^;}]+)/gi;
  let byName = 0;
  let literal = 0;
  for (const m of css.matchAll(re)) {
    const v = m[2]!;
    if (/var\(\s*--space-/i.test(v)) byName++;
    else if (/\d/.test(v) && !/^\s*0\s*$/.test(v)) literal++;
  }
  return { byName, literal };
}

async function judgeFile(file: string): Promise<Row> {
  const findings = await checkSpacingHtml(fs.readFileSync(file, 'utf8'), tokens, {
    executablePath: process.env.VERIFRONT_CHROME,
  });

  const value = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<SpacingVerdict, number>;
  let mismatch = 0;
  let gapOffScale = 0;
  for (const f of findings) {
    if (f.kind === 'value') value[f.verdict]++;
    else if (f.verdict === 'mismatch') mismatch++;
    else if (f.verdict === 'off-scale') gapOffScale++;
  }

  const decl = countDeclarations(styleOf(file));
  return { run: '', value, byName: decl.byName, literal: decl.literal, mismatch, gapOffScale };
}

function table(rows: string[][]) {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  for (const [i, r] of rows.entries()) {
    console.log('| ' + r.map((c, j) => (c ?? '').padEnd(w[j]!)).join(' | ') + ' |');
    if (i === 0) console.log('|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|');
  }
}

async function main() {
  console.log(`토큰 ${tokens.length}개, 최소 스텝 ${step}px, ε_design ${step / 2}px 미만\n`);

  const rows: Row[] = [];
  for (const cond of CONDITIONS) {
    for (const n of [1, 2, 3]) {
      const file = path.join(dir, cond, `run${n}.html`);
      if (!fs.existsSync(file)) continue;
      const r = await judgeFile(file);
      r.run = `${cond}${n}`;
      rows.push(r);
    }
  }

  console.log('## 값 층 — 계산된 간격 값이 스케일 위에 있는가\n');
  table([
    ['run', '대상', 'ok', 'near', 'off-scale', 'unresolved', '스케일 적중률'],
    ...rows.map((r) => {
      const n = VERDICTS.filter((v) => v !== 'mismatch').reduce((a, v) => a + r.value[v], 0);
      const hit = n === 0 ? 0 : (r.value.ok / n) * 100;
      return [
        r.run,
        String(n),
        String(r.value.ok),
        String(r.value.near),
        String(r.value['off-scale']),
        String(r.value.unresolved),
        `${hit.toFixed(1)}%`,
      ];
    }),
  ]);

  console.log('\n\n## 선언 원문 — 토큰 이름을 썼는가\n');
  table([
    ['run', 'var(--space-*)', 'px 직접', '이름 사용률'],
    ...rows.map((r) => {
      const t = r.byName + r.literal;
      return [r.run, String(r.byName), String(r.literal), t === 0 ? '-' : `${((r.byName / t) * 100).toFixed(1)}%`];
    }),
  ]);

  console.log('\n\n## 기하 층 — 선언과 화면이 갈라진 자리\n');
  table([
    ['run', 'mismatch', '실제 여백이 스케일 밖'],
    ...rows.map((r) => [r.run, String(r.mismatch), String(r.gapOffScale)]),
  ]);

  // 조건별 합계
  console.log('\n\n## 조건별 합계\n');
  const agg = CONDITIONS.map((c) => {
    const rs = rows.filter((r) => r.run.startsWith(c));
    if (rs.length === 0) return null;
    const ok = rs.reduce((a, r) => a + r.value.ok, 0);
    const near = rs.reduce((a, r) => a + r.value.near, 0);
    const off = rs.reduce((a, r) => a + r.value['off-scale'], 0);
    const unres = rs.reduce((a, r) => a + r.value.unresolved, 0);
    const n = ok + near + off + unres;
    const byName = rs.reduce((a, r) => a + r.byName, 0);
    const literal = rs.reduce((a, r) => a + r.literal, 0);
    return [
      c,
      String(rs.length),
      String(n),
      `${((ok / n) * 100).toFixed(1)}%`,
      String(near),
      String(off),
      byName + literal === 0 ? '-' : `${((byName / (byName + literal)) * 100).toFixed(1)}%`,
      String(rs.reduce((a, r) => a + r.mismatch, 0)),
    ];
  }).filter((x): x is string[] => x !== null);

  table([['조건', '회차', '간격 값', '스케일 적중률', 'near', 'off-scale', '토큰 이름 사용률', 'mismatch'], ...agg]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
