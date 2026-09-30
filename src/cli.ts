#!/usr/bin/env node
// verifront CLI
//
//   verifront check   <html>   아래 넷 중 설정으로 돌릴 수 있는 것을 전부 돌린다
//   verifront tokens  <css|html>  선언된 색을 토큰과 대조한다 (정적)
//   verifront runtime <html>   브라우저가 그린 색을 토큰과 대조한다
//   verifront spacing <html>   화면의 여백을 간격 스케일과 대조한다
//   verifront design  <html>   화면의 여백과 색을 피그마 시안과 대조한다
//
// 설정은 작업 폴더의 verifront.config.json 에서 읽는다. 옵션이 설정보다 앞선다.
//   { "tokens": ["tokens.json", "tokens-space.json"],
//     "design": { "snapshot": "design/snapshot.json", "frame": "card-list" } }
//
// 종료 코드: 0 실패 판정 없음 · 1 실패 판정 있음 · 2 사용법이나 설정 오류
// 실패와 보고의 경계는 FAILING 에 있다. 보고만 하는 판정은 검사하지 못한 자리이거나
// 검사기의 한계다. 생성물의 위반으로 치지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { checkCss, loadTokens, type Token } from './check.ts';
import { checkRuntime } from './runtime.ts';
import { checkSpacingHtml, loadSpaceTokens, type SpaceToken, type SpacingFinding } from './spacing.ts';
import { loadDesign, type Snapshot, type DesignNode } from './figma.ts';
import { checkDesign, type DesignFinding } from './design.ts';

const VERSION = '0.2.0';

/** 종료 코드에 반영하는 판정. 검사기마다 판정 이름이 겹치면 뜻도 같다 */
export const FAILING = new Set([
  'near',
  'violation',
  'unknown-token',
  'off-scale',
  'wrong-token',
  'misplaced',
  'missing',
  // 짝을 못 찾은 노드. 검사기의 한계일 수도 있지만 실패로 친다.
  // 보고로 두면 문제 있는 요소를 지우는 것만으로 실패가 줄어든다. 지울수록 점수가 오르는 검사는 쓸 수 없다
  'unmatched',
]);

type Command = 'check' | 'tokens' | 'runtime' | 'spacing' | 'design';
const COMMANDS: Command[] = ['check', 'tokens', 'runtime', 'spacing', 'design'];

interface Options {
  command: Command;
  target: string;
  json: boolean;
  all: boolean;
  config?: string;
  tokens?: string[];
  snapshot?: string;
  frame?: string;
}

interface Config {
  colorTokens: Token[];
  spaceTokens: SpaceToken[];
  design: { node: DesignNode; label: string; source: string } | null;
}

/** 검사기 하나의 결과를 한 모양으로 맞춘다 */
interface Line {
  verdict: string;
  /** 어디. 선택자, 줄, 시안 노드 경로 */
  where: string;
  prop: string;
  /** 기대한 값. 없으면 토큰 대조 */
  expected?: string;
  actual: string;
  token?: string;
  note?: string;
}

interface Report {
  checker: Exclude<Command, 'check'>;
  counts: Record<string, number>;
  failures: number;
  lines: Line[];
  notes: string[];
}

class UsageError extends Error {}

const HELP = `verifront ${VERSION}

사용법
  verifront check   <html>        설정으로 돌릴 수 있는 검사를 전부 돌린다
  verifront tokens  <css|html>    선언된 색을 토큰과 대조한다
  verifront runtime <html>        브라우저가 그린 색을 토큰과 대조한다
  verifront spacing <html>        화면의 여백을 간격 스케일과 대조한다
  verifront design  <html>        화면의 여백과 색을 피그마 시안과 대조한다

옵션
  --json               판정을 JSON 으로 낸다
  --all                ok 판정도 출력한다
  --config <파일>      설정 파일. 기본 ./verifront.config.json
  --tokens <파일,...>  토큰 파일. 설정의 tokens 대신 쓴다
  --snapshot <파일>    피그마 스냅숏. 설정의 design.snapshot 대신 쓴다
  --frame <이름>       스냅숏 안의 프레임 이름

종료 코드
  0 실패 판정 없음 · 1 실패 판정 있음 · 2 사용법이나 설정 오류

실패: ${[...FAILING].join(', ')}
보고만: alpha-variant, uncomputable, unresolved, mismatch, unmeasurable

브라우저는 Playwright 의 Chromium 을 쓴다. VERIFRONT_CHROME 에 실행 파일 경로를 주면 그것을 쓴다.`;

