// 생성물 12개를 시안 스냅숏에 대고 판정한다.
// 실행: npx tsx scripts/run-design-experiment.ts [스냅숏] [이름]
//   기본 스냅숏 experiments/figma/snapshot.json, 기본 이름 card-list
//
// 모델은 시안을 본 적이 없다. 그래서 시안 일치율은 모델의 실력이 아니다. 재는 것은 둘이다.
//   1. 스케일 검사가 통과시킨 여백 중 시안의 값과 다른 것이 얼마나 되는가. 5편의 검사기로는 보이지 않던 자리다.
//   2. 같은 조건의 세 회차가 같은 자리에 같은 값을 넣었는가. 이건 시안의 값과 상관없다.
//      세 회차가 서로 다르면 어떤 시안을 가져와도 그 자리는 적어도 한 회차가 틀린다.
//
// 자리는 시안의 구조가 정한다. 값은 정하지 않는다. 구조가 같은 시안이면 2번의 숫자는 바뀌지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { loadTokens } from '../src/check.ts';
import { loadSpaceTokens } from '../src/spacing.ts';
import { loadDesign, type Snapshot } from '../src/figma.ts';
import { checkDesign, type DesignFinding, type DesignVerdict } from '../src/design.ts';

const dir = path.join(process.cwd(), 'experiments');
const [snapPath = path.join(dir, 'figma', 'snapshot.json'), label = 'card-list'] = process.argv.slice(2);
if (!fs.existsSync(snapPath)) {
  console.error(`스냅숏이 없다: ${snapPath}`);
  console.error('먼저 받는다: npx tsx scripts/figma-pull.ts card-list="<프레임 링크>"');
  process.exit(1);
}
const snapshot = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as Snapshot;
const design = loadDesign(snapshot, label);
const tokens = {
  color: loadTokens(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'))),
  space: loadSpaceTokens(JSON.parse(fs.readFileSync(path.join(dir, 'tokens-space.json'), 'utf8'))),
};

const CONDITIONS = ['A', 'B', 'C', 'D'] as const;
const SPACE_V: DesignVerdict[] = ['ok', 'near', 'wrong-token', 'off-scale', 'misplaced', 'unmeasurable'];
const COLOR_V: DesignVerdict[] = ['ok', 'near', 'wrong-token', 'violation', 'alpha-variant', 'missing', 'unmeasurable'];
const isSpace = (f: DesignFinding) => /^(gap|inset)-/.test(f.prop);
const isColor = (f: DesignFinding) => ['fill', 'stroke', 'text-color', 'line'].includes(f.prop);
/** 재서 판정이 선 자리. 못 잰 자리는 분모에서 뺀다 */
const judged = (f: DesignFinding) => f.verdict !== 'unmeasurable';
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');
const count = (fs: DesignFinding[], v: DesignVerdict) => fs.filter((f) => f.verdict === v).length;

function table(rows: string[][]) {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => [...(r[i] ?? '')].length)));
  const pad = (c: string, n: number) => c + ' '.repeat(Math.max(0, n - [...c].length));
  for (const [i, r] of rows.entries()) {
    console.log('| ' + r.map((c, j) => pad(c ?? '', w[j]!)).join(' | ') + ' |');
    if (i === 0) console.log('|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|');
  }
  console.log('');
}

interface Run {
  run: string;
  cond: string;
  findings: DesignFinding[];
  match: Awaited<ReturnType<typeof checkDesign>>['match'];
}

