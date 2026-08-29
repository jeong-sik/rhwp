#!/usr/bin/env node
// 셀 안 문단의 줄 나눔이 한/글이 저장해 둔 것과 같은지 잰다.
//
// HWP 는 문단마다 한/글이 확정한 줄 나눔을 `PARA_LINE_SEG` 로 저장한다. rhwp 는 그것을
// 캐시로 두고, 프레임이 계산한 값과 정확히 같을 때만 받아들인다(`resolve_stored_line_segs_in_frame`).
// 캐시가 거부되면 rhwp 가 자기 폭으로 다시 나눈다. 그 재계산이 한/글과 갈리면 행 높이가 틀어진다.
//
// **왜 셀만 재는가** — 본문 문단은 `composer::lineseg_compare` 가 이미 잰다. 셀 안
// 문단은 코드 경로가 달라 별도 도구가 필요했다.
//
// **짝짓기** — 종전에는 dump 셀 순서와 render tree Cell 순서를 순번으로 맞추고, 개수가
// 다르면 문서를 통째로 건너뛰었다(600 문서 중 231 건너뜀 — #6354). 지금은 셀을
// (행, 열, 텍스트 접두사) 내용 키로 짝짓는다. 못 짝지은 셀만 `unpaired*` 로 세고
// 문서는 버리지 않는다.
//
// **비교 가능성 (#6363)** — 두 가지를 비교에서 정직하게 가른다.
// 1. 저장 줄 수 0 인 셀은 파일이 `PARA_LINE_SEG` 를 저장하지 않은 것이다(스펙상 뷰어
//    캐시라 없어도 유효 — issue2063 은 문단의 87% 가 기록 없음). 비교 대상이 없으므로
//    `noStoredRecord` 로 따로 세고 판정하지 않는다. 이 값은 렌더러 변경과 무관한 파일
//    사실이라, 늘어나면 dump 귀속(파서) 회귀다.
// 2. 표가 쪽을 넘으면 렌더 트리는 쪽마다 조각 Cell 을 낸다. 조각은 부모 Table 의
//    문서 모델 좌표(pi:ci)로 묶는다. 같은 묶음이 조각인지 복제인지는 저장 셀이 어느
//    키로 맞는지가 가른다 — 쪽 나눔 조각은 이어붙여야 원문이 되고, 복제(머리말/꼬리말/
//    제목 행의 쪽별 재렌더 — 쪽번호 필드로 인스턴스마다 텍스트가 변주되기도 한다)는
//    인스턴스 하나가 이미 원문이다. 조각은 줄 수를 합산해 저장 값과 비교하고, 복제는
//    줄 수가 서로 같으면 대표 한 건으로 판정하며(쪽수만큼 세면 긴 문서의 머리말이
//    지표를 지배한다) 어긋나면 각 인스턴스를 판정해 쪽별 재조판 결함을 잡는다.
//
// 사용:
//   node scripts/cell-lineseg-agreement.mjs                  기준선과 비교, 회귀면 exit 1
//   node scripts/cell-lineseg-agreement.mjs --update          현재 값을 기준선으로 기록
//   node scripts/cell-lineseg-agreement.mjs --disagreements   불일치 셀 목록 출력

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
export const BASELINE_PATH = path.join(SCRIPT_DIR, 'cell-lineseg-agreement-baseline.json');

const CELL_LINE = /셀\[\d+\] r=(\d+),c=(\d+) .*? w=(\d+) .*?text="([^"]*)"/;
const SEG_WIDTH = /sw=(\d+)/g;
const TABLE_LINE = /(?:내부표|표): /;
const PARA_LINE = /p\[\d+\]/;
const LINE_SEG = /ls\[\d+\] ts=/g;
const PREFIX = /^\s*\[\d+\]( *)/;

/** 짝짓기 키의 텍스트 부분 — 공백·구분 기호를 걷고 앞 12자만 쓴다. */
export function textKey(text) {
  return text.replace(/[\s|]/g, '').slice(0, 12);
}

