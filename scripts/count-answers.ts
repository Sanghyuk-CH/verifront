// getComputedStyle 이 답하는 값의 수와 실제로 그려지는 값의 수를 센다.
// 실행: npx tsx scripts/count-answers.ts
// "그려지는 값만 센다" 필터가 무엇을 걸러내는지 숫자로 보이기 위한 스크립트다.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { RUNTIME_PROPS } from '../src/runtime.ts';

const executablePath = process.env.VERIFRONT_CHROME;
const browser = await chromium.launch({ executablePath, args: executablePath ? ['--no-sandbox'] : [] });
const page = await browser.newPage();
const dir = path.join(process.cwd(), 'experiments');

console.log(`browser: chromium ${browser.version()}\n`);
console.log('회차      요소  답한 값  투명 제외  그려지는 값(중복 제거, default 상태)');
for (const c of ['A', 'B', 'C']) {
  for (const name of fs.readdirSync(path.join(dir, c)).sort()) {
    if (!name.endsWith('.html')) continue;
    await page.goto('file://' + path.join(dir, c, name));
    const r = await page.evaluate(
      (props) => {
        const els = [document.body, ...document.body.querySelectorAll('*')];
        let answered = 0;
        let opaque = 0;
        for (const el of els) {
          const cs = getComputedStyle(el);
          for (const p of props) {
            const v = cs.getPropertyValue(p);
            if (v) answered++;
            if (!/^rgba\(\d+, \d+, \d+, 0\)$/.test(v)) opaque++;
          }
        }
        return { elements: els.length, answered, opaque };
      },
      RUNTIME_PROPS as unknown as string[],
    );
    const drawn = fs
      .readFileSync(path.join(dir, c, name.replace('.html', '.runtime.txt')), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('default')).length;
    console.log(
      `${(c + '/' + name.replace('.html', '')).padEnd(8)} ${String(r.elements).padStart(4)} ${String(r.answered).padStart(8)} ${String(r.opaque).padStart(9)}  ${String(drawn).padStart(6)}`,
    );
  }
}
await browser.close();