async function main() {
  const runs: Run[] = [];
  for (const c of CONDITIONS) {
    for (const r of [1, 2, 3]) {
      const file = path.join(dir, c, `run${r}.html`);
      const res = await checkDesign(fs.readFileSync(file, 'utf8'), design, tokens, {
        executablePath: process.env.VERIFRONT_CHROME,
      });
      runs.push({ run: `${c}${r}`, cond: c, findings: res.findings, match: res.match });
    }
  }

  console.log(`시안: ${snapshot.source} · ${snapshot.file.name} · ${label} · version ${snapshot.file.version}`);
  console.log(`토큰: 색 ${tokens.color.length}개, 간격 ${tokens.space.length}개\n`);

  console.log('## 짝짓기\n');
  table([
    ['run', '노드', '글자', '끌어올림', '순서', '테두리', '못 찾음', '풀어헤친 묶음'],
    ...runs.map((x) => [x.run, x.match.visual, x.match.byText, x.match.byLift, x.match.byOrder, x.match.byBorder, x.match.unmatched, x.match.flattened].map(String)),
  ]);

  console.log('## 여백 — 이 자리의 값이 시안의 값인가\n');
  table([
    ['run', '자리', ...SPACE_V, '시안 일치율'],
    ...runs.map((x) => {
      const s = x.findings.filter(isSpace);
      const n = s.filter(judged).length;
      return [x.run, String(s.length), ...SPACE_V.map((v) => String(count(s, v))), pct(count(s, 'ok'), n)];
    }),
  ]);

  console.log('## 여백 — 5편의 스케일 검사와 나란히\n');
  console.log('같은 자리의 화면 값을 스케일에만 대 본 결과와 시안에 대 본 결과. 순서가 바뀐 자리와 못 잰 자리는 뺐다.\n');
  table([
    ['run', '잰 자리', '스케일 통과', '시안 일치', '스케일 통과 · 시안 불일치'],
    ...runs.map((x) => {
      const s = x.findings.filter((f) => isSpace(f) && f.scale && f.verdict !== 'unmeasurable');
      const pass = s.filter((f) => f.scale === 'ok');
      return [x.run, String(s.length), pct(pass.length, s.length), pct(count(s, 'ok'), s.length), String(pass.filter((f) => f.verdict !== 'ok').length)];
    }),
  ]);

  console.log('## 색 — 이 자리의 색이 시안의 색인가\n');
  table([
    ['run', '자리', ...COLOR_V, '시안 일치율'],
    ...runs.map((x) => {
      const s = x.findings.filter(isColor);
      const n = s.filter(judged).length;
      return [x.run, String(s.length), ...COLOR_V.map((v) => String(count(s, v))), pct(count(s, 'ok'), n)];
    }),
  ]);

  console.log('## 조건별 합계\n');
  table([
    ['조건', '여백 시안 일치율', '여백 스케일 통과 · 시안 불일치', '색 시안 일치율', 'wrong-token (여백+색)'],
    ...CONDITIONS.map((c) => {
      const all = runs.filter((x) => x.cond === c).flatMap((x) => x.findings);
      const sp = all.filter((f) => isSpace(f) && judged(f));
      const co = all.filter((f) => isColor(f) && judged(f));
      const passNot = sp.filter((f) => f.scale === 'ok' && f.verdict !== 'ok' && f.verdict !== 'misplaced').length;
      return [c, pct(count(sp, 'ok'), sp.length), String(passNot), pct(count(co, 'ok'), co.length), String(count(all, 'wrong-token'))];
    }),
  ]);

  console.log('## 회차 간 일치 — 시안의 값과 상관없는 하한\n');
  console.log('세 회차가 모두 잰 여백 자리만 센다. 자리마다 가장 많이 나온 값에서 벗어난 회차 수를 더한 것이 하한이다.');
  console.log('어떤 시안도 한 자리에 값을 하나만 줄 수 있으니 이만큼은 반드시 틀린다.\n');
  const rows: string[][] = [['조건', '세 회차가 다 잰 자리', '세 회차가 같은 자리', '칸', '최소 불일치 칸', '어떤 시안에도 최대 일치율']];
  const detail = new Map<string, string[][]>();
  for (const c of CONDITIONS) {
    const rs = runs.filter((x) => x.cond === c);
    const key = (f: DesignFinding) => `${f.prop} ${f.node}`;
    const maps = rs.map((x) => new Map(x.findings.filter((f) => isSpace(f) && f.verdict !== 'unmeasurable' && f.verdict !== 'misplaced').map((f) => [key(f), f.actual!])));
    const keys = [...maps[0]!.keys()].filter((k) => maps.every((m) => m.has(k)));
    let agree = 0;
    let miss = 0;
    const lines: string[][] = [];
    for (const k of keys) {
      const vals = maps.map((m) => m.get(k)!);
      const freq = new Map<string, number>();
      for (const v of vals) freq.set(v, (freq.get(v) ?? 0) + 1);
      const top = Math.max(...freq.values());
      if (top === vals.length) agree++;
      else lines.push([k, ...vals]);
      miss += vals.length - top;
    }
    const cells = keys.length * rs.length;
    rows.push([c, String(keys.length), String(agree), String(cells), String(miss), pct(cells - miss, cells)]);
    detail.set(c, lines);
  }
  table(rows);
  for (const c of CONDITIONS) {
    const lines = detail.get(c)!;
    if (!lines.length) continue;
    console.log(`### ${c} — 회차마다 값이 다른 자리\n`);
    table([['자리', `${c}1`, `${c}2`, `${c}3`], ...lines]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
