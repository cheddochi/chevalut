-- Obsidian Summary Agent 스키마
-- 기존 chevault-sync가 쓰던 chevalut2 Postgres에 그대로 추가한다 (별도 DB/저장소 없음).
-- 원본 md는 Cloudflare R2 버킷(chevault/vault/...)에만 있고, 이 프로젝트가 다시 저장하지 않는다.
-- 분석 결과(문장/태그/카테고리)만 summary_ 접두사 테이블에 저장한다.
--
-- 참고: 이전 버전에서는 "Postgres notes 테이블에 원본이 미러링되어 있다"고 가정하고
-- summary_sources.note_id로 그 테이블을 참조했으나, 실제로는 원본이 R2에만 있고
-- Postgres notes 테이블은 쓰이지 않는 것으로 확인되어 그 의존성을 제거했다.
-- (예전에 실수로 만들어졌던 notes 테이블 참조/제약은 아래에서 정리한다.)

-- 1. 분석 대상 소스 (R2 볼트에서 가져온 노트 1건, 또는 업로드/붙여넣기 1건)
CREATE TABLE IF NOT EXISTS summary_sources (
    id                BIGSERIAL PRIMARY KEY,
    source_type       TEXT NOT NULL CHECK (source_type IN ('vault', 'manual')),
    -- vault 소스는 R2 오브젝트 키(예: vault/01.../회의록.md)와 동일 (중복 분석 방지용 유니크 키), manual은 NULL
    note_path         TEXT UNIQUE,
    note_title        TEXT NOT NULL,
    -- manual(업로드/붙여넣기) 소스만 원문을 보관. vault 소스는 R2에 이미 있으므로 NULL.
    raw_content       TEXT,
    -- vault 소스: R2 오브젝트의 마지막 수정 시각(중복 분석 방지 기준). manual 소스: 분석 실행 시각.
    source_synced_at  TIMESTAMPTZ NOT NULL,
    analyzed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 이전 버전에서 만들어졌던 notes 테이블 참조 컬럼/제약 정리 (있으면 제거, 없으면 무시).
ALTER TABLE summary_sources DROP COLUMN IF EXISTS note_id;
ALTER TABLE summary_sources DROP CONSTRAINT IF EXISTS summary_sources_source_type_check;
ALTER TABLE summary_sources ADD CONSTRAINT summary_sources_source_type_check
    CHECK (source_type IN ('vault', 'manual'));

CREATE INDEX IF NOT EXISTS idx_summary_sources_type ON summary_sources (source_type);

-- 2. 단일 사건 문장
CREATE TABLE IF NOT EXISTS summary_sentences (
    id          BIGSERIAL PRIMARY KEY,
    source_id   BIGINT NOT NULL REFERENCES summary_sources(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    category    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_summary_sentences_source ON summary_sentences (source_id);
CREATE INDEX IF NOT EXISTS idx_summary_sentences_category ON summary_sentences (category);

-- 3. 태그 (정규화) — chevault-sync의 기존 tags 테이블과 겹치지 않도록 별도 테이블 사용
CREATE TABLE IF NOT EXISTS summary_tags (
    id   BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS summary_sentence_tags (
    sentence_id BIGINT NOT NULL REFERENCES summary_sentences(id) ON DELETE CASCADE,
    tag_id      BIGINT NOT NULL REFERENCES summary_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (sentence_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_summary_sentence_tags_tag ON summary_sentence_tags (tag_id);

-- 4. 앱 설정 (자동 동기화 on/off 등) — 단일 행(id=1)만 사용.
-- 10분마다 도는 cron 자체는 계속 실행되지만, 이 값이 false면 AI 호출 없이 그냥 넘어간다.
CREATE TABLE IF NOT EXISTS app_settings (
    id                 INT PRIMARY KEY DEFAULT 1,
    auto_sync_enabled  BOOLEAN NOT NULL DEFAULT false,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (id, auto_sync_enabled) VALUES (1, false)
ON CONFLICT (id) DO NOTHING;
