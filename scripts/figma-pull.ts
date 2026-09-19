/**
 * 피그마 노드를 한 번 받아 스냅숏으로 남긴다.
 *
 *   read -rs FIGMA_TOKEN && export FIGMA_TOKEN
 *   npx tsx scripts/figma-pull.ts card-list="<프레임 링크>" probe="<프레임 링크>" --dry
 *   npx tsx scripts/figma-pull.ts card-list="<프레임 링크>" probe="<프레임 링크>"
 *
 * GET /v1/files/:key/nodes 는 Tier 1 엔드포인트다(developers.figma.com rate limits, 2025-11-17 개정 기준).
 * Starter 플랜에 있는 파일과 View·Collab 좌석의 Tier 1 호출은 분당이 아니라 월 단위로 묶인다.
 * 그래서 검사할 때마다 부르지 않는다. 한 번 받은 응답을 저장하고 판정은 저장본으로 한다.
 * 같은 저장본이면 같은 판정이 나온다.
 *
 * 여러 노드를 한 호출에 묶는다. 링크마다 부르면 한도가 링크 수만큼 줄어든다.
 * 429 를 받으면 재시도하지 않는다. 월 한도에서 재시도는 남은 호출만 태운다.
 * 기존 스냅숏은 --force 없이 덮어쓰지 않는다. 정답지가 바뀌면 그 전의 판정이 전부 무효가 된다.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const API = process.env.FIGMA_API_BASE ?? 'https://api.figma.com';
const DEFAULT_OUT = 'experiments/figma/snapshot.json';

export interface Target {
  label: string | null;
  key: string;
  id: string;
}

/**
 * 링크에서 파일 키와 노드 id 를 꺼낸다.
 * 링크의 node-id 는 12-34 꼴이고 API 는 12:34 를 받는다.
 * 브랜치 링크(/design/:key/branch/:branchKey/...)는 브랜치 키로 부른다.
 */
export function parseTarget(arg: string): Target {
  let label: string | null = null;
  let rest = arg;
  const eq = arg.indexOf('=');
  if (eq > 0 && !arg.slice(0, eq).includes('/')) {
    label = arg.slice(0, eq);
    rest = arg.slice(eq + 1);
  }
  let url: URL;
  try {
    url = new URL(rest);
  } catch {
    throw new Error(`링크로 읽을 수 없다: ${rest}`);
  }
  const seg = url.pathname.split('/').filter(Boolean);
  const kinds = ['design', 'file', 'proto', 'board'];
  if (!kinds.includes(seg[0] ?? '') || !seg[1]) throw new Error(`피그마 파일 링크가 아니다: ${rest}`);
  const key = seg[2] === 'branch' && seg[3] ? seg[3] : seg[1];
  const raw = url.searchParams.get('node-id');
  if (!raw) throw new Error(`node-id 가 없다. 프레임을 선택하고 "Copy link to selection" 으로 복사한다: ${rest}`);
  const id = raw.replace(/-/g, ':');
  if (!/^I?\d+:\d+(;\d+:\d+)*$/.test(id)) throw new Error(`node-id 형식이 다르다: ${raw}`);
  return { label, key, id };
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  layoutMode?: string;
  boundVariables?: Record<string, unknown>;
  fills?: Array<{ boundVariables?: Record<string, unknown> }>;
  strokes?: Array<{ boundVariables?: Record<string, unknown> }>;
}

function walk(n: FigmaNode, fn: (n: FigmaNode) => void): void {
  fn(n);
  for (const c of n.children ?? []) walk(c, fn);
}

/** 받아온 노드에서 판정에 쓸 것이 얼마나 있는지 센다. */
function describe(doc: FigmaNode): string {
  const types = new Map<string, number>();
  let autoLayout = 0;
  let hidden = 0;
  let bound = 0;
  walk(doc, (n) => {
    types.set(n.type, (types.get(n.type) ?? 0) + 1);
    if (n.layoutMode && n.layoutMode !== 'NONE') autoLayout++;
    if (n.visible === false) hidden++;
    const b =
      Object.keys(n.boundVariables ?? {}).length +
      (n.fills ?? []).filter((p) => p.boundVariables && Object.keys(p.boundVariables).length > 0).length +
      (n.strokes ?? []).filter((p) => p.boundVariables && Object.keys(p.boundVariables).length > 0).length;
    bound += b;
  });
  const t = [...types.entries()].map(([k, v]) => `${k} ${v}`).join(', ');
  return `${t} · 오토 레이아웃 ${autoLayout} · 숨김 ${hidden} · 변수 바인딩 ${bound}`;
}

