import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { checkCss, loadTokens, type Finding, type Verdict } from '../src/check.js';

const dir = path.join(process.cwd(), 'experiments');
const tokens = loadTokens(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')));

const VERDICTS: Verdict[] = ['ok', 'near', 'violation', 'alpha-variant', 'unknown-token'];

/** HTML 안의 <style> 블록만 뽑는다. 생성물이 .css 면 그대로 쓴다. */
function readCss(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.css')) return raw;
  return [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
}

/**
 * 생성물이 :root 등에 토큰을 스스로 정의했다면 그 선언부는 집계에서 뺀다.
 * 정의를 세면 토큰 개수만큼 ok 가 부풀어 조건 간 비교가 왜곡된다.
 */
function isTokenDefinition(f: Finding): boolean {
  return f.prop.startsWith('--');
}

interface Row {
  condition: string;
  run: string;
  declarations: number;
  counts: Record<Verdict, number>;
}

const rows: Row[] = [];

for (const condition of ['A', 'B']) {
  const conditionDir = path.join(dir, condition);
  if (!fs.existsSync(conditionDir)) continue;

  for (const name of fs.readdirSync(conditionDir).sort()) {
    if (!/\.(html|css)$/.test(name)) continue;
    const css = readCss(path.join(conditionDir, name));

    const findings = checkCss(css, name, tokens, { includeEffects: true }).filter((f) => !isTokenDefinition(f));

    const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
    for (const f of findings) counts[f.verdict]++;

    rows.push({ condition, run: name, declarations: findings.length, counts });

    // 위반 상세는 파일로 남긴다. 글에 인용할 원본이 된다.
    const detail = findings
      .filter((f) => f.verdict !== 'ok')
      .map(
        (f) =>
          `${String(f.line).padStart(4)}  ${f.prop.padEnd(18)} ${f.raw.padEnd(30)} ${f.verdict.padEnd(14)} ${f.token ?? ''} ${f.distance !== undefined ? 'ΔE ' + f.distance : ''}`,
      )
      .join('\n');
    fs.writeFileSync(path.join(conditionDir, name.replace(/\.(html|css)$/, '.report.txt')), detail + '\n');
  }
}

if (rows.length === 0) {
  console.log('experiments/A, experiments/B 에 생성물이 없다.');
  process.exit(0);
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`\n조건  회차            색선언  ${VERDICTS.map((v) => pad(v, 14)).join('')}`);
for (const r of rows) {
  console.log(
    `  ${r.condition}   ${r.run.padEnd(16)}${pad(r.declarations, 4)}  ${VERDICTS.map((v) => pad(r.counts[v], 14)).join('')}`,
  );
}

console.log('\n--- 조건별 합계 ---');
for (const condition of ['A', 'B']) {
  const sub = rows.filter((r) => r.condition === condition);
  if (!sub.length) continue;
  const total = sub.reduce((s, r) => s + r.declarations, 0);
  if (total === 0) {
    console.log(`조건 ${condition}  회차 ${sub.length}  색 선언이 0건이다. 생성물이 비었거나 검사 대상 속성이 없다.`);
    continue;
  }
  const sum = Object.fromEntries(VERDICTS.map((v) => [v, sub.reduce((s, r) => s + r.counts[v], 0)])) as Record<
    Verdict,
    number
  >;

  // 사람이 리뷰로 잡을 수 없는 위반: 미세차 + 미정의 토큰 참조
  const invisible = sum.near + sum['unknown-token'];
  const failures = sum.near + sum.violation + sum['unknown-token'];

  console.log(
    `조건 ${condition}  회차 ${sub.length}  색선언 ${total}  ` +
      `위반 ${failures} (${((failures / total) * 100).toFixed(1)}%)  ` +
      `그중 육안으로 못 잡는 것 ${invisible} (${failures ? ((invisible / failures) * 100).toFixed(1) : 0}%)`,
  );
  console.log(`        ${VERDICTS.map((v) => `${v} ${sum[v]}`).join('  ')}`);
}
console.log();
