export interface NebulaMap {
  id: number;
  userId?: number;
  name: string;
  description: string;
  createdAt: string;
}

export interface UserAccount {
  id: number;
  username: string;
  createdAt: string;
}

export interface TagNode {
  id: number;
  name: string;
  color: string;
  count: number;
}

export interface LogTag {
  id: number;
  name: string;
  color: string;
}

export interface LogEntry {
  id: number;
  mapId: number;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  tags: LogTag[];
}

export interface GraphEdge {
  logId: number;
  tagId: number;
  weight: number;
}

export interface TagSimilarity {
  tagAId: number;
  tagBId: number;
  score: number;
  semanticScore: number;
  cooccurrenceScore: number;
  source: 'deepseek' | 'local';
  reason?: string;
}

export interface GraphData {
  map: NebulaMap;
  tags: TagNode[];
  logs: LogEntry[];
  edges: GraphEdge[];
  tagSimilarities: TagSimilarity[];
}

export interface TagSuggestion {
  name: string;
  score: number;
  reason: string;
  existing: boolean;
}

export interface Insight {
  topTags: Array<{ id: number; name: string; color: string; count: number }>;
  risingTags: Array<{ id: number; name: string; color: string; current: number; previous: number; delta: number }>;
  fallingTags: Array<{ id: number; name: string; color: string; current: number; previous: number; delta: number }>;
  cooccurrence: Array<{ tagA: string; tagB: string; count: number }>;
  suggestions: string[];
}

export interface DraftLog {
  title: string;
  content: string;
  tagNames: string[];
}
