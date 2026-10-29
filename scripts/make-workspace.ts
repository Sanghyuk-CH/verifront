// 7편 실험의 작업 폴더를 만든다. 모델은 이 폴더 안에서만 일한다.
// 실행: npx tsx scripts/make-workspace.ts E0|E0c|E0s|E1|E1b|E1n <폴더>
//
// 두 조건이 받는 것
//   PROMPT.md          조건 D 프롬프트 + 시안과 결과 파일 안내. 두 조건이 한 글자도 다르지 않다
//   design.md          시안 명세. describe-design 의 출력과 읽는 법
//   tokens.json, tokens-space.json
// E1b 는 E1 과 같고 프롬프트 끝에 스킬을 쓰라는 한 줄이 붙는다.
//   E1 세 회차가 모두 스킬을 부르지 않았을 때만 돌리는 예비 조건이다
// E1n 은 E1 과 같고 스킬에서 테두리 노하우만 뺀다. 남는 것은 검사기와 판정 읽는 법이다.
//   E1 세 회차가 첫 검사에서 모두 통과했다. 스킬의 테두리 문단을 생성 전에 읽고 E0 의 실패를 피했다.
//   검사 루프가 실제로 고치는지는 이 조건에서 잰다. 빼는 문장은 STRIP_E1N 에 있다
// E0c 는 E0 과 같다. 맥이 아닌 리눅스 컨테이너에서 돌린 E0 이라는 표시다.
//   E0s 를 컨테이너에서 돌릴 때 환경 차이가 결과를 바꾸는지 보는 대조군이다
// E0s 는 E0 에 시안 스냅숏(design/snapshot.json)만 더한다. 스킬도 검사기도 설정도 없다.
//   E1n 세 회차도 첫 검사에서 모두 통과했다. 셋 다 생성 전에 스냅숏의 좌표를 읽었다.
//   스냅숏의 높이(보조 버튼 38, 주요·비활성 36)가 테두리 실수를 막았는지 이 조건에서 잰다
// E1·E1b·E1n 만 받는 것
//   .claude/skills/verifront-check/   스킬
//   verifront.config.json, design/snapshot.json
//   node_modules/verifront            레포에서 npm pack 으로 만든 것. npm 레지스트리에서 받지 않는다
//
// 폴더는 레포 밖이어야 한다. 모델이 레포의 실험 결과나 검사기 코드를 읽으면 조건이 무너진다.
// 폴더 안에 실행 안내를 두지 않는다. 모델이 읽는다. 안내는 이 스크립트가 터미널에 찍는다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.cwd();

/** E1n 에서 스킬에서 빼는 문장. [찾을 문장, 바꿀 문장]. 테두리로 1px 밀리는 함정과 그 처방만 뺀다 */
const STRIP_E1N: Record<string, [string, string][]> = {
  'SKILL.md': [
    ['`padding: 16px`이 테두리 때문에 화면에서 17px이 되는 식으로, 선언한 값과', '선언한 값과'],
    [
      '\n1px 차이가 테두리 때문이면 패딩을 15px로 줄이지 않는다. `design`은 통과해도 `spacing`이 15px을 스케일 밖 값으로 잡는다. 대신 시안에서 그 요소에 선이 있는지 본다. 선이 없는 요소에 투명 테두리를 깔아 두면 내용이 1px씩 밀린다. 테두리는 시안에 선이 있는 요소에만 준다.\n',
      '',
    ],
  ],
  'references/verdicts.md': [
    [
      '  - 테두리가 원인이면 시안에서 그 요소에 선이 있는지 본다. 선이 없는데 투명 테두리가 있으면 테두리를 없앤다. 선이 있고 "선 배치 포함"이면 시안의 간격이 이미 테두리를 포함하므로 기대 값도 1px 크다.\n  - 패딩을 15px처럼 줄여 맞추지 않는다. `design`은 통과해도 `spacing`이 스케일 밖 값으로 잡는다.\n',
      '',
    ],
  ],
};
const [cond, dirArg] = process.argv.slice(2);
if (!['E0', 'E0c', 'E0s', 'E1', 'E1b', 'E1n'].includes(cond ?? '') || !dirArg) {
  console.error('사용법: npx tsx scripts/make-workspace.ts E0|E0c|E0s|E1|E1b|E1n <폴더>');
  process.exit(2);
}
if (!fs.existsSync(path.join(repo, 'skills/verifront-check/SKILL.md'))) {
  console.error('레포 루트에서 실행한다');
  process.exit(2);
}

const dir = path.resolve(dirArg);
const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
const rel = path.relative(real(repo), real(path.dirname(dir)) + path.sep + path.basename(dir));
if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
  console.error(`폴더가 레포 안에 있다: ${dir}\n레포 밖에 만든다. 예: ~/verifront-runs/E0-1`);
  process.exit(2);
}
if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
  console.error(`폴더가 비어 있지 않다: ${dir}\n회차마다 새 폴더를 쓴다`);
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

