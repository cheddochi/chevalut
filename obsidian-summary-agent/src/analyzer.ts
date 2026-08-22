import type { Env, ParsedSentence } from './types';

// llama-3.3-70b-instruct-fp8-fast는 품질은 좋지만 뉴런 단가가 비싸(출력 기준 8b-fp8의 약 7.9배)
// 하루 무료 할당량(10,000 뉴런)으로 볼트 전체(159개)를 다 못 돌리는 문제가 있어, 한국어 태그/카테고리
// 추출 수준에는 충분한 8b 모델로 낮춰 할당량 안에서 더 많은 노트를 처리할 수 있게 했다.
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const MAX_CONTENT_CHARS = 6000;

const SYSTEM_PROMPT = `너는 개인 메모(옵시디언 노트)를 분석하는 도우미다.
주어진 노트 원문을 읽고, 그 안에 담긴 내용을 "단일 사건" 단위의 문장으로 나눠라.
하나의 문장은 하나의 사실/사건/할 일만 담아야 하고, 너무 잘게 쪼개거나 여러 사건을 하나로 뭉치지 마라.
각 문장마다 관련 태그를 1~4개(한국어 명사 위주 핵심 키워드), 카테고리를 정확히 1개 부여해라.
카테고리는 노트의 성격을 나타내는 상위 분류로 자유롭게 판단해라(예: 회의, 할일, 학업, 아이디어, 개인 등).

개인정보 보호를 위해, 문장과 태그 어디에도 아래 세 가지가 그대로 남지 않도록 하라:
- 특정 개인의 실명 (예: "김철수", "박대리") → 문맥에 필요하면 "담당자", "동료", "팀원" 같은
  일반적인 역할/관계 표현으로 바꿔라. 직급만 있고 이름이 없는 경우(예: "팀장")는 그대로 둬도 된다.
- 차량 번호판 (예: "12가3456", "서울 34바 5678") → 문장에서 완전히 빼거나 "차량"으로 대체하라.
- 회사/기관 실명 (예: "PwC", "IBM", "한국오픈솔루션", 특정 고객사·협력사명) → "업체", "협력사",
  "거래처", "고객사" 같은 일반 표현으로 바꿔라. 옵시디언, 물류대학원처럼 노트 주인 본인이 속한
  조직/학교 이름이나 공개된 제품·기술명은 실명이 아니므로 그대로 둬도 된다.
문장의 나머지 의미(사건 자체, 날짜, 수치, 결정 사항 등)는 최대한 그대로 보존해라.

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

  // 일부 Workers AI 모델은 출력이 JSON처럼 보이면 문자열이 아니라 이미 파싱된
  // 배열/객체로 response를 채워준다. 문자열/사전파싱 배열 두 경우를 모두 처리한다.
  const raw = (result as { response?: unknown }).response;
  if (Array.isArray(raw)) return normalizeParsed(raw);
  if (typeof raw === 'string') return parseModelOutput(raw);

  // response가 배열도 문자열도 아니면 예상 못한 응답 형태 — "사건 없음"으로 조용히
  // 넘기지 말고 에러로 던져서 호출부(sync 루프)가 실패로 기록하고 다음 실행에서 재시도하게 한다.
  throw new Error(`예상치 못한 AI 응답 형식: ${JSON.stringify(raw).slice(0, 200)}`);
}

function parseModelOutput(raw: string): ParsedSentence[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    // 배열 형태 JSON을 아예 못 찾았다 — 모델이 "사건 없음"이라고 판단한 게 아니라
    // 형식이 깨진 출력을 낸 것이므로, 에러로 던져서 다음 sync 실행에서 재시도되게 한다.
    throw new Error(`JSON 배열을 찾지 못함: ${cleaned.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error(
      `JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)} — ${cleaned.slice(0, 200)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`JSON이 배열이 아님: ${cleaned.slice(0, 200)}`);
  }
  return normalizeParsed(parsed);
}

function normalizeParsed(parsed: unknown[]): ParsedSentence[] {
  return parsed
    .filter(
      (item): item is { sentence: string; tags?: unknown; category?: unknown } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { sentence?: unknown }).sentence === 'string' &&
        ((item as { sentence: string }).sentence.trim().length > 0)
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
