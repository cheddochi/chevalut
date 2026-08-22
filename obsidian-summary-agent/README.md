# Obsidian Summary Agent

옵시디언 볼트가 실시간으로 동기화되는 Cloudflare R2 버킷(`chevault/vault/...`)에서 md 원문을
직접 읽어, 내용을 "단일 사건" 단위 문장으로 분석하고 태그/카테고리를 자동으로 붙여 저장하는
Cloudflare Worker. 분석 결과는 Hyperdrive를 통해 PlanetScale Postgres(`chevalut2`)에 저장한다
(별도 D1/KV 없음). 원본 md 자체는 R2에만 있고 Postgres에 복제하지 않는다.

## 구조

- R2 `chevault/vault/...` (읽기 전용) → 분석 대상 원본 md
- `summary_sources` — 분석된 노트/업로드 1건 (vault 소스는 R2 오브젝트 키를 기준으로 중복 분석 방지, manual 소스는 원문 보관)
- `summary_sentences` — 단일 사건 문장 + 카테고리
- `summary_tags` / `summary_sentence_tags` — 태그 정규화

문장 분리·태그·카테고리 생성은 Cloudflare Workers AI(`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)로 처리한다.

## 1. DB에 스키마 적용

`chevalut2`에 분석 결과 저장용 테이블만 추가한다 (원본 md 미러링 테이블은 두지 않음).
`public/schema.sql`은 정적 자산으로도 서빙되므로, **배포 후 Worker가 Hyperdrive로 직접 실행**하는
방법이 가장 간단하다 (로컬에 `psql`/연결 문자열이 없어도 됨):

```bash
curl -X POST https://<worker-url>/api/admin/init-schema
```

모든 문이 `IF NOT EXISTS`/`IF EXISTS` 기준이라 여러 번 실행해도 안전하다. `psql`을 직접 쓰고 싶다면:

```bash
psql "<PLANETSCALE_CONNECTION_STRING>" -f public/schema.sql
```

## 2. wrangler.jsonc 확인

Hyperdrive 구성 ID는 이미 채워져 있다 (`planetscale-chevalut2-main-qacf`, planning.md 참고).
R2 버킷 이름(`chevault`)과 접두사(`vars.VAULT_PREFIX = "vault/"`)가 실제 구조와 다르면 수정한다.

## 3. 설치 및 배포

```bash
npm install
npx wrangler login       # 브라우저 인증 필요
npx wrangler deploy
```

## 4. 사용

배포된 Worker URL을 열면 바로 웹 UI가 뜬다.

- **동기화된 노트 분석** 버튼: R2 `vault/` 아래에서 아직 분석 안 됐거나 변경된 노트를 찾아
  자동으로 분석한다 (기본 경로). 노트별 R2 마지막 수정 시각을 기준으로 중복 분석을 건너뛴다.
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

실제 R2/Hyperdrive/Workers AI 리소스에 연결된 상태로 `http://localhost:8787`에서 확인 가능하다.
