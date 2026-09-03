import fs from 'node:fs';
import path from 'node:path';
import { checkCss, loadTokens, type Verdict } from '../src/check.ts';
import { checkRuntime } from '../src/runtime.ts';

/** expected.json 이 세는 판정. 'ok' 는 집계 대상이 아니다. */
type Counted = Exclude<Verdict, 'ok'>;

interface Line {
  where: string;
  prop: string;
  raw: string;
  verdict: Verdict;
  token?: string;
  distance?: number;
}

const dir = path.join(process.cwd(), 'fixtures');
const tokens = loadTokens(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));

let failed = false;

for (const [file, exp] of Object.entries(expected) as [string, Record<Counted, number>][]) {
  let lines: Line[];
  if (file.endsWith('.html')) {
    // 런타임 항등 테스트. 브라우저가 없으면 실패다. 건너뛰지 않는다.
    const r = await checkRuntime(path.join(dir, file), tokens);
    lines = r.findings.map((f) => ({ where: `${f.state}:${f.selector}`, ...f }));
    if (r.unstable.length) {
      failed = true;
      console.log(`✗ ${file}  안정화 상한 안에 값이 멈추지 않았다: ${JSON.stringify(r.unstable)}`);
    }
  } else {
    lines = checkCss(fs.readFileSync(path.join(dir, file), 'utf8'), file, tokens).map((f) => ({
      where: `L${f.line}`,
      ...f,
    }));
  }

  // 집계 대상은 expected.json 이 정한다. 판정이 늘어도 여기를 고칠 일이 없다.
  const keys = Object.keys(exp) as Counted[];
  const actual = new Map<Counted, number>(keys.map((k) => [k, 0]));
  for (const f of lines) {
    if (f.verdict === 'ok') continue;
    const prev = actual.get(f.verdict);
    if (prev !== undefined) actual.set(f.verdict, prev + 1);
  }

  const mismatch = keys.filter((k) => exp[k] !== actual.get(k));
  console.log(`${mismatch.length ? '✗' : '✓'} ${file}`);
  for (const k of keys) {
    const mark = mismatch.includes(k) ? '  ←' : '';
    console.log(`    ${k.padEnd(14)} 기대 ${exp[k]}  실제 ${actual.get(k)}${mark}`);
  }
  if (mismatch.length) {
    failed = true;
    for (const f of lines) {
      console.log(`      ${f.where.padEnd(28)} ${f.prop.padEnd(18)} ${f.raw.padEnd(28)} ${f.verdict.padEnd(14)} ${f.token ?? ''} ${f.distance ?? ''}`);
    }
  }
}

process.exit(failed ? 1 : 0);