/**
 * `rhwp dump` 출력에서 셀별 (행, 열, 텍스트, 저장 줄 수)를 뽑는다.
 *
 * 중첩 표가 셀 문단 사이에 끼므로 들여쓰기 스택으로 소유를 판정한다 — `ls` 줄은
 * 자기보다 얕은 가장 가까운 셀의 것이고, 같은 깊이의 새 항목은 그 셀을 닫는다.
 */
export function storedCells(dumpText) {
  const stack = []; // { indent, cell }
  const cells = [];
  // 셀 텍스트의 개행은 dump 에 물리 줄바꿈으로 그대로 찍힌다 — `text="` 가 열린 채
  // 끝나는 줄은 닫는 따옴표가 나올 때까지 이어붙여 한 줄로 되돌린다. 안 하면 그 셀이
  // 통째로 누락되고, 셀의 ls 줄이 직전 셀에 가산돼 거짓 불일치가 생긴다(k-water 의
  // '운영중\n(사업대상)' 열이 이웃 열 전체를 +2 로 부풀렸다).
  const lines = [];
  let open = null;
  for (const raw of dumpText.split('\n')) {
    if (open !== null) {
      open += `\n${raw}`;
      if (raw.includes('"')) {
        lines.push(open);
        open = null;
      }
      continue;
    }
    if (/text="[^"]*$/.test(raw)) {
      open = raw;
      continue;
    }
    lines.push(raw);
  }
  if (open !== null) lines.push(open);
  for (const line of lines) {
    const m = PREFIX.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const cellMatch = CELL_LINE.exec(line);
    if (cellMatch) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const cell = {
        row: Number(cellMatch[1]),
        col: Number(cellMatch[2]),
        width: Number(cellMatch[3]),
        text: cellMatch[4],
        lines: 0,
        maxSw: 0,
      };
      cells.push(cell);
      stack.push({ indent, cell });
      continue;
    }
    if (LINE_SEG.test(line)) {
      LINE_SEG.lastIndex = 0;
      const owner = [...stack].reverse().find((s) => s.indent < indent);
      if (owner) {
        owner.cell.lines += (line.match(LINE_SEG) ?? []).length;
        for (const m of line.matchAll(SEG_WIDTH)) {
          owner.cell.maxSw = Math.max(owner.cell.maxSw, Number(m[1]));
        }
      }
      continue;
    }
    if (TABLE_LINE.test(line) || PARA_LINE.test(line)) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    }
  }
  return cells;
}

/**
 * render tree JSON 에서 Cell 별 (표 좌표, 행, 열, 텍스트, TextLine 수)를 뽑는다.
 *
 * `table` 은 조상 Table 들의 문서 모델 좌표(`pi:ci`) 체인이다. 표가 쪽을 넘어 조각나도
 * 조각들은 같은 체인을 갖는다 — 쪽 사이 조각 병합(#6363)의 열쇠다.
 */
export function renderedCells(tree) {
  const cells = [];
  const walk = (node, tableChain) => {
    let chain = tableChain;
    if (node.type === 'Table') {
      chain = `${tableChain}/${node.pi ?? '?'}:${node.ci ?? '?'}`;
    }
    if (node.type === 'Cell') {
      const lines = (node.children ?? []).filter((c) => c.type === 'TextLine');
      const text = lines
        .map((l) => (l.children ?? []).map((r) => r.text ?? '').join(''))
        .join('|');
      cells.push({
        table: chain,
        row: node.row ?? 0,
        col: node.col ?? 0,
        text,
        lines: lines.length,
      });
    }
    for (const child of node.children ?? []) walk(child, chain);
  };
  walk(tree, '');
  return cells;
}

/**
 * 내용 키로 셀을 짝지어 집계한다.
 *
 * 렌더 셀은 먼저 (표 좌표, 행, 열)로 묶는다 — 같은 묶음은 쪽 나눔 조각이거나 제목 행
 * 반복이다. 그 묶음을 (행, 열, 내용 키)로 저장 셀과 짝짓는다. 렌더 0줄은 판정하지
 * 않는다(줄 나눔이 없는 자리). 못 짝지은 셀은 양쪽 각각 센다.
 *
 * `onDisagree(stored, renderedLines, group)` 를 주면 불일치마다 부른다.
 */
