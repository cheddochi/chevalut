import type { Env } from './types';
import {
  openSql,
  getAlreadyAnalyzedVaultPaths,
  upsertSourceAndSentences,
  listSentences,
  getTagStats,
  getSourceMeta,
  applySchema,
} from './db';
import { analyzeContent } from './analyzer';
import { buildTopology } from './topology';
import { listVaultMdObjects, fetchVaultNote, fetchVaultRawContent } from './vault';

const SYNC_CONCURRENCY = 8; // Workers AI 호출이 무거우므로 동시 처리 개수를 적게 유지

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/admin/init-schema' && request.method === 'POST') {
        return await handleInitSchema(request, env);
      }

      if (url.pathname === '/api/sync' && request.method === 'POST') {
        return await handleSync(env, request);
      }

      if (url.pathname === '/api/manual' && request.method === 'POST') {
        return await handleManual(request, env);
      }

      if (url.pathname === '/api/sentences' && request.method === 'GET') {
        const tag = url.searchParams.get('tag') ?? undefined;
        const sql = openSql(env);
        try {
          const data = await listSentences(sql, { tag });
          return Response.json(data);
        } finally {
          await sql.end();
        }
      }

      if (url.pathname === '/api/topology' && request.method === 'GET') {
        const tag = url.searchParams.get('tag') ?? undefined;
        const sql = openSql(env);
        try {
          const data = await listSentences(sql, { tag });
          return Response.json(buildTopology(data));
        } finally {
          await sql.end();
        }
      }

      if (url.pathname === '/api/tags' && request.method === 'GET') {
        const sql = openSql(env);
        try {
          const data = await getTagStats(sql);
          return Response.json(data);
        } finally {
          await sql.end();
        }
      }

      if (url.pathname === '/api/note-content' && request.method === 'GET') {
        return await handleNoteContent(url, env);
      }
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      );
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleNoteContent(url: URL, env: Env): Promise<Response> {
  const sourceIdParam = url.searchParams.get('sourceId');
  const sourceId = Number(sourceIdParam);
  if (!sourceIdParam || !Number.isFinite(sourceId)) {
    return Response.json({ error: 'sourceId가 필요합니다.' }, { status: 400 });
  }

  const sql = openSql(env);
  let meta;
  try {
    meta = await getSourceMeta(sql, sourceId);
  } finally {
    await sql.end();
  }

  if (!meta) {
    return Response.json({ error: '해당 노트를 찾을 수 없습니다.' }, { status: 404 });
  }

  const content =
    meta.type === 'vault' && meta.path
      ? await fetchVaultRawContent(env, meta.path)
      : (meta.rawContent ?? '');

  return Response.json({
    id: sourceId,
    type: meta.type,
    path: meta.path,
    title: meta.title,
    content: content ?? '',
  });
}

async function handleInitSchema(request: Request, env: Env): Promise<Response> {
  const schemaUrl = new URL('/schema.sql', request.url);
  const schemaRes = await env.ASSETS.fetch(new Request(schemaUrl));
  if (!schemaRes.ok) {
    return Response.json({ error: 'schema.sql을 찾을 수 없습니다.' }, { status: 500 });
  }
  const schemaSqlText = await schemaRes.text();

  const sql = openSql(env);
  try {
    const statementsRun = await applySchema(sql, schemaSqlText);
    return Response.json({ statementsRun });
  } finally {
    await sql.end();
  }
}

const DEFAULT_SYNC_LIMIT = 15; // 요청 하나당 처리할 노트 수 상한 (Worker 실행 시간 제한 때문에 전체를 한 번에 못 돌림)

async function handleSync(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_SYNC_LIMIT;

  const summary = {
    notesChecked: 0,
    notesAnalyzed: 0,
    notesSkipped: 0,
    sentencesCreated: 0,
    remaining: 0,
    errors: [] as { path: string; message: string }[],
  };

  const sql = openSql(env);
  try {
    const [objects, analyzedPaths] = await Promise.all([
      listVaultMdObjects(env),
      getAlreadyAnalyzedVaultPaths(sql),
    ]);

    summary.notesChecked = objects.length;

    const outOfDate = objects.filter((obj) => {
      const lastSyncedAt = analyzedPaths.get(obj.key);
      const unchanged = lastSyncedAt !== undefined && lastSyncedAt >= obj.uploaded;
      if (unchanged) summary.notesSkipped++;
      return !unchanged;
    });

    const toProcess = outOfDate.slice(0, limit);
    summary.remaining = outOfDate.length - toProcess.length;

    for (let i = 0; i < toProcess.length; i += SYNC_CONCURRENCY) {
      const batch = toProcess.slice(i, i + SYNC_CONCURRENCY);

      await Promise.all(
        batch.map(async (obj) => {
          try {
            const note = await fetchVaultNote(env, obj.key);
            if (!note) return;

            const sentences = await analyzeContent(env, note.content);
            const result = await upsertSourceAndSentences(
              sql,
              {
                sourceType: 'vault',
                notePath: note.path,
                noteTitle: note.title,
                rawContent: null,
                sourceSyncedAt: note.syncedAt,
              },
              sentences
            );
            summary.notesAnalyzed++;
            summary.sentencesCreated += result.sentenceCount;
          } catch (err) {
            summary.errors.push({
              path: obj.key,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        })
      );
    }
  } finally {
    await sql.end();
  }

  return Response.json(summary);
}

async function handleManual(request: Request, env: Env): Promise<Response> {
  let title = '붙여넣기';
  let content = '';

  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (file instanceof File) {
      title = file.name;
      content = await file.text();
    }
  } else {
    const body = (await request.json()) as { title?: string; content?: string };
    content = body.content ?? '';
    if (body.title) title = body.title;
  }

  if (!content.trim()) {
    return Response.json({ error: '분석할 내용이 없습니다.' }, { status: 400 });
  }

  const sql = openSql(env);
  try {
    const sentences = await analyzeContent(env, content);
    const result = await upsertSourceAndSentences(
      sql,
      {
        sourceType: 'manual',
        notePath: null,
        noteTitle: title,
        rawContent: content,
        sourceSyncedAt: new Date().toISOString(),
      },
      sentences
    );
    return Response.json({ sourceId: result.sourceId, sentenceCount: result.sentenceCount });
  } finally {
    await sql.end();
  }
}
