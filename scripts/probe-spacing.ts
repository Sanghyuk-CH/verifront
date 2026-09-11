// 브라우저가 간격을 어떤 값으로 돌려주는지, 그리고 그 값이 화면의 실제 여백과
// 언제 갈라지는지 실측한다.
// 실행: npx tsx scripts/probe-spacing.ts
// 해석하지 않는다. 브라우저가 돌려준 원문과 잰 좌표를 그대로 표로 낸다.

import { chromium } from 'playwright';

/* ─────────────────────────────────────────────────────────────
 * A. 같은 16px 을 여러 방식으로 선언했을 때 돌아오는 값
 * ───────────────────────────────────────────────────────────── */

const htmlA = `<!doctype html>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-size: 16px; }
  .box { width: 200px; background: #eee; }
  #a1 { padding: 16px; }
  #a2 { padding: 1rem; }
  #a3 { font-size: 16px; padding: 1em; }
  #a4 { font-size: 13.33px; padding: 1em; }
  #a5 { padding: 0.9rem; }
  #a6 { padding: calc(1rem - 0.001px); }
  #w7 { width: 320px; } #a7 { padding: 5%; }
  #w8 { width: 333px; } #a8 { padding: 5%; }
  #w9 { width: 320px; display: flex; gap: 1rem; }
  #w10 { width: 333px; display: flex; gap: 5%; }
  #a11 { zoom: 1.1; padding: 1rem; }
  #a12 { padding: 1vw; }
</style>
<div class="box" id="a1">1</div>
<div class="box" id="a2">2</div>
<div class="box" id="a3">3</div>
<div class="box" id="a4">4</div>
<div class="box" id="a5">5</div>
<div class="box" id="a6">6</div>
<div id="w7"><div class="box" id="a7">7</div></div>
<div id="w8"><div class="box" id="a8">8</div></div>
<div id="w9"><i>a</i><i>b</i></div>
<div id="w10"><i>a</i><i>b</i></div>
<div class="box" id="a11">11</div>
<div class="box" id="a12">12</div>
`;

const casesA: Array<[string, string, string, string]> = [
  ['1', '#a1', 'padding-top', 'padding: 16px'],
  ['2', '#a2', 'padding-top', 'padding: 1rem  (root 16px)'],
  ['3', '#a3', 'padding-top', 'padding: 1em  (self font-size 16px)'],
  ['4', '#a4', 'padding-top', 'padding: 1em  (self font-size 13.33px)'],
  ['5', '#a5', 'padding-top', 'padding: 0.9rem'],
  ['6', '#a6', 'padding-top', 'padding: calc(1rem - 0.001px)'],
  ['7', '#a7', 'padding-top', 'padding: 5%  (parent width 320px)'],
  ['8', '#a8', 'padding-top', 'padding: 5%  (parent width 333px)'],
  ['9', '#w9', 'column-gap', 'gap: 1rem'],
  ['10', '#w10', 'column-gap', 'gap: 5%  (width 333px)'],
  ['11', '#a11', 'padding-top', 'padding: 1rem  (zoom: 1.1)'],
  ['12', '#a12', 'padding-top', 'padding: 1vw  (viewport 1280px)'],
];

/* ─────────────────────────────────────────────────────────────
 * B. 선언값과 화면의 실제 여백
 *    두 형제 사이의 빈 거리 = 뒤 요소 top - 앞 요소 bottom
 * ───────────────────────────────────────────────────────────── */

const htmlB = `<!doctype html>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-size: 16px; }
  .wrap { width: 300px; }
  .item { height: 40px; background: #ddd; }

  /* 1. 두 마진이 마주 본다 */
  #b1 .a { margin-bottom: 16px; }
  #b1 .b { margin-top: 16px; }

  /* 2. 크기가 다른 두 마진이 마주 본다 */
  #b2 .a { margin-bottom: 16px; }
  #b2 .b { margin-top: 24px; }

  /* 3. flex — 마진은 없고 부모의 gap 이 여백을 만든다 */
  #b3 { display: flex; flex-direction: column; gap: 16px; }

  /* 4. flex 에서는 마진이 상쇄되지 않는다 */
  #b4 { display: flex; flex-direction: column; gap: 16px; }
  #b4 .b { margin-top: 8px; }

  /* 5. 음수 마진 */
  #b5 .a { margin-bottom: 16px; }
  #b5 .b { margin-top: -8px; }

  /* 6. transform 은 레이아웃을 바꾸지 않는다 */
  #b6 .a { margin-bottom: 16px; }
  #b6 .b { transform: translateY(8px); }

  /* 7. 빈 요소가 사이에 끼면 그 마진도 함께 상쇄된다 */
  #b7 .a { margin-bottom: 16px; }
  #b7 .gapless { margin: 12px 0; }
  #b7 .b { margin-top: 16px; }

  /* 8. 자식의 마진이 부모 밖으로 새어 나간다 */
  #b8 .a { margin-bottom: 16px; }
  #b8 .holder { }
  #b8 .b { margin-top: 16px; }
</style>
<div class="wrap" id="b1"><div class="item a"></div><div class="item b"></div></div>
<hr>
<div class="wrap" id="b2"><div class="item a"></div><div class="item b"></div></div>
<hr>
<div class="wrap" id="b3"><div class="item a"></div><div class="item b"></div></div>
<hr>
<div class="wrap" id="b4"><div class="item a"></div><div class="item b"></div></div>
<hr>
<div class="wrap" id="b5"><div class="item a"></div><div class="item b"></div></div>
<hr>
<div class="wrap" id="b6"><div class="item a"></div><div class="item b"></div></div>
<hr>
<div class="wrap" id="b7"><div class="item a"></div><div class="gapless"></div><div class="item b"></div></div>
<hr>
<div class="wrap" id="b8"><div class="item a"></div><div class="holder"><div class="item b"></div></div></div>
`;

