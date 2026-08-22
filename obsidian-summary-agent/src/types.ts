export interface Env {
  HYPERDRIVE: Hyperdrive;
  AI: Ai;
  ASSETS: Fetcher;
  VAULT_NOTES_TABLE: string;
}

export interface ParsedSentence {
  sentence: string;
  tags: string[];
  category: string;
}

export interface SourceNote {
  id: number;
  path: string;
  title: string;
  content: string;
  syncedAt: string;
}

export interface SentenceRecord {
  id: number;
  text: string;
  category: string;
  createdAt: string;
  tags: string[];
  source: {
    type: 'db' | 'manual';
    path: string | null;
    title: string;
  };
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
