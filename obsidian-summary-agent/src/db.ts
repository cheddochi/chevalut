import postgres from 'postgres';
import type { Env, ParsedSentence, SentenceRecord, TagStat } from './types';

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

/**
 * 지금까지 분석된 결과(문장/태그/소스)를 전부 지운다. 사람이름·차량번호·회사이름을 걸러내지
 * 못하던 예전 프롬프트로 생성된 데이터를 없애고, 다음 동기화(수동 또는 cron)에서 개인정보를
 * 가리는 새 프롬프트로 처음부터 다시 분석하게 하기 위함. summary_sources를 지우면
 * ON DELETE CASCADE로 summary_sentences/summary_sentence_tags도 함께 삭제된다.
 */
export async function wipeAllSummaryData(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM summary_sources`;
  await sql`DELETE FROM summary_tags`;
}

/**
 * 문장이 0개인 vault 소스만 골라 삭제한다. AI가 그때 형식이 깨진 응답을 내서
 * "분석 완료(사건 없음)"로 잘못 기록된 노트를 다음 sync에서 다시 시도하게 하기 위함
 * (실제로 사건이 없어서 0개인 것과 구분은 못 하지만, 재시도해도 비용이 크지 않다).
 * 이미 문장이 있는 소스는 건드리지 않는다.
 */
export async function retryEmptyVaultSources(sql: postgres.Sql): Promise<number> {
  const deleted = await sql`
    DELETE FROM summary_sources
    WHERE source_type = 'vault'
      AND id NOT IN (SELECT DISTINCT source_id FROM summary_sentences)
    RETURNING id
  `;
  return deleted.length;
}

export function openSql(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false, // Hyperdrive에서는 prepared statement 캐시 이슈 방지를 위해 비활성화 권장
  });
}

/** vault(R2) 소스로 이미 분석된 노트의 path -> 마지막 분석 기준 동기화 시각 맵 (중복 분석 방지용). */
export async function getAlreadyAnalyzedVaultPaths(sql: postgres.Sql): Promise<Map<string, string>> {
  const rows = await sql`
    SELECT note_path, source_synced_at
    FROM summary_sources
    WHERE source_type = 'vault' AND note_path IS NOT NULL
  `;

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.note_path as string, new Date(row.source_synced_at as string).toISOString());
  }
  return map;
}

export interface SourceInput {
  sourceType: 'vault' | 'manual';
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
          SET note_title = ${source.noteTitle},
              raw_content = ${source.rawContent},
              source_synced_at = ${source.sourceSyncedAt},
              analyzed_at = now()
          WHERE id = ${sourceId}
        `;
      } else {
        const inserted = await tx`
          INSERT INTO summary_sources (
            source_type, note_path, note_title, raw_content, source_synced_at
          ) VALUES (
            ${source.sourceType}, ${source.notePath},
            ${source.noteTitle}, ${source.rawContent}, ${source.sourceSyncedAt}
          )
          RETURNING id
        `;
        sourceId = inserted[0].id as number;
      }
    } else {
      const inserted = await tx`
        INSERT INTO summary_sources (
          source_type, note_path, note_title, raw_content, source_synced_at
        ) VALUES (
          ${source.sourceType}, NULL, ${source.noteTitle}, ${source.rawContent}, ${source.sourceSyncedAt}
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

      // Hyperdrive(fetch_types: false) 하에서는 sql.array() + ::text[] 캐스트가
      // 제대로 된 배열 리터럴을 만들지 못해 "malformed array literal" 오류가 나서,
      // 태그 개수가 적은 점(문장당 1~4개)을 고려해 배열 없이 태그별로 처리한다.
      for (const tagName of s.tags) {
        await tx`
          INSERT INTO summary_tags (name) VALUES (${tagName})
          ON CONFLICT (name) DO NOTHING
        `;
        const tagRow = await tx`SELECT id FROM summary_tags WHERE name = ${tagName}`;
        if (tagRow.length > 0) {
          await tx`
            INSERT INTO summary_sentence_tags (sentence_id, tag_id)
            VALUES (${sentenceId}, ${tagRow[0].id})
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }

    return { sourceId, sentenceCount: sentences.length };
  });
}

/**
 * Hyperdrive 연결은 fetch_types:false라 배열 타입 자동 파싱이 꺼져 있어서,
 * array_agg 결과가 JS 배열이 아니라 Postgres 배열 리터럴 문자열(예: `{a,"b c"}`)로 온다.
 * 이를 직접 파싱한다.
 */
function parsePgTextArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]; // 혹시 이미 파싱되어 오는 경우 대비
  if (typeof raw !== 'string') return [];

  const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
  if (inner === '') return [];

  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuotes) {
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[i + 1];
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map((s) => s.trim()).filter(Boolean);
}

export async function listSentences(
  sql: postgres.Sql,
  options: { tag?: string } = {}
): Promise<SentenceRecord[]> {
  const rows = options.tag
    ? await sql`
        SELECT
          s.id, s.text, s.category, s.created_at,
          src.id AS source_id, src.source_type, src.note_path, src.note_title,
          COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
        FROM summary_sentences s
        JOIN summary_sources src ON src.id = s.source_id
        LEFT JOIN summary_sentence_tags st ON st.sentence_id = s.id
        LEFT JOIN summary_tags t ON t.id = st.tag_id
        WHERE s.id IN (
          SELECT st2.sentence_id FROM summary_sentence_tags st2
          JOIN summary_tags t2 ON t2.id = st2.tag_id
          WHERE t2.name = ${options.tag}
        )
        GROUP BY s.id, src.id, src.source_type, src.note_path, src.note_title
        ORDER BY s.created_at DESC
      `
    : await sql`
        SELECT
          s.id, s.text, s.category, s.created_at,
          src.id AS source_id, src.source_type, src.note_path, src.note_title,
          COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
        FROM summary_sentences s
        JOIN summary_sources src ON src.id = s.source_id
        LEFT JOIN summary_sentence_tags st ON st.sentence_id = s.id
        LEFT JOIN summary_tags t ON t.id = st.tag_id
        GROUP BY s.id, src.id, src.source_type, src.note_path, src.note_title
        ORDER BY s.created_at DESC
      `;

  return rows.map((row) => ({
    id: row.id as number,
    text: row.text as string,
    category: row.category as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    tags: parsePgTextArray(row.tags),
    source: {
      id: row.source_id as number,
      type: row.source_type as 'vault' | 'manual',
      path: (row.note_path as string) ?? null,
      title: row.note_title as string,
    },
  }));
}

/** 태그별 빈도수 + 함께 등장한(1차 연관) 태그 상위 목록. */
export async function getTagStats(sql: postgres.Sql, relatedLimit = 8): Promise<TagStat[]> {
  const counts = await sql`
    SELECT t.name, count(*) AS cnt
    FROM summary_tags t
    JOIN summary_sentence_tags st ON st.tag_id = t.id
    GROUP BY t.name
    ORDER BY cnt DESC
  `;

  const related = await sql`
    SELECT t1.name AS tag, t2.name AS related_tag, count(*) AS cnt
    FROM summary_sentence_tags st1
    JOIN summary_sentence_tags st2
      ON st1.sentence_id = st2.sentence_id AND st1.tag_id <> st2.tag_id
    JOIN summary_tags t1 ON t1.id = st1.tag_id
    JOIN summary_tags t2 ON t2.id = st2.tag_id
    GROUP BY t1.name, t2.name
    ORDER BY t1.name, cnt DESC
  `;

  const relatedByTag = new Map<string, { name: string; count: number }[]>();
  for (const row of related) {
    const tag = row.tag as string;
    const list = relatedByTag.get(tag) ?? [];
    if (list.length < relatedLimit) {
      list.push({ name: row.related_tag as string, count: Number(row.cnt) });
    }
    relatedByTag.set(tag, list);
  }

  return counts.map((row) => ({
    name: row.name as string,
    count: Number(row.cnt),
    related: relatedByTag.get(row.name as string) ?? [],
  }));
}

/** 노트/업로드 원문 전체를 가져온다. vault 소스는 원문이 R2에 있어 별도로 읽어야 하므로 note_path만 반환한다. */
export async function getSourceMeta(
  sql: postgres.Sql,
  sourceId: number
): Promise<{ type: 'vault' | 'manual'; path: string | null; title: string; rawContent: string | null } | null> {
  const rows = await sql`
    SELECT source_type, note_path, note_title, raw_content
    FROM summary_sources
    WHERE id = ${sourceId}
  `;
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    type: row.source_type as 'vault' | 'manual',
    path: (row.note_path as string) ?? null,
    title: row.note_title as string,
    rawContent: (row.raw_content as string) ?? null,
  };
}
