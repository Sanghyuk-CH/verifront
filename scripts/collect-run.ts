// 작업 폴더 한 곳의 결과를 레포로 옮긴다.
// 실행: npx tsx scripts/collect-run.ts <작업 폴더> E0|E1 <회차> [--force]
//
// 옮기는 것
//   <작업 폴더>/card-list.html          → experiments/<조건>/run<회차>.html
//   그 폴더에서 연 Claude Code 세션 로그 → experiments/<조건>/run<회차>.jsonl
//   모델명, 날짜, 레포 커밋             → experiments/<조건>/runs.json
//
// 세션 로그는 ~/.claude/projects 아래 jsonl 이다. 폴더 이름 규칙에 기대지 않고
// 줄마다 적힌 cwd 가 작업 폴더인 파일을 찾는다.
// 로그에는 홈 폴더 경로가 들어 있다. 옮길 때 ~ 로 바꾼다. 작업 폴더 경로는 <workspace> 로 바꾼다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const force = args.includes('--force');
const [wsArg, cond, runArg] = args.filter((a) => a !== '--force');
if (!wsArg || (cond !== 'E0' && cond !== 'E1' && cond !== 'E1b') || !/^[1-9]$/.test(runArg ?? '')) {
  console.error("사용법: npx tsx scripts/collect-run.ts <작업 폴더> E0|E1|E1b <회차> [--force]");
  process.exit(2);
}

const ws = fs.realpathSync(path.resolve(wsArg));
const html = path.join(ws, 'card-list.html');
if (!fs.existsSync(html)) {
  console.error(`결과 파일이 없다: ${html}\n모델이 다른 이름으로 저장했으면 그 사실을 기록하고 card-list.html 로 복사한 뒤 다시 실행한다`);
  process.exit(2);
}

const outDir = path.join(process.cwd(), 'experiments', cond);
const outHtml = path.join(outDir, `run${runArg}.html`);
const outLog = path.join(outDir, `run${runArg}.jsonl`);
if (!force && (fs.existsSync(outHtml) || fs.existsSync(outLog))) {
  console.error(`이미 있다: ${path.relative(process.cwd(), outHtml)}\n덮어쓰려면 --force`);
  process.exit(2);
}

// ── 세션 로그 찾기 ────────────────────────────────────────

interface Entry {
  type?: string;
  cwd?: string;
  timestamp?: string;
  message?: { model?: string; content?: unknown };
}

const projects = path.join(os.homedir(), '.claude', 'projects');
const candidates: { file: string; mtime: number }[] = [];
if (fs.existsSync(projects)) {
  for (const d of fs.readdirSync(projects)) {
    const sub = path.join(projects, d);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(sub, f);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const hit = lines.some((l) => {
        if (!l.includes('"cwd"')) return false;
        try {
          const cwd = (JSON.parse(l) as Entry).cwd;
          return !!cwd && (cwd === ws || (fs.existsSync(cwd) && fs.realpathSync(cwd) === ws));
        } catch {
          return false;
        }
      });
      if (hit) candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
}

if (candidates.length === 0) {
  console.error(`이 폴더에서 연 세션 로그를 찾지 못했다: ${ws}\n찾은 곳: ${projects}`);
  process.exit(1);
}
candidates.sort((a, b) => b.mtime - a.mtime);
if (candidates.length > 1) {
  console.warn(`세션이 ${candidates.length}개다. 가장 최근 것을 쓴다. 한 회차는 세션 하나여야 한다`);
  for (const c of candidates) console.warn(`  ${new Date(c.mtime).toISOString()}  ${c.file}`);
}
const logFile = candidates[0]!.file;
const raw = fs.readFileSync(logFile, 'utf8');

// ── 옮기기 ───────────────────────────────────────────────

const esc = (s: string) => JSON.stringify(s).slice(1, -1);
let redacted = raw;
for (const p of new Set([ws, path.resolve(wsArg)])) redacted = redacted.split(esc(p)).join('<workspace>');
redacted = redacted.split(esc(os.homedir())).join('~');

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(html, outHtml);
fs.writeFileSync(outLog, redacted);

// ── 요약 ─────────────────────────────────────────────────

// 경로를 가린 뒤의 로그로 센다. 작업 폴더 경로(~/verifront-runs/...)가 verifront 실행으로 잡히지 않게
const entries: Entry[] = redacted
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as Entry;
    } catch {
      return {};
    }
  });

interface Block {
  type?: string;
  name?: string;
  text?: string;
  input?: { command?: string; file_path?: string; skill?: string };
}
const blocks = (e: Entry): Block[] => (Array.isArray(e.message?.content) ? (e.message!.content as Block[]) : []);
const assistant = entries.filter((e) => e.type === 'assistant');
const tools = assistant.flatMap(blocks).filter((b) => b.type === 'tool_use');
const models = [...new Set(assistant.map((e) => e.message?.model).filter(Boolean))] as string[];
// 검사기를 실제로 돌린 명령만 센다. SKILL.md 나 verifront.config.json 을 cat 한 것은 실행이 아니다
const checks = tools.filter((b) => /check\.sh|npx\s+verifront\b|\.bin[\\/]verifront\b|dist[\\/]cli\.js/.test(b.input?.command ?? ''));
// Read 로 열든 Bash 의 cat 으로 열든 스킬을 읽은 것으로 센다
const skillLoaded = tools.some(
  (b) => b.name === 'Skill' || /verifront-check[\\/]SKILL\.md$/.test(b.input?.file_path ?? '') || /verifront-check[\\/]SKILL\.md/.test(b.input?.command ?? ''),
);
const times = entries.map((e) => e.timestamp).filter(Boolean).sort() as string[];
const lastText = [...assistant]
  .reverse()
  .flatMap(blocks)
  .find((b) => b.type === 'text' && b.text?.trim())?.text?.trim();

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const metaFile = path.join(outDir, 'runs.json');
const meta = fs.existsSync(metaFile) ? (JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, unknown>) : {};
meta[`run${runArg}`] = {
  models,
  started: times[0] ?? null,
  ended: times[times.length - 1] ?? null,
  commit,
  toolCalls: tools.length,
  verifrontRuns: checks.length,
  skillLoaded,
};
fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');

console.log(`${cond} run${runArg}`);
console.log(`  생성물   ${path.relative(process.cwd(), outHtml)}`);
console.log(`  로그     ${path.relative(process.cwd(), outLog)}  (${(redacted.length / 1024).toFixed(0)}KB)`);
console.log(`  모델     ${models.join(', ') || '(로그에 없음)'}`);
console.log(`  시간     ${times[0] ?? '-'} → ${times[times.length - 1] ?? '-'}`);
console.log(`  도구 호출 ${tools.length} · verifront 실행 ${checks.length} · 스킬 로드 ${skillLoaded ? '예' : '아니오'}`);
if (cond === 'E0' && (checks.length || skillLoaded)) console.warn('  ⚠ E0 인데 verifront 를 불렀다. 작업 폴더가 오염됐는지 본다');
if (models.length > 1) console.warn('  ⚠ 모델이 둘 이상이다. 세션 중에 바뀌었는지 본다');
if (lastText) {
  console.log('  마지막 응답 (앞 400자)');
  console.log(lastText.slice(0, 400).replace(/^/gm, '    '));
}
