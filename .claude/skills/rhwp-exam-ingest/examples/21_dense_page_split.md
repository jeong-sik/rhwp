# 예제 21_dense_page_split — 빽빽한 페이지

이 워크스루는 gym 과제가 아니다. 기존 helper 와 `rhwp build-from-ingest` 만 쓴다.
교차: `F09`. 동작: 사분면 Vision.

## 입력

사용자가 시험지 원본(또는 그 경로)을 준다. 원본은 읽기만 한다.

## 명령

```bash
bash .claude/skills/rhwp-exam-ingest/helpers/check_deps.sh --json
rhwp build-from-ingest "$TMP/ingest.json" --media-dir "$MEDIA" -o "$OUT"
rhwp export-text "$OUT" -o "$TMP/txt"
rhwp dump "$OUT" > "$TMP/dump.txt"
```

## ingest 요지

- 스키마 `version: "1"`. 미지 필드 없음.
- 교차 픽스처/정지를 `F09` 로 확인.
- `auto_number` 정책을 10장에 맞게 고정.

## 정지

실패 봉투는 `references/14_failure_envelopes.md`. 성공이 아니면 `-o` 산출을 사용자에게 주지 않는다.

## 한계

그림의 포함·참조·표시를 확인한다. 수식·표는 이 ingest 스키마가 지원하는 그림으로 옮긴다. 빌더 구현은 변경하지 않는다.
