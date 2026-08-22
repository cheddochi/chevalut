# Obsidian Summary Agent

옵시디언 볼트(Cloudflare Hyperdrive 경유 PlanetScale Postgres `chevalut2`의 `notes` 테이블)를
읽어, 내용을 "단일 사건" 단위 문장으로 분석하고 태그/카테고리를 자동으로 붙여 저장하는
Cloudflare Worker. 저장도 같은 Hyperdrive 연결을 통해 `chevalut2`에 처리한다(별도 D1/KV 없음).

## 구조

- `notes` (기존 chevault-sync 테이블, 읽기 전용) → 분석 대상 원본
- `summary_sources` — 분석된 노트/업로드 1건 (db 소스는 `notes`를 참조, manual 소스는 원문 보관)
- `summary_sentences` — 단일 사건 문장 + 카테고리
- `summary_tags` / `summary_sentence_tags` — 태그 정규화

문장 분리·태그·카테고리 생성은 Cloudflare Workers AI(`@cf/meta/llama-3.1-8b-instruct`)로 처리한다.

## 1. DB에 스키마 적용

기존 chevault-sync가 쓰는 `chevalut2`에 테이블을 추가한다 (같은 DB, 다른 테이블 세트).
`public/schema.sql`은 정적 자산으로도 서빙되므로, **배포 후 Worker가 Hyperdrive로 직접 실행**하는
방법이 가장 간단하다 (로컬에 `psql`/연결 문자열이 없어도 됨):

```bash
curl -X POST https://<worker-url>/api/admin/init-schema
```

모든 문이 `IF NOT EXISTS` 기준이라 여러 번 실행해도 안전하다. `psql`을 직접 쓰고 싶다면:

```bash
psql "<PLANETSCALE_CONNECTION_STRING>" -f public/schema.sql
```

## 2. wrangler.jsonc 확인

Hyperdrive 구성 ID는 이미 채워져 있다 (`planetscale-chevalut2-main-qacf`, planning.md 참고).
`VAULT_NOTES_TABLE` 값이 실제 원본 테이블명과 다르면 `wrangler.jsonc`의 `vars.VAULT_NOTES_TABLE`을 수정한다.

## 3. 설치 및 배포

```bash
npm install
npx wrangler login       # 브라우저 인증 필요
npx wrangler deploy
```

## 4. 사용

배포된 Worker URL을 열면 바로 웹 UI가 뜬다.

- **동기화된 노트 분석** 버튼: Hyperdrive로 연결된 `notes` 테이블에서 아직 분석 안 됐거나 변경된
  노트를 찾아 자동으로 분석한다 (기본 경로).
- **개별 노트 분석**: md 파일 업로드 또는 내용 붙여넣기로 즉석 분석 (보조 경로).
- **목록 보기 / 토폴로지 보기** 탭으로 전환 가능.

API만 직접 호출하고 싶다면:

```bash
curl -X POST https://<worker-url>/api/sync
curl -X POST https://<worker-url>/api/manual -H "Content-Type: application/json" \
  -d '{"title":"메모","content":"..."}'
curl https://<worker-url>/api/sentences
curl https://<worker-url>/api/topology
```

## 5. 로컬 테스트

```bash
npx wrangler dev
```

실제 Hyperdrive/Workers AI 리소스에 연결된 상태로 `http://localhost:8787`에서 확인 가능하다.
