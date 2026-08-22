export interface Env {
  VAULT_BUCKET: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  AI: Ai;
  ASSETS: Fetcher;
  VAULT_PREFIX: string;
}

export interface ParsedSentence {
  sentence: string;
  tags: string[];
  category: string;
}

export interface VaultNote {
  path: string; // R2 오브젝트 키
  title: string;
  content: string; // 프론트매터 제거된 본문
  syncedAt: string; // R2 오브젝트의 마지막 수정 시각 (ISO)
}

export interface SentenceRecord {
  id: number;
  text: string;
  category: string;
  createdAt: string;
  tags: string[];
  source: {
    id: number;
    type: 'vault' | 'manual';
    path: string | null;
    title: string;
  };
}

export interface TagStat {
  name: string;
  count: number;
  related: { name: string; count: number }[];
}

export interface SourceContent {
  id: number;
  type: 'vault' | 'manual';
  path: string | null;
  title: string;
  content: string;
}

export interface TopologyNode {
  id: string;
  type: 'sentence' | 'tag' | 'category';
  label: string;
  source?: SentenceRecord['source'];
}

export interface TopologyEdge {
  source: string;
  target: string;
  kind: 'tag' | 'category';
}
