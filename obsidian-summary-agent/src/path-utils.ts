/**
 * R2 오브젝트 키(예: "vault/01.물류센터 자동화 시스템/회의록.md")에서
 * title(파일명, 확장자 제외)을 뽑아낸다.
 */
export function titleFromKey(objectKey: string, prefix: string): string {
  const relative = objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : objectKey;
  const parts = relative.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] ?? relative;
  return fileName.replace(/\.md$/, '');
}
