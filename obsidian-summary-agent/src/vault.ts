import type { Env, VaultNote } from './types';
import { stripFrontmatter } from './frontmatter';
import { titleFromKey } from './path-utils';

export interface VaultObjectMeta {
  key: string;
  uploaded: string; // ISO
}

/**
 * R2 버킷의 VAULT_PREFIX 아래 .md 오브젝트 목록(키 + 수정시각)을 페이지네이션으로 수집한다.
 * list() 결과에 이미 uploaded 메타데이터가 있어, 본문을 받지 않고도 변경 여부를 먼저 판단할 수 있다.
 */
export async function listVaultMdObjects(env: Env): Promise<VaultObjectMeta[]> {
  const objects: VaultObjectMeta[] = [];
  let cursor: string | undefined;

  do {
    const listed = await env.VAULT_BUCKET.list({
      prefix: env.VAULT_PREFIX,
      cursor,
      limit: 1000,
    });
    for (const obj of listed.objects) {
      if (obj.key.endsWith('.md')) {
        objects.push({ key: obj.key, uploaded: obj.uploaded.toISOString() });
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return objects;
}

/** R2 오브젝트 원문을 그대로(프론트매터 포함) 반환한다 — 화면에서 노트 전체 내용을 보여줄 때 사용. */
export async function fetchVaultRawContent(env: Env, key: string): Promise<string | null> {
  const obj = await env.VAULT_BUCKET.get(key);
  if (!obj) return null;
  return obj.text();
}

/** R2 오브젝트 하나를 읽어 프론트매터를 제거한 본문과 메타데이터를 반환한다. */
export async function fetchVaultNote(env: Env, key: string): Promise<VaultNote | null> {
  const obj = await env.VAULT_BUCKET.get(key);
  if (!obj) return null;

  const raw = await obj.text();
  const content = stripFrontmatter(raw);
  const title = titleFromKey(key, env.VAULT_PREFIX);

  return {
    path: key,
    title,
    content,
    syncedAt: obj.uploaded.toISOString(),
  };
}