function parseArgs(argv: string[]): Options | 'help' | 'version' {
  const rest: string[] = [];
  const o: Partial<Options> = { json: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} 에 값이 없다`);
      return v;
    };
    if (a === '-h' || a === '--help') return 'help';
    if (a === '-v' || a === '--version') return 'version';
    else if (a === '--json') o.json = true;
    else if (a === '--all') o.all = true;
    else if (a === '--config') o.config = next();
    else if (a === '--tokens') o.tokens = next().split(',');
    else if (a === '--snapshot') o.snapshot = next();
    else if (a === '--frame') o.frame = next();
    else if (a.startsWith('--')) throw new UsageError(`모르는 옵션: ${a}`);
    else rest.push(a);
  }
  if (rest.length === 0) return 'help';
  const [command, target, ...extra] = rest;
  if (!COMMANDS.includes(command as Command)) throw new UsageError(`모르는 명령: ${command}`);
  if (!target) throw new UsageError(`${command} 에 대상 파일이 없다`);
  if (extra.length) throw new UsageError(`대상은 하나다: ${extra.join(' ')}`);
  if (!fs.existsSync(target)) throw new UsageError(`파일이 없다: ${target}`);
  return { ...(o as Options), command: command as Command, target };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`JSON 을 읽지 못했다: ${file} (${(e as Error).message})`);
  }
}

function loadConfig(o: Options): Config {
  const configPath = o.config ?? 'verifront.config.json';
  let raw: { tokens?: string | string[]; design?: { snapshot?: string; frame?: string } } = {};
  let base = process.cwd();
  if (fs.existsSync(configPath)) {
    raw = readJson(configPath) as typeof raw;
    base = path.dirname(path.resolve(configPath));
  } else if (o.config) {
    throw new UsageError(`설정 파일이 없다: ${o.config}`);
  }

  // 옵션으로 준 경로는 현재 폴더 기준, 설정의 경로는 설정 파일 기준이다
  const tokenFiles = o.tokens ?? [raw.tokens ?? []].flat().map((f) => path.resolve(base, f));
  if (tokenFiles.length === 0) throw new UsageError('토큰 파일이 없다. 설정의 tokens 나 --tokens 로 준다');

  // 여러 파일을 그룹 단위로 합친다. 색 로더와 간격 로더가 각자 자기 그룹만 읽는다
  const merged: Record<string, Record<string, string>> = {};
  for (const f of tokenFiles) {
    if (!fs.existsSync(f)) throw new UsageError(`토큰 파일이 없다: ${f}`);
    for (const [group, entries] of Object.entries(readJson(f) as Record<string, Record<string, string>>)) {
      merged[group] = { ...merged[group], ...entries };
    }
  }

  const snapPath = o.snapshot ?? (raw.design?.snapshot ? path.resolve(base, raw.design.snapshot) : undefined);
  let design: Config['design'] = null;
  if (snapPath) {
    if (!fs.existsSync(snapPath)) throw new UsageError(`스냅숏이 없다: ${snapPath}`);
    const label = o.frame ?? raw.design?.frame;
    const snapshot = readJson(snapPath) as Snapshot;
    // 프레임 이름은 figma-pull 이 붙인 이름(index 의 키)이다
    const names = Object.keys(snapshot.index ?? {});
    const pick = label ?? (names.length === 1 ? names[0] : undefined);
    if (!pick) throw new UsageError(`스냅숏에 프레임이 여럿이다. --frame 으로 고른다: ${names.join(', ')}`);
    try {
      design = { node: loadDesign(snapshot, pick), label: pick, source: snapPath };
    } catch (e) {
      throw new UsageError(`스냅숏에서 프레임을 읽지 못했다: ${pick} (${(e as Error).message})`);
    }
  }

  return { colorTokens: loadTokens(merged), spaceTokens: loadSpaceTokens(merged), design };
}

function count(lines: Line[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const l of lines) acc[l.verdict] = (acc[l.verdict] ?? 0) + 1;
  return acc;
}

function report(checker: Report['checker'], lines: Line[], notes: string[] = []): Report {
  return { checker, counts: count(lines), failures: lines.filter((l) => FAILING.has(l.verdict)).length, lines, notes };
}

/** HTML 이면 <style> 블록만 떼어 정적 검사한다. 줄 번호는 원래 파일 기준으로 맞춘다 */
function runTokens(target: string, cfg: Config): Report {
  const text = fs.readFileSync(target, 'utf8');
  const blocks: { css: string; offset: number }[] = [];
  if (/\.html?$/i.test(target)) {
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const start = m.index! + m[0].indexOf('>') + 1;
      blocks.push({ css: m[1]!, offset: text.slice(0, start).split('\n').length - 1 });
    }
  } else {
    blocks.push({ css: text, offset: 0 });
  }
  const lines: Line[] = [];
  for (const b of blocks) {
    for (const f of checkCss(b.css, target, cfg.colorTokens)) {
      lines.push({
        verdict: f.verdict,
        where: `L${f.line + b.offset}`,
        prop: f.prop,
        actual: f.raw,
        token: f.token,
        note: f.distance !== undefined && f.verdict !== 'ok' ? `ΔE00 ${f.distance}` : undefined,
      });
    }
  }
  const notes = /\.html?$/i.test(target) && blocks.length === 0 ? ['<style> 블록이 없다. 인라인 style 속성은 정적 검사하지 않는다'] : [];
  return report('tokens', lines, notes);
}

async function runRuntime(target: string, cfg: Config): Promise<Report> {
  const r = await checkRuntime(target, cfg.colorTokens);
  const lines: Line[] = r.findings.map((f) => ({
    verdict: f.verdict,
    where: `${f.state}:${f.selector}`,
    prop: f.prop,
    actual: f.raw,
    token: f.token,
    note: f.distance !== undefined && f.verdict !== 'ok' ? `ΔE00 ${f.distance}` : undefined,
  }));
  const notes = r.unstable.map((u) => `값이 멈추지 않았다: ${u.state} ${u.target}`);
  return report('runtime', lines, notes);
}

function spacingLine(f: SpacingFinding): Line {
  if (f.kind === 'value') {
    return { verdict: f.verdict, where: f.selector, prop: f.prop, actual: f.raw, token: f.token };
  }
  return {
    verdict: f.verdict,
    where: `${f.between[0]} ↔ ${f.between[1]}`,
    prop: `gap-${f.axis === 'vertical' ? 'y' : 'x'}`,
    actual: `${f.actual}px`,
    token: f.token,
    note: f.verdict === 'mismatch' ? `선언으로 예측한 값 ${f.predicted}px` : undefined,
  };
}

async function runSpacing(target: string, cfg: Config): Promise<Report> {
  if (cfg.spaceTokens.length === 0) return report('spacing', [], ['간격 토큰(space 그룹)이 없어 건너뛰었다']);
  const findings = await checkSpacingHtml(fs.readFileSync(target, 'utf8'), cfg.spaceTokens, {
    executablePath: process.env.VERIFRONT_CHROME,
  });
  return report('spacing', findings.map(spacingLine));
}

function designLine(f: DesignFinding): Line {
  return {
    verdict: f.verdict,
    where: f.target ? `${f.node} → ${f.target}` : f.node,
    prop: f.prop,
    expected: f.expected,
    actual: f.actual ?? '-',
    token: f.token,
    note: f.note,
  };
}

async function runDesign(target: string, cfg: Config): Promise<Report> {
  if (!cfg.design) return report('design', [], ['시안 스냅숏이 없어 건너뛰었다']);
  const r = await checkDesign(
    fs.readFileSync(target, 'utf8'),
    cfg.design.node,
    { color: cfg.colorTokens, space: cfg.spaceTokens },
    { executablePath: process.env.VERIFRONT_CHROME },
  );
  const m = r.match;
  const notes = [
    `시안 ${cfg.design.label} · 짝지을 노드 ${m.visual} · 못 찾음 ${m.unmatched}`,
  ];
  return report('design', r.findings.map(designLine), notes);
}

function printText(target: string, reports: Report[], all: boolean) {
  console.log(`대상: ${target}`);
  for (const r of reports) {
    console.log('');
    const counts = Object.entries(r.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
    console.log(`[${r.checker}] 실패 ${r.failures}${counts ? ` · ${counts}` : ''}`);
    for (const n of r.notes) console.log(`  ${n}`);
    for (const l of r.lines) {
      if (!all && l.verdict === 'ok') continue;
      const head = l.verdict.padEnd(13);
      const value = l.expected !== undefined ? `기대 ${l.expected} · 실제 ${l.actual}` : l.actual;
      const tail = [l.token ? `→ ${l.token}` : '', l.note ?? ''].filter(Boolean).join(' · ');
      console.log(`  ${head} ${l.prop.padEnd(18)} ${value}${tail ? `  (${tail})` : ''}`);
      console.log(`  ${' '.repeat(13)} ${l.where}`);
    }
  }
  const total = reports.reduce((s, r) => s + r.failures, 0);
  console.log('');
  console.log(total ? `실패 판정 ${total}개` : '실패 판정 없음');
}

export async function run(argv: string[]): Promise<number> {
  let o: ReturnType<typeof parseArgs>;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`verifront: ${e.message}\n\n${HELP}`);
      return 2;
    }
    throw e;
  }
  if (o === 'help') {
    console.log(HELP);
    return 0;
  }
  if (o === 'version') {
    console.log(VERSION);
    return 0;
  }

  let cfg: Config;
  try {
    cfg = loadConfig(o);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`verifront: ${e.message}`);
      return 2;
    }
    throw e;
  }

  // 직접 부른 검사를 못 돌리면 오류다. 건너뛴 채 0 으로 끝나면 통과처럼 보인다
  if (o.command === 'design' && !cfg.design) {
    console.error('verifront: 시안 스냅숏이 없다. 설정의 design.snapshot 이나 --snapshot 으로 준다');
    return 2;
  }
  if (o.command === 'spacing' && cfg.spaceTokens.length === 0) {
    console.error('verifront: 간격 토큰(space 그룹)이 없다');
    return 2;
  }

  const isHtml = /\.html?$/i.test(o.target);
  if (o.command !== 'tokens' && !isHtml) {
    console.error(`verifront: ${o.command} 는 HTML 파일을 받는다: ${o.target}`);
    return 2;
  }

  const reports: Report[] = [];
  const want = (c: Report['checker']) => o.command === 'check' || o.command === c;
  if (want('tokens')) reports.push(runTokens(o.target, cfg));
  if (want('runtime')) reports.push(await runRuntime(o.target, cfg));
  if (want('spacing')) reports.push(await runSpacing(o.target, cfg));
  if (want('design')) reports.push(await runDesign(o.target, cfg));

  const failures = reports.reduce((s, r) => s + r.failures, 0);
  if (o.json) {
    const out = reports.map((r) => ({ ...r, lines: o.all ? r.lines : r.lines.filter((l) => l.verdict !== 'ok') }));
    console.log(JSON.stringify({ version: VERSION, target: o.target, failures, reports: out }, null, 2));
  } else {
    printText(o.target, reports, o.all);
  }
  return failures ? 1 : 0;
}

// 직접 실행될 때만 돈다. 테스트에서 run() 을 불러 쓸 수 있게 한다
const self = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (/[\\/]cli\.(ts|js)$/.test(self)) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
