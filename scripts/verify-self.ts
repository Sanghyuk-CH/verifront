import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkCss, loadTokens, type Verdict } from '../src/check.ts';
import { checkRuntime } from '../src/runtime.ts';
import { loadSpaceTokens } from '../src/spacing.ts';
import { loadDesign, type Snapshot } from '../src/figma.ts';
import { checkDesign, type DesignVerdict } from '../src/design.ts';
import { run } from '../src/cli.ts';

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

// CLI 종료 코드. 스킬은 이 숫자로 통과를 판단한다. 판정이 맞아도 종료 코드가 틀리면 루프가 틀린다
{
  const clean = fs.readFileSync('fixtures/figma/clean.html', 'utf8');
  const cut = path.join(os.tmpdir(), 'verifront-cut.html');
  const removed = clean.replace(/<p class="meta">[^<]*<\/p>/, '');
  if (removed === clean) throw new Error('지울 메타 줄을 찾지 못했다. fixtures/figma/clean.html 이 바뀌었다');
  fs.writeFileSync(cut, removed);
  const cases: [string[], number][] = [
    [['tokens', 'fixtures/clean.css', '--tokens', 'fixtures/tokens.json'], 0],
    [['tokens', 'fixtures/dirty.css', '--tokens', 'fixtures/tokens.json'], 1],
    [['runtime', 'fixtures/clean.html', '--tokens', 'fixtures/tokens.json'], 0],
    [['runtime', 'fixtures/dirty.html', '--tokens', 'fixtures/tokens.json'], 1],
    [['design', 'fixtures/figma/clean.html', '--tokens', 'fixtures/figma/tokens.json', '--snapshot', 'fixtures/figma/card.json'], 0],
    [['design', 'fixtures/figma/reshaped.html', '--tokens', 'fixtures/figma/tokens.json', '--snapshot', 'fixtures/figma/card.json'], 0],
    [['design', 'fixtures/figma/dirty.html', '--tokens', 'fixtures/figma/tokens.json', '--snapshot', 'fixtures/figma/card.json'], 1],
    // 스냅숏 없이 design 을 부르면 건너뛰고 0 이 아니라 오류다
    [['design', 'fixtures/figma/clean.html', '--tokens', 'fixtures/figma/tokens.json'], 2],
    // 요소를 지워서 실패를 없앨 수 없어야 한다. clean 에서 메타 줄 하나를 지운 것
    [['design', cut, '--tokens', 'fixtures/figma/tokens.json', '--snapshot', 'fixtures/figma/card.json'], 1],
    [['nope', 'fixtures/clean.css'], 2],
  ];
  const log = console.log;
  const err = console.error;
  for (const [args, want] of cases) {
    console.log = () => {};
    console.error = () => {};
    let got: number;
    try {
      got = await run(args);
    } finally {
      console.log = log;
      console.error = err;
    }
    const ok = got === want;
    if (!ok) failed = true;
    console.log(`${ok ? '✓' : '✗'} cli ${args[0]} ${args[1] === cut ? '(메타 줄 삭제)' : args[1]}${args.includes('--snapshot') || args[0] !== 'design' ? '' : ' (스냅숏 없음)'}  기대 ${want}  실제 ${got}`);
  }
}

process.exit(failed ? 1 : 0);
