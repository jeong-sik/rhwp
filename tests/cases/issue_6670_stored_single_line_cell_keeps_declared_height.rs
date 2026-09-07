//! [Issue #6670] 저장 LINE_SEG 한 줄짜리 글자 셀이 선언 셀 높이를 지킨다.
//!
//! `2025 행정업무운영 편람(최종).hwp` 구역 10 문단 22(6×5 RowBreak 표, 빈 호스트):
//! 셀 r1 c3 `"10."` 은 25pt 글자(저장 lineseg vertsize 2500 = 33.3px)인데 선언
//! 셀 높이는 2349HU(31.3px, 위·아래 여백 566 → 안쪽 16.2px) 다. 한/글 2020·2024
//! PDF(`pdf/2025 행정업무운영 편람(최종)-hwp-2020.pdf` 287쪽) 괘선 실측: 표
//! 199.3→464.4(= 선언 19883HU, 265.1px), 1행 위 211.8, rowspan 셀(r1 c4, 4015HU)
//! 아래 265.3(= 1+2행 53.5px). `10.` 글자 bbox 는 213.9→246.3 이라 31.3px 행의
//! 아래 괘선을 3px 넘어 나온다 — 한/글은 행을 키우지 않는다. rhwp 는 이 행을
//! 줄 상자 + 여백 = 48.4px 로 키워(+17.1) 아래 흐름을 통째로 내렸고, 그 표류가
//! #6665 의 도형 줄 꼬리 줄간격(+6.67, 한/글과 일치) 뒤에 285쪽 조각을 본문
//! 밖으로 밀었다(`issue_3931_pi23_stored_reset_splits_across_adjacent_pages`).
//!
//! 판정: `composer::stored_single_line_text_cell_overflows_declared`.
#![cfg(not(target_arch = "wasm32"))]

use std::fs;
use std::path::Path;

use rhwp::renderer::{hwpunit_to_px, DEFAULT_DPI};
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

const FIXTURE: &str = "samples/2025 행정업무운영 편람(최종).hwp";
/// 구역 10 문단 22 표의 첫 질문 — 이 글이 든 `pi=22` 표 노드가 대상이다.
const TABLE_TEXT: &str = "공문서 작성시 연·월·일의 정확한 표기방법은 무엇입니까";
const TABLE_PARA_INDEX: u64 = 22;
/// 표 선언 높이(HWPUNIT) — 덤프 `[common] size=39686×19883`.
const DECLARED_TABLE_HEIGHT_HU: i32 = 19883;
/// 셀 r1 c3 선언 높이(HWPUNIT) — 덤프 `셀[3] r=1,c=3 … h=2349`.
const DECLARED_LABEL_CELL_HEIGHT_HU: i32 = 2349;

fn load() -> HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    HwpDocument::from_bytes(&bytes).expect("paginate fixture")
}

fn find_node<'a>(value: &'a Value, predicate: &impl Fn(&Value) -> bool) -> Option<&'a Value> {
    if predicate(value) {
        return Some(value);
    }
    value
        .get("children")
        .and_then(Value::as_array)
        .and_then(|children| children.iter().find_map(|c| find_node(c, predicate)))
}

fn bbox_h(node: &Value) -> f64 {
    node.get("bbox")
        .and_then(|b| b.get("h"))
        .and_then(Value::as_f64)
        .expect("render node bbox.h")
}

/// 대상 표 노드가 있는 쪽을 찾는다 — `pi` 는 구역 안 번호라 글로 가른다.
fn target_table(document: &HwpDocument) -> Value {
    for page in 0..document.page_count() {
        let tree: Value =
            serde_json::from_str(&document.get_page_render_tree(page).expect("render tree"))
                .expect("parse render tree");
        if let Some(table) = find_node(&tree, &|n| {
            n.get("type") == Some(&Value::from("Table"))
                && n.get("pi").and_then(Value::as_u64) == Some(TABLE_PARA_INDEX)
                && n.to_string().contains(TABLE_TEXT)
        }) {
            return table.clone();
        }
    }
    panic!("구역 10 문단 22 표를 어느 쪽에서도 찾지 못함");
}

#[test]
fn issue_6670_label_cell_keeps_declared_height() {
    let table = target_table(&load());
    let cell = find_node(&table, &|n| {
        n.get("type") == Some(&Value::from("Cell"))
            && n.get("row").and_then(Value::as_u64) == Some(1)
            && n.get("col").and_then(Value::as_u64) == Some(3)
    })
    .expect("cell r1 c3");
    let declared = hwpunit_to_px(DECLARED_LABEL_CELL_HEIGHT_HU, DEFAULT_DPI);
    let actual = bbox_h(cell);
    assert!(
        (actual - declared).abs() <= 0.3,
        "`10.` 셀(r1 c3) 높이는 선언 {declared:.1}px 이어야 한다 — 한/글 PDF 행 괘선 \
         211.8→243.1. 줄 상자(33.3) + 여백(15.1) 로 키우면 48.4: 실제 {actual:.1}"
    );
}

/// 한/글 PDF 괘선: 표 199.3→464.4(265.1px), 1행 위 211.8 → rowspan 셀(r1 c4,
/// 4015HU = 53.5px) 아래 265.3. rowspan 셀이 1+2행을 53.5 로 잡는 것까지 한/글과
/// 같고, 표 총 높이는 rowspan 몫 2.0px 만 남는다(수정 전 284.7, +19.6).
#[test]
fn issue_6670_table_height_follows_hancom_rules() {
    let table = target_table(&load());
    let rowspan_cell = find_node(&table, &|n| {
        n.get("type") == Some(&Value::from("Cell"))
            && n.get("row").and_then(Value::as_u64) == Some(1)
            && n.get("col").and_then(Value::as_u64) == Some(4)
    })
    .expect("cell r1 c4 (rowspan 2)");
    let rowspan_h = bbox_h(rowspan_cell);
    assert!(
        (rowspan_h - 53.5).abs() <= 0.3,
        "질문 셀(r1 c4, rowspan 2) 높이는 선언 4015HU = 53.5px 이어야 한다 — 한/글 괘선 \
         211.8→265.3: 실제 {rowspan_h:.1}"
    );

    let declared = hwpunit_to_px(DECLARED_TABLE_HEIGHT_HU, DEFAULT_DPI);
    let actual = bbox_h(&table);
    assert!(
        (actual - declared).abs() <= 2.5,
        "문단 22 표 높이는 한/글 괘선 199.3→464.4 = 선언 {declared:.1}px 에서 rowspan 몫 \
         2.0px 안에 있어야 한다 (수정 전 284.7): 실제 {actual:.1}"
    );
}
