// getComputedStyle 이 색을 어떤 문자열로 돌려주는지 실측한다.
// 실행: npx tsx scripts/probe-computed.ts
// 해석하지 않는다. 브라우저가 돌려준 원문을 그대로 표로 낸다.

import { chromium } from "playwright";

const html = `<!doctype html>
<style>
  :root { --t: #3b82f6; }
  #c1 { color: #3b82f6; }
  #c2 { color: rgb(59 130 246 / 0.5); }
  #c3 { color: oklch(0.6 0.15 258); }
  #c4 { color: color-mix(in srgb, #3b82f6 82%, #111827); }
  #c5 { color: var(--t); }
  #p6 { color: #111827; }
  #c6 { color: currentcolor; }
  #c7 { background-color: #3b82f6; transition: background-color 0.3s linear; width: 100px; height: 40px; }
  #c7:hover { background-color: #2563eb; }
</style>
<div id="c1">1</div>
<div id="c2">2</div>
<div id="c3">3</div>
<div id="c4">4</div>
<div id="c5">5</div>
<div id="p6"><div id="c6">6</div></div>
<div id="c7">7</div>
`;

const cases: Array<[string, string, string]> = [
  ["1", "#c1", "color: #3b82f6"],
  ["2", "#c2", "color: rgb(59 130 246 / 0.5)"],
  ["3", "#c3", "color: oklch(0.6 0.15 258)"],
  ["4", "#c4", "color: color-mix(in srgb, #3b82f6 82%, #111827)"],
  ["5", "#c5", "color: var(--t)  (--t: #3b82f6)"],
  ["6", "#c6", "color: currentcolor  (parent #111827)"],
];

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.VERIFRONT_CHROME || undefined,
    args: process.env.VERIFRONT_CHROME ? ["--no-sandbox"] : [],
  });
  const page = await browser.newPage();
  await page.setContent(html);

  const read = (sel: string, prop: string) =>
    page.evaluate(
      ([s, p]) => getComputedStyle(document.querySelector(s)!).getPropertyValue(p),
      [sel, prop] as const,
    );

  const rows: string[][] = [["#", "declaration", "getComputedStyle"]];
  for (const [n, sel, decl] of cases) rows.push([n, decl, await read(sel, "color")]);

  // 7. transition 걸린 hover — 즉시 / 400ms 후
  // 시점마다 값이 다르다. hover() 직후 한 번만 읽으면 실행마다 결과가 달라진다.
  const before = await read("#c7", "background-color");
  await page.hover("#c7");
  const t0 = Date.now();
  const samples: string[] = [];
  for (const at of [0, 50, 100, 150, 200, 400]) {
    const wait = at - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    samples.push(`+${String(Date.now() - t0).padStart(3)}ms ${await read("#c7", "background-color")}`);
  }
  rows.push(["7", "bg #3b82f6 → hover #2563eb, transition 0.3s — before hover", before]);
  for (const [i, s] of samples.entries()) rows.push([`7${"abcdef"[i]}`, "same — after hover()", s]);

  const ver = browser.version();
  await browser.close();

  console.log(`browser: chromium ${ver}\n`);
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const [i, r] of rows.entries()) {
    console.log("| " + r.map((c, j) => c.padEnd(w[j]!)).join(" | ") + " |");
    if (i === 0) console.log("|" + w.map((x) => "-".repeat(x + 2)).join("|") + "|");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