const exp = path.join(repo, 'experiments');
const snapshot = path.join(exp, 'figma', 'snapshot.json');
const run = (cmd: string, args: string[], cwd = repo) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ── 두 조건 공통 ──────────────────────────────────────────

const prompt = `${fs.readFileSync(path.join(exp, 'prompt-D.md'), 'utf8').trimEnd()}

**시안**

피그마 시안의 값은 \`design.md\`에 있다. 여백과 색은 시안의 값을 따른다.

**결과**

결과는 이 폴더의 \`card-list.html\` 한 파일로 저장한다.
${cond === 'E1b' ? '\n다 만들면 verifront-check 스킬로 검사한다.\n' : ''}`;
fs.writeFileSync(path.join(dir, 'PROMPT.md'), prompt);

const spec = run('npx', ['tsx', 'scripts/describe-design.ts', snapshot, 'card-list']);
fs.writeFileSync(
  path.join(dir, 'design.md'),
  `# 시안 명세 — Card list

피그마 프레임의 노드를 한 줄씩 적었다. 들여쓰기가 계층이다.

- 프레임: 오토 레이아웃 방향(세로·가로), 자식 사이 간격, 패딩, 정렬, 폭·높이, 모서리, 칠, 선
- 패딩이 네 값이면 위/오른쪽/아래/왼쪽 순서다
- 선: 색, 두께, 위치(INSIDE 등). "선 배치 포함"은 선 두께가 레이아웃에 포함된다는 뜻이다. 패딩은 선 안쪽부터 잰다
- 글자: 내용, 크기/굵기, 줄 높이, 정렬, 폭, 색
- 색은 hex 로 적었다. 알파가 1 미만이면 퍼센트를 붙였다

\`\`\`
${spec.trimEnd()}
\`\`\`
`,
);

for (const f of ['tokens.json', 'tokens-space.json']) fs.copyFileSync(path.join(exp, f), path.join(dir, f));

// ── 스냅숏: E0s 와 E1 계열 ────────────────────────────────

if (cond !== 'E0' && cond !== 'E0c') {
  fs.mkdirSync(path.join(dir, 'design'));
  fs.copyFileSync(snapshot, path.join(dir, 'design', 'snapshot.json'));
}

// ── E1 계열만 ────────────────────────────────────────────

if (cond === 'E1' || cond === 'E1b' || cond === 'E1n') {
  fs.writeFileSync(
    path.join(dir, 'verifront.config.json'),
    JSON.stringify({ tokens: ['tokens.json', 'tokens-space.json'], design: { snapshot: 'design/snapshot.json', frame: 'card-list' } }, null, 2) + '\n',
  );
  const skillDir = path.join(dir, '.claude', 'skills', 'verifront-check');
  fs.cpSync(path.join(repo, 'skills', 'verifront-check'), skillDir, { recursive: true });
  if (cond === 'E1n') {
    for (const [file, cuts] of Object.entries(STRIP_E1N)) {
      const p = path.join(skillDir, file);
      let text = fs.readFileSync(p, 'utf8');
      for (const [from, to] of cuts) {
        // 스킬 문구가 바뀌어 지울 문장을 못 찾으면 멈춘다. 조용히 넘어가면 E1n 이 E1 과 같아진다
        if (text.split(from).length !== 2) throw new Error(`E1n: ${file} 에서 지울 문장을 정확히 한 번 찾지 못했다\n${from}`);
        text = text.replace(from, to);
      }
      if (/투명 테두리|15px/.test(text)) throw new Error(`E1n: ${file} 에 테두리 노하우가 남았다`);
      fs.writeFileSync(p, text);
    }
  }

  // 레포의 현재 코드로 패키지를 만든다. 실험 시점의 검사기가 무엇이었는지 커밋으로 추적된다
  run('npm', ['run', 'build']);
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifront-pack-'));
  const tgz = run('npm', ['pack', '--silent', '--pack-destination', packDir]).trim().split('\n').pop()!;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'card-list', private: true }, null, 2) + '\n');
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', path.join(packDir, tgz)], dir);
  fs.rmSync(packDir, { recursive: true, force: true });
}

// ── 안내 ─────────────────────────────────────────────────

const commit = run('git', ['rev-parse', '--short', 'HEAD']).trim();
const dirty = run('git', ['status', '--porcelain']).trim() ? ' (커밋 안 된 변경 있음)' : '';
console.log(`${cond} 작업 폴더를 만들었다: ${dir}`);
console.log(`레포 ${commit}${dirty}`);
console.log(`
다음 순서로 진행한다.
  1. cd ${dir}
  2. claude            새 세션. /model 로 모델을 고른다. E0 와 E1 은 같은 모델이어야 한다
                       조건 D 는 Claude Opus 5 였다. 고를 수 있으면 맞춘다
  3. PROMPT.md 의 내용을 그대로 붙여넣는다. 파일을 읽으라고 시키지 않는다
  4. 모델이 끝났다고 할 때까지 개입하지 않는다. 권한 요청은 모두 허용한다
  5. 세션을 닫고 레포로 돌아와 결과를 모은다
       npx tsx scripts/collect-run.ts ${dir} ${cond} <회차>`);