const casesB: Array<[string, string, string]> = [
  ['1', '#b1', 'margin-bottom 16px  +  margin-top 16px'],
  ['2', '#b2', 'margin-bottom 16px  +  margin-top 24px'],
  ['3', '#b3', 'flex gap 16px, 마진 없음'],
  ['4', '#b4', 'flex gap 16px  +  margin-top 8px'],
  ['5', '#b5', 'margin-bottom 16px  +  margin-top -8px'],
  ['6', '#b6', 'margin-bottom 16px  +  translateY(8px)'],
  ['7', '#b7', 'margin-bottom 16px  +  [빈 div margin 12px]  +  margin-top 16px'],
  ['8', '#b8', 'margin-bottom 16px  +  래퍼 안 자식의 margin-top 16px'],
];

function table(rows: string[][]) {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  for (const [i, r] of rows.entries()) {
    console.log('| ' + r.map((c, j) => (c ?? '').padEnd(w[j]!)).join(' | ') + ' |');
    if (i === 0) console.log('|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|');
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.VERIFRONT_CHROME || undefined,
    args: process.env.VERIFRONT_CHROME ? ['--no-sandbox'] : [],
  });
  console.log(`browser: chromium ${browser.version()}\n`);

  /* A */
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(htmlA);

  const rowsA: string[][] = [['#', 'declaration', 'getComputedStyle', 'getBoundingClientRect']];
  for (const [n, sel, prop, decl] of casesA) {
    const [computed, rect] = await page.evaluate(
      ([s, p]) => {
        const el = document.querySelector(s)!;
        const cs = getComputedStyle(el);
        const v = cs.getPropertyValue(p);
        let measured = '';
        if (p === 'padding-top') {
          // 패딩 상자의 위쪽 두께를 좌표로 직접 잰다
          const outer = el.getBoundingClientRect();
          const probe = document.createElement('span');
          probe.style.cssText = 'display:block;height:0;';
          el.insertBefore(probe, el.firstChild);
          const inner = probe.getBoundingClientRect();
          probe.remove();
          measured = String(inner.top - outer.top - parseFloat(cs.borderTopWidth));
        } else {
          const kids = [...el.children];
          if (kids.length >= 2) {
            const a = kids[0]!.getBoundingClientRect();
            const b = kids[1]!.getBoundingClientRect();
            measured = String(cs.flexDirection === 'column' ? b.top - a.bottom : b.left - a.right);
          }
        }
        return [v, measured] as const;
      },
      [sel, prop] as const,
    );
    rowsA.push([n, decl, computed, rect]);
  }
  console.log('## A. 16px 을 여러 방식으로 선언했을 때 브라우저가 답하는 값\n');
  table(rowsA);

  /* B */
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  await page2.setContent(htmlB);

  const rowsB: string[][] = [
    ['#', 'CSS 선언', 'computed a.margin-bottom', 'computed b.margin-top', 'computed gap', '실제 여백'],
  ];
  for (const [n, sel, decl] of casesB) {
    const r = await page2.evaluate((s) => {
      const wrap = document.querySelector(s)!;
      const a = wrap.querySelector('.a')!;
      const b = wrap.querySelector('.b')!;
      const csw = getComputedStyle(wrap);
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return {
        mb: getComputedStyle(a).marginBottom,
        mt: getComputedStyle(b).marginTop,
        gap: csw.rowGap === 'normal' ? '-' : csw.rowGap,
        actual: String(Math.round((rb.top - ra.bottom) * 1000) / 1000) + 'px',
      };
    }, sel);
    rowsB.push([n, decl, r.mb, r.mt, r.gap, r.actual]);
  }
  console.log('\n\n## B. 선언된 값과 화면의 실제 여백\n');
  table(rowsB);

  /* C. 배율과 루트 글자 크기를 바꿨을 때 같은 선언이 어떻게 답하는가 */
  const rowsC: string[][] = [['조건', 'padding: 16px', 'padding: 1rem', 'padding: 0.9rem', 'rect(0.9rem)']];
  const htmlC = `<!doctype html><style>body{margin:0}
    #c1{padding:16px} #c2{padding:1rem} #c3{padding:0.9rem} div{width:200px;background:#eee}</style>
    <div id="c1">1</div><div id="c2">2</div><div id="c3">3</div>`;
  for (const [label, dsf, rootFs] of [
    ['DPR 1, root 16px', 1, '16px'],
    ['DPR 1.25, root 16px', 1.25, '16px'],
    ['DPR 2, root 16px', 2, '16px'],
    ['DPR 1, root 15px', 1, '15px'],
    ['DPR 1, root 20px', 1, '20px'],
  ] as const) {
    const ctx = await browser.newContext({ deviceScaleFactor: dsf, viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.setContent(htmlC);
    await p.addStyleTag({ content: `html{font-size:${rootFs}}` });
    const r = await p.evaluate(() => {
      const v = Object.assign((s: string) => getComputedStyle(document.querySelector(s)!).paddingTop, {});
      const el = document.querySelector('#c3')!;
      const outer = el.getBoundingClientRect();
      const probe = document.createElement('span');
      probe.style.cssText = 'display:block;height:0;';
      el.insertBefore(probe, el.firstChild);
      const inner = probe.getBoundingClientRect();
      probe.remove();
      return [v('#c1'), v('#c2'), v('#c3'), String(inner.top - outer.top)] as const;
    });
    rowsC.push([label, ...r]);
    await ctx.close();
  }
  console.log('\n\n## C. 배율과 루트 글자 크기\n');
  table(rowsC);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
