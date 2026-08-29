// 셀 줄나눔 계측기(내용 키 짝짓기 + 조각 병합)의 계약.
//
// 계측기가 틀리면 회귀가 통과하거나 개선이 회귀로 보인다. 특히
// (1) 중첩 표의 ls 줄이 바깥 셀로 새면 저장 줄 수가 부풀고,
// (2) 못 짝지은 셀을 조용히 버리면 "안 재서 통과"가 생기고,
// (3) 렌더 0줄 셀을 판정하면 빈 셀이 불일치로 잡히고,
// (4) 기록 없는 문단(#6363)을 불일치로 세면 지표가 배치와 무관하게 깎이고,
// (5) 쪽 나눔 조각을 통짜 저장 셀과 비교하면 "더 적게"가 무더기로 나오고,
// (6) 머리말처럼 쪽마다 복제되는 셀을 조각으로 합산하면 "더 많이"가 무더기로 나온다.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agreementPercent,
  compareAgreement,
  renderedCells,
  storedCells,
  tallyDocument,
  textKey,
} from '../cell-lineseg-agreement.mjs';

function totals() {
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

const scell = (row, col, text, lines, width = 0, maxSw = 0) => ({ row, col, width, text, lines, maxSw });
const rcell = (table, row, col, text, lines, page = 0) => ({ table, row, col, text, lines, page });

test('텍스트 키는 공백과 줄 구분 기호를 걷고 앞 12자만 쓴다', () => {
  assert.equal(textKey('성 명|  '), '성명');
  assert.equal(textKey('가나다라마바사아자차카타파하'), '가나다라마바사아자차카타');
});

test('dump 에서 셀·행·열·텍스트·저장 줄 수를 뽑는다', () => {
  const dump = [
    '  [0] 표: 1행×1열, 셀=1, padding=(0,0,0,0), cs=0',
    '  [0]   셀[0] r=0,c=0 rs=1,cs=1 h=100 w=200 pad=(0,0,0,0) valign=Top aim=false hdr=false bf=1 paras=1 text="가나"',
    '  [0]     p[0] ps_id=1 ctrls=0 text_len=2 ls[0] ts=0 vpos=0 lh=100 ls=0 cs=0 sw=200',
  ].join('\n');
  assert.deepEqual(storedCells(dump), [scell(0, 0, '가나', 1, 200, 200)]);
});

test('개행 든 셀 텍스트도 셀로 등록되고 그 ls 가 직전 셀로 새지 않는다', () => {
  const dump = [
    '  [0] 표: 1행×2열, 셀=2, padding=(0,0,0,0), cs=0',
    '  [0]   셀[0] r=0,c=0 rs=1,cs=1 h=1 w=1 pad=(0,0,0,0) valign=Top aim=false hdr=false bf=1 paras=1 text="JSP, JAVA"',
    '  [0]     p[0] ps_id=1 ctrls=0 text_len=9 ls[0] ts=0 vpos=0 lh=1 ls=0 cs=0 sw=1, ls[1] ts=5 vpos=1 lh=1 ls=0 cs=0 sw=1',
    '  [0]   셀[1] r=0,c=1 rs=1,cs=1 h=1 w=1 pad=(0,0,0,0) valign=Top aim=false hdr=false bf=1 paras=1 text="운영중',
    '(사업대상)"',
    '  [0]     p[0] ps_id=1 ctrls=0 text_len=24 ls[0] ts=0 vpos=0 lh=1 ls=0 cs=0 sw=1, ls[1] ts=4 vpos=1 lh=1 ls=0 cs=0 sw=1',
  ].join('\n');
  assert.deepEqual(storedCells(dump), [
    scell(0, 0, 'JSP, JAVA', 2, 1, 1),
    scell(0, 1, '운영중\n(사업대상)', 2, 1, 1),
  ]);
});

test('중첩 표의 ls 는 안쪽 셀에 붙고 바깥 셀로 새지 않는다', () => {
  const dump = [
    '  [0] 표: 1행×1열, 셀=1, padding=(0,0,0,0), cs=0',
    '  [0]   셀[0] r=0,c=0 rs=1,cs=1 h=1 w=1 pad=(0,0,0,0) valign=Top aim=false hdr=false bf=1 paras=2 text="밖"',
    '  [0]     p[0] ps_id=1 ctrls=0 text_len=1 ls[0] ts=0 vpos=0 lh=1 ls=0 cs=0 sw=1',
    '  [0]     p[1] 내부표: 1행×1열, 셀=1, cs=0, pad=(0,0,0,0)',
    '  [0]       셀[0] r=0,c=0 rs=1,cs=1 h=1 w=1 pad=(0,0,0,0) valign=Top aim=false hdr=false bf=1 paras=1 text="안"',
    '  [0]         p[0] ps_id=1 ctrls=0 text_len=1 ls[0] ts=0 vpos=0 lh=1 ls=0 cs=0 sw=1',
    '  [0]     p[2] ps_id=1 ctrls=0 text_len=1 ls[0] ts=0 vpos=9 lh=1 ls=0 cs=0 sw=1',
  ].join('\n');
  const cells = storedCells(dump);
  assert.deepEqual(cells, [scell(0, 0, '밖', 2, 1, 1), scell(0, 0, '안', 1, 1, 1)]);
});

test('render tree 에서 Cell 별 TextLine 수·텍스트·조상 표 좌표를 뽑는다', () => {
  const tree = {
    type: 'Page',
    children: [
      {
        type: 'Table',
        pi: 7,
        ci: 0,
        children: [
          {
            type: 'Cell',
            row: 2,
            col: 3,
            children: [
              { type: 'TextLine', children: [{ type: 'TextRun', text: '가' }] },
              { type: 'TextLine', children: [{ type: 'TextRun', text: '나' }] },
              {
                type: 'Table',
                pi: 1,
                ci: 0,
                children: [
                  {
                    type: 'Cell',
                    row: 0,
                    col: 0,
                    children: [{ type: 'TextLine', children: [{ type: 'TextRun', text: '안' }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  // page 는 renderedCells 의 몫이 아니다 — 쪽별 트리를 도는 쪽(sweep)이 주입한다.
  // 내부표 자체는 TextLine 이 아니므로 바깥 셀 줄 수에 들지 않는다.
  assert.deepEqual(renderedCells(tree), [
    { table: '/7:0', row: 2, col: 3, text: '가|나', lines: 2 },
    { table: '/7:0/1:0', row: 0, col: 0, text: '안', lines: 1 },
  ]);
});

test('같은 내용 키끼리 짝지어 일치/불일치를 센다', () => {
  const t = totals();
  tallyDocument(
    [scell(0, 0, '가', 2), scell(0, 1, '나', 1)],
    [rcell('/1:0', 0, 0, '가', 2), rcell('/1:0', 0, 1, '나', 3)],
    t,
  );
  assert.equal(t.cells, 2);
  assert.equal(t.agree, 1);
  assert.equal(t.disagree, 1);
  assert.equal(t.renderedMore, 1);
  assert.equal(t.unpairedStored + t.unpairedRendered, 0);
});

test('개수가 달라도 문서를 버리지 않는다 — 남는 셀만 unpaired 로 센다', () => {
  const t = totals();
  tallyDocument(
    [scell(0, 0, '가', 1)],
    [rcell('/1:0', 0, 0, '가', 1), rcell('/2:0', 5, 5, '유령', 4)],
    t,
  );
  assert.equal(t.cells, 1);
  assert.equal(t.agree, 1);
  assert.equal(t.unpairedRendered, 1);
});

test('렌더 0줄 셀은 판정하지 않되 짝은 소비한다', () => {
  const t = totals();
  tallyDocument(
    [scell(0, 0, '가', 1), scell(0, 0, '가', 1)],
    [rcell('/1:0', 0, 0, '가', 0), rcell('/2:0', 0, 0, '가', 1)],
    t,
  );
  assert.equal(t.cells, 1);
  assert.equal(t.agree, 1);
  assert.equal(t.unpairedStored + t.unpairedRendered, 0);
});

test('다른 표의 같은 키는 순서대로 맞춘다', () => {
  const t = totals();
  tallyDocument(
    [scell(0, 0, '가', 1), scell(0, 0, '가', 2)],
    [rcell('/1:0', 0, 0, '가', 1), rcell('/2:0', 0, 0, '가', 2)],
    t,
  );
  assert.equal(t.agree, 2);
});

test('내용 키가 빈 셀은 짝짓기에서 빼고 emptyCells 로 센다 — 식별력이 없다', () => {
  // 편람: 저장 3줄 빈 셀의 진짜 렌더는 3줄 일치인데, 계측이 무관한 1줄 빈 셀과
  // 붙여 거짓 "더 적게"를 보고했다. 빈 키는 (행, 열)만으로 수백 셀이 겹친다.
  const t = totals();
  tallyDocument(
    [scell(0, 0, '||', 3), scell(0, 0, '가', 1)],
    [rcell('/1:0', 0, 0, '|', 1), rcell('/9:0', 0, 0, '가', 1)],
    t,
  );
  assert.equal(t.emptyCells, 2);
  assert.equal(t.cells, 1);
  assert.equal(t.agree, 1);
  assert.equal(t.disagree, 0);
  assert.equal(t.unpairedStored + t.unpairedRendered, 0);
});

test('저장 줄 수 0(기록 없음)은 불일치가 아니라 noStoredRecord 다', () => {
  const t = totals();
  tallyDocument([scell(0, 0, '가', 0)], [rcell('/1:0', 0, 0, '가', 1)], t);
  assert.equal(t.noStoredRecord, 1);
  assert.equal(t.cells, 0);
  assert.equal(t.disagree, 0);
});

test('이어지는 쪽의 조각은 같은 표 좌표로 합산해 저장 값과 비교한다', () => {
  const t = totals();
  tallyDocument(
    [scell(0, 0, '가나다라마바사아자차카타파하', 5)],
    [
      rcell('/3:0', 0, 0, '가나다라마바사', 3, 0),
      rcell('/3:0', 0, 0, '아자차카타파하', 2, 1),
    ],
    t,
  );
  assert.equal(t.cells, 1);
  assert.equal(t.agree, 1);
  assert.equal(t.unpairedRendered, 0);
});

test('떨어진 쪽의 무관한 표가 같은 표 좌표를 가져도 낱개로 갈라져 제 키로 짝지어진다', () => {
  // Table 의 pi:ci 는 문서 전역 유일이 아니다 — 다른 구역의 표가 같은 좌표를 갖는다.
  const t = totals();
  tallyDocument(
    [scell(0, 0, '고시', 1), scell(0, 0, '공고문안', 4)],
    [rcell('/5:0', 0, 0, '고시', 1, 2), rcell('/5:0', 0, 0, '공고문안', 4, 7)],
    t,
  );
  assert.equal(t.cells, 2);
  assert.equal(t.agree, 2);
  assert.equal(t.disagree, 0);
  assert.equal(t.unpairedStored + t.unpairedRendered, 0);
});

test('조각 합이 저장 값과 다르면 불일치 하나로 세고 콜백을 부른다', () => {
  const t = totals();
  const seen = [];
  tallyDocument(
    [scell(0, 0, '가나다라마바사아자차카타파하', 5)],
    [
      rcell('/3:0', 0, 0, '가나다라마바사', 3),
      rcell('/3:0', 0, 0, '아자차카타파하', 3),
    ],
    t,
    (s, renderedLines) => seen.push([s.lines, renderedLines]),
  );
  assert.equal(t.disagree, 1);
  assert.equal(t.renderedMore, 1);
  assert.deepEqual(seen, [[5, 6]]);
});

test('복제 렌더(같은 텍스트·같은 줄 수)는 합산하지 않고 대표 한 건으로 판정한다', () => {
  const t = totals();
  tallyDocument(
    [scell(0, 0, '머리말', 2)],
    [rcell('/3:0', 0, 0, '머리말', 2), rcell('/3:0', 0, 0, '머리말', 2), rcell('/3:0', 0, 0, '머리말', 2)],
    t,
  );
  assert.equal(t.cells, 1);
  assert.equal(t.agree, 1);
  assert.equal(t.disagree, 0);
  assert.equal(t.unpairedRendered, 0);
});

test('쪽번호 필드로 텍스트가 변주되는 복제도 첫 인스턴스 키로 짝지어 합산하지 않는다', () => {
  const t = totals();
  tallyDocument(
    [scell(0, 0, '- 1 -', 1)],
    [rcell('/3:0', 0, 0, '- 1 -', 1), rcell('/3:0', 0, 0, '- 2 -', 1), rcell('/3:0', 0, 0, '- 3 -', 1)],
    t,
  );
  assert.equal(t.cells, 1);
  assert.equal(t.agree, 1);
  assert.equal(t.disagree, 0);
  assert.equal(t.unpairedStored + t.unpairedRendered, 0);
});

test('복제끼리 줄 수가 갈리면 각 인스턴스를 판정해 쪽별 재조판 결함을 잡는다', () => {
  const t = totals();
  tallyDocument(
    [scell(0, 0, '머리말', 2)],
    [rcell('/3:0', 0, 0, '머리말', 2), rcell('/3:0', 0, 0, '머리말', 3)],
    t,
  );
  assert.equal(t.agree, 1);
  assert.equal(t.disagree, 1);
  assert.equal(t.renderedMore, 1);
});

test('일치율이 내려가면 회귀다', () => {
  const now = { ...totals(), cells: 100, agree: 90, unpairedStored: 0, unpairedRendered: 0 };
  const was = { ...totals(), cells: 100, agree: 95, unpairedStored: 0, unpairedRendered: 0 };
  const { regressions } = compareAgreement(now, was);
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].what, '일치율');
});

test('못 짝지은 셀이 늘면 회귀다', () => {
  const now = { ...totals(), cells: 100, agree: 100, unpairedStored: 3, unpairedRendered: 0 };
  const was = { ...totals(), cells: 100, agree: 100, unpairedStored: 1, unpairedRendered: 1 };
  const { regressions } = compareAgreement(now, was);
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].what, '못 짝지은 셀');
});

test('기록 없는 셀이 늘면 회귀다 — 파일 사실이므로 파서 귀속 회귀 신호다', () => {
  const now = { ...totals(), cells: 100, agree: 100, noStoredRecord: 10 };
  const was = { ...totals(), cells: 100, agree: 100, noStoredRecord: 4 };
  const { regressions } = compareAgreement(now, was);
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].what, '기록 없는 셀');
});

test('기준선에 noStoredRecord 가 없어도(구판) 비교가 죽지 않는다', () => {
  const was = { ...totals(), cells: 100, agree: 100 };
  delete was.noStoredRecord;
  const now = { ...totals(), cells: 100, agree: 100, noStoredRecord: 0 };
  const { regressions } = compareAgreement(now, was);
  assert.equal(regressions.length, 0);
});

test('측정 셀이 줄면 일치율이 올라도 회귀다 — 안 재서 통과 금지', () => {
  const now = { ...totals(), cells: 50, agree: 50 };
  const was = { ...totals(), cells: 100, agree: 95 };
  const { regressions } = compareAgreement(now, was);
  assert.ok(regressions.some((r) => r.what === '측정 셀'));
});

test('일치율이 오르면 개선으로 보고한다', () => {
  const now = { ...totals(), cells: 100, agree: 97 };
  const was = { ...totals(), cells: 100, agree: 95 };
  const { improvements, regressions } = compareAgreement(now, was);
  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 1);
});

test('빈 집계의 일치율은 0 이다', () => {
  assert.equal(agreementPercent(totals()), 0);
});
