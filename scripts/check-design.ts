// 시안 스냅숏에 대고 HTML 하나를 판정한다.
// 실행: npx tsx scripts/check-design.ts <html> [스냅숏] [이름]
//   기본 스냅숏 experiments/figma/snapshot.json, 기본 이름 card-list
//
// 짝짓기 결과와 판정을 함께 낸다. 짝을 못 찾은 노드는 판정에서 빠진다. 통과가 아니다.

import { readFileSync } from 'node:fs';
import { loadTokens } from '../src/check.ts';
import { loadSpaceTokens } from '../src/spacing.ts';
import { loadDesign, type Snapshot } from '../src/figma.ts';
import { checkDesign, summarizeDesign, type DesignVerdict } from '../src/design.ts';

const COLOR_TOKENS = process.env.VERIFRONT_TOKENS ?? 'experiments/tokens.json';
const SPACE_TOKENS = process.env.VERIFRONT_SPACE_TOKENS ?? 'experiments/tokens-space.json';

async function main() {
  const [target, snapPath = 'experiments/figma/snapshot.json', label = 'card-list'] = process.argv.slice(2);
  if (!target) {
    console.error('사용법: npx tsx scripts/check-design.ts <html> [스냅숏] [이름]');
    process.exit(1);
  }
  const snapshot = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
  const design = loadDesign(snapshot, label);
  const tokens = {
    color: loadTokens(JSON.parse(readFileSync(COLOR_TOKENS, 'utf8'))),
    space: loadSpaceTokens(JSON.parse(readFileSync(SPACE_TOKENS, 'utf8'))),
  };
  const { findings, match, pairs } = await checkDesign(readFileSync(target, 'utf8'), design, tokens, {
    executablePath: process.env.VERIFRONT_CHROME,
  });

  console.log(`대상: ${target}`);
  console.log(`시안: ${snapshot.file.name} · ${label} · version ${snapshot.file.version}`);
  console.log(
    `짝짓기: 노드 ${match.visual} · 글자 ${match.byText} · 끌어올림 ${match.byLift} · 순서 ${match.byOrder} · 테두리 ${match.byBorder} · 못 찾음 ${match.unmatched} · 풀어헤친 묶음 ${match.flattened}`,
  );
  const s = summarizeDesign(findings);
  console.log(Object.entries(s).map(([k, v]) => `${k} ${v}`).join(' · '));
  console.log('');

  const mode = process.env.VERIFRONT_SHOW ?? 'problems';
  if (mode === 'pairs') {
    // 짝짓기만 본다. 판정이 맞는지 보기 전에 자리가 맞는지부터 본다
    for (const p of pairs) console.log(`${(p.how ?? '-').padEnd(10)} ${p.node.padEnd(58)} ${p.target ?? ''}`);
    return;
  }
  const show = mode === 'all';
  for (const f of findings) {
    if (!show && f.verdict === 'ok') continue;
    const v = (f.verdict as DesignVerdict).padEnd(13);
    const act = f.actual ?? '-';
    const extra = [f.token ? `→ ${f.token}` : '', f.note ?? ''].filter(Boolean).join(' ');
    console.log(`${v} ${f.prop.padEnd(12)} 시안 ${f.expected.padEnd(26)} 화면 ${act.padEnd(22)} ${extra}`);
    console.log(`${' '.repeat(14)}${f.node}`);
    if (f.target) console.log(`${' '.repeat(14)}${f.target}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