function retryAfterText(sec: number): string {
  if (!Number.isFinite(sec)) return '알 수 없음';
  if (sec < 120) return `${sec}초`;
  if (sec < 7200) return `${Math.round(sec / 60)}분`;
  if (sec < 172800) return `${Math.round(sec / 3600)}시간`;
  return `${Math.round(sec / 86400)}일`;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const force = args.includes('--force');
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1]! : DEFAULT_OUT;
  const positional = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));

  if (positional.length === 0) {
    console.error('사용법: npx tsx scripts/figma-pull.ts [이름=]<프레임 링크> ... [--dry] [--force] [--out 경로]');
    process.exit(1);
  }

  const targets = positional.map(parseTarget);
  const keys = new Set(targets.map((t) => t.key));
  if (keys.size > 1) {
    console.error('링크가 서로 다른 파일을 가리킨다. 한 호출은 한 파일만 받는다.');
    process.exit(1);
  }
  const key = targets[0]!.key;
  const ids = [...new Set(targets.map((t) => t.id))];

  console.log(`호출 1회 · 노드 ${ids.length}개`);
  for (const t of targets) console.log(`  ${t.label ?? '(이름 없음)'}  ${t.id}`);

  if (!force && existsSync(out)) {
    console.error(`\n${out} 이 이미 있다. 정답지를 바꾸려는 게 맞으면 --force 를 붙인다.`);
    process.exit(1);
  }
  if (dry) {
    console.log('\n--dry: 호출하지 않았다.');
    return;
  }

  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    console.error('\nFIGMA_TOKEN 이 없다. 토큰은 file_content:read 스코프 하나로 발급한다.');
    process.exit(1);
  }

  const url = `${API}/v1/files/${encodeURIComponent(key)}/nodes?ids=${encodeURIComponent(ids.join(','))}`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });

  if (res.status === 429) {
    const h = res.headers;
    console.error('\n429 — 한도에 걸렸다. 재시도하지 않는다.');
    console.error(`  Retry-After             ${retryAfterText(Number(h.get('retry-after')))}`);
    console.error(`  X-Figma-Plan-Tier       ${h.get('x-figma-plan-tier') ?? '-'}`);
    console.error(`  X-Figma-Rate-Limit-Type ${h.get('x-figma-rate-limit-type') ?? '-'}`);
    process.exit(2);
  }
  if (res.status === 403) {
    console.error('\n403 — 토큰이 틀렸거나 만료됐거나 file_content:read 스코프가 없다.');
    process.exit(1);
  }
  if (res.status === 404) {
    console.error('\n404 — 파일을 찾지 못했다. 이 토큰의 계정에 파일 접근 권한이 있는지 확인한다.');
    process.exit(1);
  }
  const body = (await res.json()) as {
    err?: string;
    name: string;
    lastModified: string;
    version: string;
    editorType?: string;
    nodes: Record<string, { document: FigmaNode } | null>;
  };
  if (!res.ok || body.err) {
    console.error(`\n${res.status} — ${body.err ?? res.statusText}`);
    process.exit(1);
  }

  const missing = ids.filter((id) => !body.nodes[id]);
  if (missing.length > 0) {
    console.error(`\n응답에 없는 노드: ${missing.join(', ')}. 링크가 이 파일의 노드인지 확인한다.`);
    process.exit(1);
  }

  const index: Record<string, string> = {};
  for (const t of targets) index[t.label ?? body.nodes[t.id]!.document.name] = t.id;

  /**
   * 파일 키와 thumbnailUrl 은 남기지 않는다. 판정에 쓰지 않고, 썸네일 주소는 서명된 임시 링크다.
   * version 과 lastModified 는 남긴다. 어느 시안으로 판정했는지가 결과의 일부다.
   */
  const snapshot = {
    source: 'GET /v1/files/:key/nodes',
    pulledAt: new Date().toISOString(),
    file: {
      name: body.name,
      version: body.version,
      lastModified: body.lastModified,
      editorType: body.editorType ?? null,
    },
    index,
    nodes: body.nodes,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');

  console.log(`\n저장 ${out}`);
  console.log(`파일 "${body.name}" · version ${body.version} · 수정 ${body.lastModified}`);
  for (const [label, id] of Object.entries(index)) {
    const doc = body.nodes[id]!.document;
    console.log(`  ${label} (${doc.type} "${doc.name}")`);
    console.log(`    ${describe(doc)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
