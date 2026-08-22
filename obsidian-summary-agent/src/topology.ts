import type { SentenceRecord, TopologyNode, TopologyEdge } from './types';

export function buildTopology(sentences: SentenceRecord[]): {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
} {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const seenCategories = new Set<string>();
  const seenTags = new Set<string>();

  for (const s of sentences) {
    nodes.push({
      id: `sentence:${s.id}`,
      type: 'sentence',
      label: s.text,
      source: s.source,
    });

    if (!seenCategories.has(s.category)) {
      seenCategories.add(s.category);
      nodes.push({ id: `category:${s.category}`, type: 'category', label: s.category });
    }
    edges.push({ source: `sentence:${s.id}`, target: `category:${s.category}`, kind: 'category' });

    for (const tag of s.tags) {
      if (!seenTags.has(tag)) {
        seenTags.add(tag);
        nodes.push({ id: `tag:${tag}`, type: 'tag', label: tag });
      }
      edges.push({ source: `sentence:${s.id}`, target: `tag:${tag}`, kind: 'tag' });
    }
  }

  return { nodes, edges };
}
