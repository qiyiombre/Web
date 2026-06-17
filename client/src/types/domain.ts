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

export type LayoutMode = 'semantic' | 'domain';

export type InsightTimeFilter = 'week' | 'month' | 'quarter' | 'custom';

export interface InsightRangePayload {
  timeFilter: InsightTimeFilter;
  customStartDate?: string;
  customEndDate?: string;
}

export interface UserPreferences {
  rendererMode: 'canvas' | 'webgpu';
  layoutMode: LayoutMode;
  timeFilter: 'all' | 'week' | 'month' | 'quarter' | 'custom';
  frequencyFilter: 'all' | 'high' | 'low';
  highFrequencyMinimum: number;
  lowFrequencyMaximum: number;
  insightTopLimit: number;
  insightTrendLimit: number;
  insightCooccurrenceLimit: number;
  nebulaPriorityDisplayLimit: number;
  nebulaHeatWindowDays: number;
  nebulaHeatMinimumDelta: number;
  nebulaHeatMediumDelta: number;
  nebulaHeatStrongDelta: number;
  nebulaHeatFlatOpacity: number;
  sortMode: 'layout' | 'frequency' | 'lowFrequency' | 'recent';
  customStartDate: string;
  customEndDate: string;
}

export type AssistantAction =
  | 'none'
  | 'create_log'
  | 'search_logs'
  | 'open_map'
  | 'open_logs'
  | 'open_insights'
  | 'open_settings'
  | 'open_home'
  | 'show_stats'
  | 'summarize_map';

export interface AssistantStats {
  mapName: string;
  logCount: number;
  tagCount: number;
  topTags: Array<{ name: string; count: number }>;
  recentLogTitles: string[];
}

export interface AssistantIntent {
  reply: string;
  action: AssistantAction;
  confidence: number;
  requiresConfirmation: boolean;
  payload: {
    mapId?: number | null;
    title?: string;
    content?: string;
    tagNames?: string[];
    query?: string;
    stats?: AssistantStats;
  };
}

export interface TagGroup {
  id: string;
  name: string;
  color: string;
  tagIds: number[];
  source: 'deepseek' | 'local';
  reason?: string;
}

export interface DomainCategory {
  id: number;
  mapId: number;
  name: string;
  color: string;
  keywords: string[];
  sortOrder: number;
}

export type AiSource = 'deepseek' | 'local' | 'cache' | 'none';

export interface AiMeta {
  feature: 'tagRelations' | 'tagGroups' | 'tagSuggestions' | 'tagSearch' | 'advice';
  source: AiSource;
  attempted: boolean;
  message: string;
}

export interface GraphData {
  map: NebulaMap;
  tags: TagNode[];
  logs: LogEntry[];
  edges: GraphEdge[];
  tagSimilarities: TagSimilarity[];
  tagGroups: TagGroup[];
  domainCategories: DomainCategory[];
  aiMeta?: {
    tagRelations?: AiMeta;
    tagGroups?: AiMeta;
  };
}

export interface TagSuggestion {
  name: string;
  score: number;
  reason: string;
  existing: boolean;
  source?: 'deepseek' | 'local';
}

export interface TagSuggestionResponse {
  suggestions: TagSuggestion[];
  aiMeta: AiMeta;
}

export interface TagSearchMatch {
  id: number;
  name: string;
  color: string;
  count: number;
  score: number;
  reason: string;
  source?: 'deepseek' | 'local' | 'cache';
}

export interface TagSearchResponse {
  matches: TagSearchMatch[];
  aiMeta: AiMeta;
}

export interface Insight {
  topTags: Array<{ id: number; name: string; color: string; count: number }>;
  risingTags: Array<{ id: number; name: string; color: string; current: number; previous: number; delta: number }>;
  fallingTags: Array<{ id: number; name: string; color: string; current: number; previous: number; delta: number }>;
  cooccurrence: Array<{ tagA: string; tagB: string; count: number }>;
  suggestions: string[];
  adviceMeta?: AiMeta;
  range?: InsightRangePayload;
}

export interface AdviceResponse {
  cached: boolean;
  suggestions: string[];
  aiMeta: AiMeta;
  range?: InsightRangePayload;
}

export interface DraftLog {
  title: string;
  content: string;
  tagNames: string[];
}
