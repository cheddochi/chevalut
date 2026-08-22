import type { Env, ParsedSentence } from './types';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MAX_CONTENT_CHARS = 6000;

const SYSTEM_PROMPT = `너는 개인 메모(옵시디언 노트)를 분석하는 도우미다.
주어진 노트 원문을 읽고, 그 안에 담긴 내용을 "단일 사건" 단위의 문장으로 나눠라.
하나의 문장은 하나의 사실/사건/할 일만 담아야 하고, 너무 잘게 쪼개거나 여러 사건을 하나로 뭉치지 마라.
각 문장마다 관련 태그를 1~4개(한국어 명사 위주 핵심 키워드), 카테고리를 정확히 1개 부여해라.
카테고리는 노트의 성격을 나타내는 상위 분류로 자유롭게 판단해라(예: 회의, 할일, 학업, 아이디어, 개인 등).

반드시 아래 JSON 배열 형식으로만 답하고, 그 외 다른 설명이나 마크다운, 코드블록 표시는 절대 포함하지 마라:
[{"sentence": "...", "tags": ["...", "..."], "category": "..."}]

노트 내용이 비어 있거나 분석할 사건이 없으면 빈 배열 []을 반환해라.`;

export async function analyzeContent(env: Env, content: string): Promise<ParsedSentence[]> {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const truncated = trimmed.slice(0, MAX_CONTENT_CHARS);

  const result = await env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: truncated },
    ],
    max_tokens: 2048,
  });

  const raw = (result as { response?: string }).response ?? '';
  return parseModelOutput(raw);
}

function parseModelOutput(raw: string): ParsedSentence[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(
      (item): item is { sentence: string; tags?: unknown; category?: unknown } =>
        !!item && typeof item.sentence === 'string' && item.sentence.trim().length > 0
    )
    .map((item) => ({
      sentence: item.sentence.trim(),
      category:
        typeof item.category === 'string' && item.category.trim() ? item.category.trim() : '미분류',
      tags: Array.isArray(item.tags)
        ? item.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
    }));
}
