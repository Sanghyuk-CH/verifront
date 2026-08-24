import fs from 'node:fs';
import path from 'node:path';
import { checkCss, loadTokens, type Verdict } from '../src/check.ts';

/** expected.json 이 세는 판정. 'ok' 는 집계 대상이 아니다. */
type Counted = Exclude<Verdict, 'ok'>;

const dir = path.join(process.cwd(), 'fixtures');
const tokens = loadTokens(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));

let failed = false;

for (const [file, exp] of Object.entries(expected) as [string, Record<Counted, number>][]) {
  const findings = checkCss(fs.readFileSync(path.join(dir, file), 'utf8'), file, tokens);
  // 집계 대상은 expected.json 이 정한다. 판정이 늘어도 여기를 고칠 일이 없다.
  const keys = Object.keys(exp) as Counted[];
  const actual = new Map<Counted, number>(keys.map((k) => [k, 0]));
  for (const f of findings) {
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
    for (const f of findings) {
      console.log(`      L${String(f.line).padStart(3)}  ${f.prop.padEnd(18)} ${f.raw.padEnd(28)} ${f.verdict.padEnd(14)} ${f.token ?? ''} ${f.distance ?? ''}`);
    }
  }
}

process.exit(failed ? 1 : 0);
