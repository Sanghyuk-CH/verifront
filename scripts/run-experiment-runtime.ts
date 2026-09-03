// 3편 생성물 9개를 런타임 검사로 재판정한다. 정적 검사 결과와 나란히 놓는다.
// 실행: npx tsx scripts/run-experiment-runtime.ts
// 판정 단위가 다르다. 정적은 (줄, 선언), 런타임은 (선택자 경로, 속성, 상태). 건수는 직접 비교하지 않는다.
// 비교하는 것은 값이다. 정적이 본 값의 집합과 런타임이 본 값의 집합.

import fs from 'node:fs';
import path from 'node:path';
import { formatHex, formatHex8 } from 'culori';
import { chromium } from 'playwright';
import { checkCss, loadTokens, type Finding, type Verdict } from '../src/check.ts';
import { normalize } from '../src/normalize.ts';
import { checkRuntime, type RuntimeFinding, type State } from '../src/runtime.ts';

const dir = path.join(process.cwd(), 'experiments');
const tokens = loadTokens(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')));
const VERDICTS: Verdict[] = ['ok', 'near', 'violation', 'alpha-variant', 'unknown-token', 'uncomputable'];
const STATES: State[] = ['default', 'hover', 'disabled'];

function readCss(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  return [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
}

/** 정적 finding 의 최종 값을 hex 로. var() 는 화살표 뒤가 값이다. */
function staticHex(f: Finding): string | null {
  const v = f.raw.includes('→') ? f.raw.split('→').pop()!.trim() : f.raw;
  const n = normalize(v);
  if (n.kind !== 'color') return null;
  return (n.rgb.alpha ?? 1) < 1 ? formatHex8(n.rgb) : formatHex(n.rgb);
}
function runtimeHex(f: RuntimeFinding): string | null {
  const n = normalize(f.raw);
  if (n.kind !== 'color') return null;
  return (n.rgb.alpha ?? 1) < 1 ? formatHex8(n.rgb) : formatHex(n.rgb);
}

const count = <T extends { verdict: Verdict }>(xs: T[]) => {
  const c = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const x of xs) c[x.verdict]++;
  return c;
};
const pad = (s: string | number, n: number) => String(s).padStart(n);

const executablePath = process.env.VERIFRONT_CHROME;
const browser = await chromium.launch({ executablePath, args: executablePath ? ['--no-sandbox'] : [] });

interface Row {
  run: string;
  static: Record<Verdict, number>;
  staticN: number;
  runtime: Record<Verdict, number>;
  runtimeN: number;
  byState: Record<State, Record<Verdict, number>>;
  onlyStatic: string[];
  onlyRuntime: { hex: string; where: string; verdict: Verdict; token?: string; distance?: number }[];
  unstable: number;
}
const rows: Row[] = [];
let browserVersion = '';

for (const condition of ['A', 'B', 'C']) {
  for (const name of fs.readdirSync(path.join(dir, condition)).sort()) {
    if (!name.endsWith('.html')) continue;
    const file = path.join(dir, condition, name);
    const run = `${condition}/${name.replace('.html', '')}`;

    const st = checkCss(readCss(file), name, tokens, { includeEffects: true }).filter((f) => !f.prop.startsWith('--'));
    const rt = await checkRuntime(file, tokens, { browser });
    browserVersion = rt.browserVersion;

    const staticValues = new Map<string, Finding>();
    for (const f of st) {
      const h = staticHex(f);
      if (h && !staticValues.has(h)) staticValues.set(h, f);
    }
    const runtimeValues = new Map<string, RuntimeFinding>();
    for (const f of rt.findings) {
      const h = runtimeHex(f);
      if (h && !runtimeValues.has(h)) runtimeValues.set(h, f);
    }

    const onlyStatic = [...staticValues.keys()].filter((h) => !runtimeValues.has(h));
    const onlyRuntime = [...runtimeValues.entries()]
      .filter(([h]) => !staticValues.has(h))
      .map(([hex, f]) => ({ hex, where: `${f.state}:${f.selector} ${f.prop}`, verdict: f.verdict, token: f.token, distance: f.distance }));

    rows.push({
      run,
      static: count(st),
      staticN: st.length,
      runtime: count(rt.findings),
      runtimeN: rt.findings.length,
      byState: Object.fromEntries(STATES.map((s) => [s, count(rt.findings.filter((f) => f.state === s))])) as Row['byState'],
      onlyStatic,
      onlyRuntime,
      unstable: rt.unstable.length,
    });

    // 회차별 런타임 상세를 파일로 남긴다. 글에 인용할 원본이다.
    const detail = rt.findings
      .map(
        (f) =>
          `${f.state.padEnd(8)} ${f.selector.padEnd(44)} ${f.prop.padEnd(20)} ${f.raw.padEnd(42)} ${f.verdict.padEnd(14)} ${f.token ?? ''} ${f.distance !== undefined ? 'ΔE ' + f.distance : ''}`,
      )
      .join('\n');
    fs.writeFileSync(path.join(dir, condition, name.replace('.html', '.runtime.txt')), detail + '\n');
  }
}
await browser.close();

console.log(`browser: chromium ${browserVersion}\n`);
console.log('== 판정 분포 (정적 / 런타임) ==');
console.log(`회차       ${VERDICTS.map((v) => pad(v, 14)).join('')}     건수`);
for (const r of rows) {
  console.log(`${r.run.padEnd(8)} S ${VERDICTS.map((v) => pad(r.static[v], 14)).join('')}  ${pad(r.staticN, 6)}`);
  console.log(`${''.padEnd(8)} R ${VERDICTS.map((v) => pad(r.runtime[v], 14)).join('')}  ${pad(r.runtimeN, 6)}${r.unstable ? `  unstable ${r.unstable}` : ''}`);
}

console.log('\n== 런타임 상태별 ==');
console.log(`회차       상태      ${VERDICTS.map((v) => pad(v, 14)).join('')}`);
for (const r of rows) for (const s of STATES) console.log(`${r.run.padEnd(8)}   ${s.padEnd(9)}${VERDICTS.map((v) => pad(r.byState[s][v], 14)).join('')}`);

console.log('\n== 값 대조: 정적만 본 값 / 런타임만 본 값 ==');
for (const r of rows) {
  console.log(`\n${r.run}  정적만 ${r.onlyStatic.length}  런타임만 ${r.onlyRuntime.length}`);
  if (r.onlyStatic.length) console.log(`  정적만: ${r.onlyStatic.join(' ')}`);
  for (const o of r.onlyRuntime) console.log(`  런타임만: ${o.hex.padEnd(10)} ${o.verdict.padEnd(14)} ${(o.token ?? '').padEnd(22)} ${o.distance !== undefined ? 'ΔE ' + o.distance : ''}  ${o.where}`);
}

console.log('\n== 조건별 합계 (런타임) ==');
for (const c of ['A', 'B', 'C']) {
  const sub = rows.filter((r) => r.run.startsWith(c));
  const sum = Object.fromEntries(VERDICTS.map((v) => [v, sub.reduce((s, r) => s + r.runtime[v], 0)])) as Record<Verdict, number>;
  const n = sub.reduce((s, r) => s + r.runtimeN, 0);
  console.log(`조건 ${c}  판정 ${n}  ${VERDICTS.map((v) => `${v} ${sum[v]}`).join('  ')}`);
}
