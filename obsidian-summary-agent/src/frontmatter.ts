/**
 * 옵시디언 마크다운의 YAML 프론트매터를 걷어내고 본문만 돌려주는 경량 파서.
 * AI 분석에는 프론트매터(메타데이터)가 아니라 본문 내용만 필요하므로,
 * 태그/속성 값까지 정교하게 파싱할 필요는 없고 앞의 --- ... --- 블록만 제거하면 된다.
 */
const FRONTMATTER_DELIM = /^---\s*$/;

export function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);

  if (!FRONTMATTER_DELIM.test(lines[0] ?? '')) {
    return raw;
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) return raw;

  return lines
    .slice(endIndex + 1)
    .join('\n')
    .replace(/^\n+/, '');
}
