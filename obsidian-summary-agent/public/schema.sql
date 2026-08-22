-- Obsidian Summary Agent 스키마
-- 기존 chevault-sync가 쓰는 chevalut2 Postgres에 그대로 추가한다 (별도 DB/저장소 없음).
-- 원본 노트는 이미 있는 notes 테이블을 그대로 읽기 전용으로 쓰고,
-- 이 프로젝트의 분석 결과만 summary_ 접두사 테이블에 저장한다
-- (chevault-sync의 기존 tags 테이블 등과 이름이 겹치지 않도록 접두사를 붙임).
--
-- 0. chevault-sync의 notes 테이블 (원본 스키마, 아직 이 DB에 적용된 적이 없어 여기 포함시킴).
--    summary_sources.note_id가 이 테이블을 참조하므로 먼저 존재해야 한다.
--    chevault-sync Worker가 실제로 배포되어 채워 넣기 전까지는 빈 테이블 상태다.
CREATE TABLE IF NOT EXISTS notes (
    id              BIGSERIAL PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    category        TEXT NOT NULL,
    folder_path     TEXT NOT NULL,
    content         TEXT NOT NULL,
    frontmatter     JSONB NOT NULL DEFAULT '{}'::jsonb,
    r2_modified_at  TIMESTAMPTZ,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_category ON notes (category);
CREATE INDEX IF NOT EXISTS idx_notes_folder_path ON notes (folder_path);

-- 1. 분석 대상 소스 (DB에서 가져온 노트 1건, 또는 업로드/붙여넣기 1건)
CREATE TABLE IF NOT EXISTS summary_sources (
    id                BIGSERIAL PRIMARY KEY,
    source_type       TEXT NOT NULL CHECK (source_type IN ('db', 'manual')),
    -- db 소스일 때만 채움: 원본 notes 테이블 행 참조 (해당 노트가 삭제되어도 분석 결과는 남긴다)
    note_id           BIGINT REFERENCES notes(id) ON DELETE SET NULL,
    -- db 소스는 notes.path와 동일 (중복 분석 방지용 유니크 키), manual은 NULL
    note_path         TEXT UNIQUE,
    note_title        TEXT NOT NULL,
    -- manual(업로드/붙여넣기) 소스만 원문을 보관. db 소스는 notes.content에 이미 있으므로 NULL.
    raw_content       TEXT,
    -- db 소스: notes.synced_at 기준값(중복 분석 방지). manual 소스: 분석 실행 시각.
    source_synced_at  TIMESTAMPTZ NOT NULL,
    analyzed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