export function tallyDocument(stored, rendered, totals, onDisagree) {
  // 내용 키가 빈 셀은 짝짓기에서 뺀다 — 빈 셀은 문서에 수백 개씩 있어 (행, 열, 빈 키)가
  // 식별력을 잃고, 무관한 셀끼리 붙어 거짓 불일치를 만든다(편람: 저장 3줄 빈 셀의 진짜
  // 렌더는 3줄로 일치하는데, 계측은 다른 쪽의 1줄짜리 무관 빈 셀과 붙여 "더 적게"를
  // 보고했다). 짝지을 수 없는 것은 못 짝지은 것과 달라 emptyCells 로 따로 센다.
  const measurable = (text) => textKey(text) !== '';
  totals.emptyCells += stored.filter((c) => !measurable(c.text)).length;
  totals.emptyCells += rendered.filter((r) => !measurable(r.text)).length;
  stored = stored.filter((c) => measurable(c.text));
  rendered = rendered.filter((r) => measurable(r.text));

  const raw = new Map(); // (table,row,col) -> { row, col, texts, parts, pages }
  for (const r of rendered) {
    const gkey = `${r.table ?? ''}#${r.row}:${r.col}`;
    if (!raw.has(gkey)) raw.set(gkey, { row: r.row, col: r.col, texts: [], parts: [], pages: [] });
    const g = raw.get(gkey);
    g.texts.push(r.text);
    g.parts.push(r.lines);
    g.pages.push(r.page ?? 0);
  }

  // Table 의 pi:ci 는 문서 전역 유일이 아니다 — 다른 구역의 무관한 표가 같은 좌표를
  // 가져 한 묶음에 섞인다(편람 별표 서식들). 조각/복제는 쪽-연속 현상이므로, 텍스트가
  // 서로 다른 묶음(조각 후보)은 쪽이 이어지는 구간(런)으로 쪼갠다 — 떨어진 쪽의 무관한
  // 표는 낱개로 갈라져 제 키로 짝지어진다. 텍스트가 모두 같은 묶음(복제)은 쪽이
  // 떨어져도(홀짝 머리말) 같은 재렌더이므로 쪼개지 않는다.
  const groups = [];
  for (const g of raw.values()) {
    const uniform = g.texts.every((t) => t === g.texts[0]);
    if (uniform || g.texts.length === 1) {
      groups.push(g);
      continue;
    }
    const order = g.pages.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let run;
    let prevPage;
    for (const [page, i] of order) {
      if (!run || page - prevPage > 1) {
        run = { row: g.row, col: g.col, texts: [], parts: [], pages: [] };
        groups.push(run);
      }
      run.texts.push(g.texts[i]);
      run.parts.push(g.parts[i]);
      run.pages.push(page);
      prevPage = page;
    }
  }

  const buckets = new Map(); // (row,col,textKey) -> [storedCell]
  for (const c of stored) {
    const key = `${c.row}:${c.col}:${textKey(c.text)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }

  const judge = (s, renderedLines, group) => {
    if (s.lines === 0) {
      // 파일이 이 문단의 PARA_LINE_SEG 를 저장하지 않았다 — 비교 대상이 없다.
      totals.noStoredRecord += 1;
      return;
    }
    if (renderedLines === 0) return;
    totals.cells += 1;
    const delta = renderedLines - s.lines;
    if (delta === 0) totals.agree += 1;
    else {
      totals.disagree += 1;
      if (delta > 0) totals.renderedMore += 1;
      else totals.renderedFewer += 1;
      if (onDisagree) onDisagree(s, renderedLines, group);
    }
  };

  const lookup = (g, text) => {
    const queue = buckets.get(`${g.row}:${g.col}:${textKey(text)}`);
    return queue && queue.length > 0 ? queue : undefined;
  };
  const judgeReplica = (s, g) => {
    if (g.parts.every((p) => p === g.parts[0])) {
      // 복제가 전부 같은 줄 수 — 대표 한 건만 판정한다. 쪽수만큼 세면
      // 긴 문서의 머리말 표가 지표를 지배한다.
      judge(s, g.parts[0], g);
    } else {
      // 복제끼리 줄 수가 다르다 — 쪽별 재조판이 갈렸다는 뜻이므로 각각 판정한다.
      for (const lines of g.parts) judge(s, lines, g);
    }
  };

  for (const g of groups) {
    // 같은 표 좌표 묶음이 복제인지 조각인지는 저장 셀이 어느 키로 맞는지가 가른다.
    // 쪽 나눔 조각은 이어붙여야 원문이 되고(이어붙인 키가 맞음), 복제 렌더는 인스턴스
    // 하나가 이미 원문이다(첫 인스턴스 키가 맞음 — 머리말 쪽번호 필드처럼 인스턴스마다
    // 텍스트가 변주되는 복제도 여기 잡힌다).
    const uniform = g.texts.every((t) => t === g.texts[0]);
    if (uniform) {
      const queue = lookup(g, g.texts[0]);
      if (!queue) {
        totals.unpairedRendered += g.parts.length;
        continue;
      }
      judgeReplica(queue.shift(), g);
      continue;
    }
    const joined = lookup(g, g.texts.join('|'));
    if (joined) {
      // 쪽 나눔 조각 — 줄 수의 합이 저장 값이다.
      judge(joined.shift(), g.parts.reduce((a, b) => a + b, 0), g);
      continue;
    }
    const first = lookup(g, g.texts[0]);
    if (first) {
      judgeReplica(first.shift(), g);
      continue;
    }
    totals.unpairedRendered += g.parts.length;
  }
  for (const queue of buckets.values()) totals.unpairedStored += queue.length;
}

export function agreementPercent(totals) {
  return totals.cells === 0 ? 0 : (totals.agree / totals.cells) * 100;
}

/** 일치가 줄거나, 못 짝지은 셀·기록 없는 셀이 늘거나, 측정 모수가 줄면 회귀다. */
export function compareAgreement(actual, baseline) {
  const regressions = [];
  const improvements = [];
  const now = agreementPercent(actual);
  const was = agreementPercent(baseline);
  if (now < was - 0.005) regressions.push({ what: '일치율', now: now.toFixed(2), was: was.toFixed(2) });
  else if (now > was + 0.005) improvements.push({ what: '일치율', now: now.toFixed(2), was: was.toFixed(2) });

  const unpairedNow = actual.unpairedStored + actual.unpairedRendered;
  const unpairedWas = baseline.unpairedStored + baseline.unpairedRendered;
  if (unpairedNow > unpairedWas) {
    regressions.push({ what: '못 짝지은 셀', now: unpairedNow, was: unpairedWas });
  }
  // 기록 없음·낡은 기록은 파일 사실이다 — 샘플이 그대로인데 늘면 dump 귀속(파서) 회귀다.
  if ((actual.noStoredRecord ?? 0) > (baseline.noStoredRecord ?? 0)) {
    regressions.push({ what: '기록 없는 셀', now: actual.noStoredRecord, was: baseline.noStoredRecord ?? 0 });
  }
  // 모수가 줄면 일치율이 착시로 오를 수 있다 — "안 재서 통과"를 막는다.
  if (actual.cells < baseline.cells) {
    regressions.push({ what: '측정 셀', now: actual.cells, was: baseline.cells });
  }
  return { regressions, improvements };
}

function emptyTotals() {
  return {
    documents: 0,
    unpairedStored: 0,
    unpairedRendered: 0,
    noStoredRecord: 0,
    emptyCells: 0,
    cells: 0,
    agree: 0,
    disagree: 0,
    renderedMore: 0,
    renderedFewer: 0,
  };
}

function sweep(listDisagreements) {
  const exe = path.join(REPO_ROOT, 'target', 'release', 'rhwp');
  if (!existsSync(exe)) throw new Error(`릴리스 바이너리가 없다: ${exe}`);
  const samples = path.join(REPO_ROOT, 'samples');
  const files = readdirSync(samples)
    .filter((f) => f.endsWith('.hwp') || f.endsWith('.hwpx'))
    .sort()
    .map((f) => path.join(samples, f));

  const totals = emptyTotals();
  for (const file of files) {
    const dump = spawnSync(exe, ['dump', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });
    if (dump.status !== 0 || !dump.stdout) continue;
    const out = mkdtempSync(path.join(tmpdir(), 'rhwp-cell-'));
    try {
      const tree = spawnSync(exe, ['export-render-tree', file, '-o', out], {
        encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000,
      });
      if (tree.status !== 0) continue;
      const rendered = [];
      const pages = readdirSync(out).filter((f) => f.endsWith('.json')).sort();
      pages.forEach((f, page) => {
        for (const c of renderedCells(JSON.parse(readFileSync(path.join(out, f), 'utf8')))) {
          rendered.push({ ...c, page });
        }
      });
      totals.documents += 1;
      const name = path.basename(file);
      const onDisagree = listDisagreements
        ? (s, renderedLines) => {
            // sw>w 힌트: 저장 줄 너비가 셀 폭을 넘는 셀은 참조 프레임이 셀 상자와
            // 다르거나(병합·들여쓰기·HWP3 계열) 열 너비 변경 뒤 재저장되지 않은
            // 낡은 캐시다 — 이 불일치는 배치 결함이 아닐 수 있으니 손으로 가른다.
            const hint = s.maxSw > s.width && s.width > 0 ? `  [sw ${s.maxSw} > w ${s.width}]` : '';
            console.log(
              `  [불일치] ${name} r${s.row}c${s.col} 저장 ${s.lines} → 렌더 ${renderedLines}  "${s.text.slice(0, 30)}"${hint}`,
            );
          }
        : undefined;
      tallyDocument(storedCells(dump.stdout), rendered, totals, onDisagree);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  return totals;
}

function report(t) {
  console.log(`  문서 ${t.documents}개 (못 짝지은 셀: 저장 ${t.unpairedStored} / 렌더 ${t.unpairedRendered})`);
  console.log(`  기록 없는 셀 ${t.noStoredRecord}개 (파일에 PARA_LINE_SEG 없음 — 비교 제외)`);
  console.log(`  빈 셀 ${t.emptyCells}개 (내용 키 없음 — 짝짓기 불가, 비교 제외)`);
  console.log(`  측정 셀 ${t.cells}개   일치 ${t.agree} = ${agreementPercent(t).toFixed(2)}%`);
  console.log(`  불일치 ${t.disagree}  (rhwp 가 더 많이 ${t.renderedMore} / 더 적게 ${t.renderedFewer})`);
}

function main() {
  const args = process.argv.slice(2);
  const totals = sweep(args.includes('--disagreements'));
  if (args.includes('--update')) {
    const doc = {
      _comment: [
        '셀 안 문단의 줄 나눔이 한/글 저장 기록과 일치하는 비율 (내용 키 짝짓기).',
        '갱신: node scripts/cell-lineseg-agreement.mjs --update',
        '이 비율은 내려갈 수 없다. 올리는 것이 목표다.',
        'noStoredRecord 는 파일에 PARA_LINE_SEG 가 없어 비교하지 못한 셀 수다(#6363) —',
        '렌더러와 무관한 파일 사실이므로, 샘플이 그대로인데 늘면 파서 회귀다.',
      ],
      ...totals,
      agreementPercent: Number(agreementPercent(totals).toFixed(2)),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
    report(totals);
    console.log(`[기록] ${BASELINE_PATH}`);
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  report(totals);
  const { regressions, improvements } = compareAgreement(totals, baseline);
  for (const i of improvements) console.log(`  [개선] ${i.what} ${i.was} → ${i.now}`);
  if (regressions.length > 0) {
    for (const r of regressions) console.log(`  [회귀] ${r.what} ${r.was} → ${r.now}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
