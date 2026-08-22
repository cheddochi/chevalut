import type { Env } from './types';
import {
  openSql,
  fetchSyncedNotes,
  getAlreadyAnalyzedDbPaths,
  upsertSourceAndSentences,
  listSentences,
  applySchema,
} from './db';
import { analyzeContent } from './analyzer';
import { buildTopology } from './topology';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/admin/init-schema' && request.method === 'POST') {
        return await handleInitSchema(request, env);
      }

      if (url.pathname === '/api/sync' && request.method === 'POST') {
        return await handleSync(env);
      }

      if (url.pathname === '/api/manual' && request.method === 'POST') {
        return await handleManual(request, env);
      }

      if (url.pathname === '/api/sentences' && request.method === 'GET') {
        const sql = openSql(env);
        try {
          const data = await listSentences(sql);
          return Response.json(data);
        } finally {
          await sql.end();
        }
      }

      if (url.pathname === '/api/topology' && request.method === 'GET') {
        const sql = openSql(env);
        try {
          const data = await listSentences(sql);
          return Response.json(buildTopology(data));
        } finally {
          await sql.end();
        }
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

async function handleSync(env: Env): Promise<Response> {
  const summary = {
    notesChecked: 0,
    notesAnalyzed: 0,
    notesSkipped: 0,
    sentencesCreated: 0,
    errors: [] as { path: string; message: string }[],
  };

  const sql = openSql(env);
  try {
    const [notes, analyzedPaths] = await Promise.all([
      fetchSyncedNotes(sql, env.VAULT_NOTES_TABLE),
      getAlreadyAnalyzedDbPaths(sql),
    ]);

    summary.notesChecked = notes.length;

    for (const note of notes) {
      const lastSyncedAt = analyzedPaths.get(note.path);
      if (lastSyncedAt && lastSyncedAt >= note.syncedAt) {
        summary.notesSkipped++;
        continue;
      }

      try {
        const sentences = await analyzeContent(env, note.content);
        const result = await upsertSourceAndSentences(
          sql,
          {
            sourceType: 'db',
            noteId: note.id,
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
          path: note.path,
          message: err instanceof Error ? err.message : String(err),
        });
      }
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
        noteId: null,
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
