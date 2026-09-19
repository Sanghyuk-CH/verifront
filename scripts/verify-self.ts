import fs from 'node:fs';
import path from 'node:path';
import { checkCss, loadTokens, type Verdict } from '../src/check.ts';
import { checkRuntime } from '../src/runtime.ts';
import { loadSpaceTokens } from '../src/spacing.ts';
import { loadDesign, type Snapshot } from '../src/figma.ts';
import { checkDesign, type DesignVerdict } from '../src/design.ts';

/** expected.json 에 적힌 판정만 센다. */
type Counted = Verdict | DesignVerdict;

interface Line {
  where: string;
  prop: string;
  raw: string;
  verdict: Counted;
  token?: string;
  distance?: number;
}

const dir = path.join(process.cwd(), 'fixtures');
const tokens = loadTokens(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));

let failed = false;

for (const [file, exp] of Object.entries(expected) as [string, Record<Counted, number>][]) {
  let lines: Line[];
  if (file.startsWith('figma/')) {
    // 시안 대조. 스냅숏과 토큰은 fixtures/figma 안의 것만 쓴다. 실험 폴더와 섞지 않는다.
    const fdir = path.join(dir, 'figma');
    const snapshot = JSON.parse(fs.readFileSync(path.join(fdir, 'card.json'), 'utf8')) as Snapshot;
    const tj = JSON.parse(fs.readFileSync(path.join(fdir, 'tokens.json'), 'utf8'));
    const r = await checkDesign(
      fs.readFileSync(path.join(dir, file), 'utf8'),
      loadDesign(snapshot, 'card-list'),
      { color: loadTokens(tj), space: loadSpaceTokens(tj) },
      { executablePath: process.env.VERIFRONT_CHROME },
    );
    lines = r.findings.map((f) => ({
      where: f.node,
      prop: f.prop,
      raw: `${f.expected} → ${f.actual ?? '-'}`,
      verdict: f.verdict,
      token: f.token,
    }));
  } else if (file.endsWith('.html')) {
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
  // 시안 검사는 ok 도 센다. 재지 않고 넘어가는 길이 있어서 문제 개수만 세면 판정이 빠져도 통과한다.
  const keys = Object.keys(exp) as Counted[];
  const actual = new Map<Counted, number>(keys.map((k) => [k, 0]));
  for (const f of lines) {
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
      if (f.verdict === 'ok') continue;
      console.log(`      ${f.where.padEnd(28)} ${f.prop.padEnd(18)} ${f.raw.padEnd(28)} ${f.verdict.padEnd(14)} ${f.token ?? ''} ${f.distance ?? ''}`);
    }
  }
}

process.exit(failed ? 1 : 0);
