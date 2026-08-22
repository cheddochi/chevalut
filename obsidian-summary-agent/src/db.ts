import postgres from 'postgres';
import type { Env, ParsedSentence, SourceNote, SentenceRecord } from './types';

/** public/schema.sql을 세미콜론 단위로 나눠 순서대로 실행한다 (모든 문이 IF NOT EXISTS라 재실행해도 안전). */
export async function applySchema(sql: postgres.Sql, schemaSqlText: string): Promise<number> {
  // 줄 단위 "-- 주석"을 먼저 제거해야, 주석이 문(statement) 맨 앞에 붙어 있어도
  // 그 뒤에 오는 실제 SQL(예: CREATE TABLE)까지 통째로 걸러지는 일이 없다.
  const withoutComments = schemaSqlText.replace(/--[^\n]*/g, '');

  const statements = withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await sql.unsafe(statement);
  }
  return statements.length;
}

export function openSql(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false, // Hyperdrive에서는 prepared statement 캐시 이슈 방지를 위해 비활성화 권장
  });
}

/** 기존 chevault-sync가 채워 넣는 notes 테이블을 읽기 전용으로 조회한다. */
export async function fetchSyncedNotes(
  sql: postgres.Sql,
  table: string
): Promise<SourceNote[]> {
  const rows = await sql`
    SELECT id, path, title, content, synced_at
    FROM ${sql(table)}
    ORDER BY synced_at DESC
  `;

  return rows.map((r) => ({
    id: r.id as number,
    path: r.path as string,
    title: r.title as string,
    content: (r.content as string) ?? '',
    syncedAt: new Date(r.synced_at as string).toISOString(),
  }));
}

/** db 소스로 이미 분석된 노트의 path -> 마지막 분석 기준 동기화 시각 맵 (중복 분석 방지용). */
export async function getAlreadyAnalyzedDbPaths(sql: postgres.Sql): Promise<Map<string, string>> {
  const rows = await sql`
    SELECT note_path, source_synced_at
    FROM summary_sources
    WHERE source_type = 'db' AND note_path IS NOT NULL
  `;

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.note_path as string, new Date(row.source_synced_at as string).toISOString());
  }
  return map;
}

export interface SourceInput {
  sourceType: 'db' | 'manual';
  noteId: number | null;
  notePath: string | null;
  noteTitle: string;
  rawContent: string | null;
  sourceSyncedAt: string; // ISO string
}

export async function upsertSourceAndSentences(
  sql: postgres.Sql,
  source: SourceInput,
  sentences: ParsedSentence[]
): Promise<{ sourceId: number; sentenceCount: number }> {
  return sql.begin(async (tx) => {
    let sourceId: number;

    if (source.notePath) {
      const existing = await tx`
        SELECT id FROM summary_sources WHERE note_path = ${source.notePath}
      `;

      if (existing.length > 0) {
        sourceId = existing[0].id as number;
        await tx`DELETE FROM summary_sentences WHERE source_id = ${sourceId}`;
        await tx`
          UPDATE summary_sources
          SET note_id = ${source.noteId},
              note_title = ${source.noteTitle},
              raw_content = ${source.rawContent},
              source_synced_at = ${source.sourceSyncedAt},
              analyzed_at = now()
          WHERE id = ${sourceId}
        `;
      } else {
        const inserted = await tx`
          INSERT INTO summary_sources (
            source_type, note_id, note_path, note_title, raw_content, source_synced_at
          ) VALUES (
            ${source.sourceType}, ${source.noteId}, ${source.notePath},
            ${source.noteTitle}, ${source.rawContent}, ${source.sourceSyncedAt}
          )
          RETURNING id
        `;
        sourceId = inserted[0].id as number;
      }
    } else {
      const inserted = await tx`
        INSERT INTO summary_sources (
          source_type, note_id, note_path, note_title, raw_content, source_synced_at
        ) VALUES (
          ${source.sourceType}, NULL, NULL, ${source.noteTitle}, ${source.rawContent}, ${source.sourceSyncedAt}
        )
        RETURNING id
      `;
      sourceId = inserted[0].id as number;
    }

    for (const s of sentences) {
      const insertedSentence = await tx`
        INSERT INTO summary_sentences (source_id, text, category)
        VALUES (${sourceId}, ${s.sentence}, ${s.category})
        RETURNING id
      `;
      const sentenceId = insertedSentence[0].id as number;

      if (s.tags.length === 0) continue;

      await tx`
        INSERT INTO summary_tags (name)
        SELECT unnest(${tx.array(s.tags)}::text[])
        ON CONFLICT (name) DO NOTHING
      `;
      const tagRows = await tx`
        SELECT id FROM summary_tags WHERE name = ANY(${tx.array(s.tags)}::text[])
      `;
      if (tagRows.length > 0) {
        await tx`
          INSERT INTO summary_sentence_tags (sentence_id, tag_id)
          SELECT ${sentenceId}, unnest(${tx.array(tagRows.map((r) => r.id as number))}::bigint[])
          ON CONFLICT DO NOTHING
        `;
      }
    }

    return { sourceId, sentenceCount: sentences.length };
  });
}

export async function listSentences(sql: postgres.Sql): Promise<SentenceRecord[]> {
  const rows = await sql`
    SELECT
      s.id, s.text, s.category, s.created_at,
      src.source_type, src.note_path, src.note_title,
      COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
    FROM summary_sentences s
    JOIN summary_sources src ON src.id = s.source_id
    LEFT JOIN summary_sentence_tags st ON st.sentence_id = s.id
    LEFT JOIN summary_tags t ON t.id = st.tag_id
    GROUP BY s.id, src.source_type, src.note_path, src.note_title
    ORDER BY s.created_at DESC
  `;

  return rows.map((row) => ({
    id: row.id as number,
    text: row.text as string,
    category: row.category as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    tags: (row.tags as string[]) ?? [],
    source: {
      type: row.source_type as 'db' | 'manual',
      path: (row.note_path as string) ?? null,
      title: row.note_title as string,
    },
  }));
}
