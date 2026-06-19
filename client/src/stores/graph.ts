import { ref, computed, watch } from 'vue';
import { defineStore } from 'pinia';
import { useMapsStore } from './maps';
import { useUiStore } from './ui';
import { deleteTag } from '../services/api';
import type { GraphData, LogEntry, TagNode, DomainCategory } from '../types/domain';

type TimeFilterMode = 'all' | 'week' | 'month' | 'quarter' | 'custom';
type FrequencyFilterMode = 'all' | 'high' | 'low';
type NebulaSortMode = 'layout' | 'frequency' | 'lowFrequency' | 'recent';
type NebulaLogDensityMode = 'auto' | 'single';

const RELATED_TAG_PAGE_SIZE = 12;
const DEFAULT_HIGH_FREQUENCY_MINIMUM = 2;
const DEFAULT_LOW_FREQUENCY_MAXIMUM = 1;
const DEFAULT_INSIGHT_TOP_LIMIT = 8;
const DEFAULT_INSIGHT_TREND_LIMIT = 5;
const DEFAULT_INSIGHT_COOCCURRENCE_LIMIT = 8;
const DEFAULT_NEBULA_PRIORITY_DISPLAY_LIMIT = 8;
const DEFAULT_NEBULA_HEAT_WINDOW_DAYS = 7;
const DEFAULT_NEBULA_HEAT_MINIMUM_DELTA = 1;
const DEFAULT_NEBULA_HEAT_MEDIUM_DELTA = 2;
const DEFAULT_NEBULA_HEAT_STRONG_DELTA = 4;
const DEFAULT_NEBULA_HEAT_FLAT_OPACITY = 28;

function readPositiveInteger(key: string, fallback: number, min: number, max = 99): number {
  const raw = Number(localStorage.getItem(key));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function isTimeFilterActive(filter: TimeFilterMode, startDate = '', endDate = ''): boolean {
  return filter !== 'all' && (filter !== 'custom' || Boolean(startDate || endDate));
}

function dateBoundary(value: string, endOfDay = false): number | null {
  if (!value) return null;
  const time = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime();
  return Number.isNaN(time) ? null : time;
}

function matchesTimeFilter(log: LogEntry, filter: TimeFilterMode, startDate = '', endDate = ''): boolean {
  if (filter === 'all') return true;
  const now = Date.now();
  const logTime = new Date(log.createdAt).getTime();
  if (Number.isNaN(logTime)) return true;
  if (filter === 'custom') {
    const start = dateBoundary(startDate);
    const end = dateBoundary(endDate, true);
    if (start === null && end === null) return true;
    if (start !== null && logTime < start) return false;
    if (end !== null && logTime > end) return false;
    return true;
  }
  const ms = {
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    quarter: 90 * 24 * 60 * 60 * 1000
  };
  return now - logTime <= ms[filter];
}

function buildTagUsageStats(logs: LogEntry[]) {
  const usage = new Map<number, { count: number; lastUsed: number }>();
  for (const log of logs) {
    const t = new Date(log.createdAt).getTime();
    const countedTagIds = new Set<number>();
    for (const tag of log.tags) {
      if (countedTagIds.has(tag.id)) continue;
      countedTagIds.add(tag.id);
      const s = usage.get(tag.id) ?? { count: 0, lastUsed: t };
      s.count++;
      if (t > s.lastUsed) s.lastUsed = t;
      usage.set(tag.id, s);
    }
  }
  return usage;
}

function buildFrequencyThresholds(highMinimum: number, lowMaximum: number) {
  return {
    high: Math.max(2, Math.round(highMinimum)),
    low: Math.max(1, Math.round(lowMaximum))
  };
}

function matchesFrequencyFilter(count: number, thresholds: { high: number; low: number }, mode: FrequencyFilterMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'high') return count >= thresholds.high;
  return count > 0 && count <= thresholds.low;
}

function resolveDomainCategoryTagIds(category: DomainCategory, graph: GraphData | null) {
  if (!graph) return [];
  const cleanName = String(category.name ?? '').trim().toLowerCase();
  const matchingGroup = graph.tagGroups.find((group) => group.name.trim().toLowerCase() === cleanName);
  if (matchingGroup?.tagIds.length) {
    const visibleIds = new Set(graph.tags.map((tag) => tag.id));
    return matchingGroup.tagIds.filter((id) => visibleIds.has(id));
  }
  const keywords = [category.name, ...(category.keywords ?? [])]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (keywords.length === 0) return [];
  return graph.tags
    .filter((tag) => {
      const name = tag.name.trim().toLowerCase();
      return keywords.some((keyword) => name.includes(keyword) || keyword.includes(name));
    })
    .map((tag) => tag.id);
}

function sortTagsForPriority(tags: TagNode[], logs: LogEntry[], mode: NebulaSortMode): TagNode[] {
  const stats = buildTagUsageStats(logs);
  const list = [...tags].map(t => ({ tag: t, stats: stats.get(t.id) }));
  switch (mode) {
    case 'frequency':
      return list.sort((a, b) => (b.stats?.count ?? 0) - (a.stats?.count ?? 0)).map(i => i.tag);
    case 'lowFrequency':
      return list.sort((a, b) => (a.stats?.count ?? 0) - (b.stats?.count ?? 0)).map(i => i.tag);
    case 'recent':
      return list.sort((a, b) => (b.stats?.lastUsed ?? 0) - (a.stats?.lastUsed ?? 0)).map(i => i.tag);
    default:
      return [];
  }
}

export const useGraphStore = defineStore('graph', () => {
  const activeTagIds = ref<Set<number>>(new Set());
  const selectedLogId = ref<number | null>(null);
  const timeFilter = ref<TimeFilterMode>('all');
  const frequencyFilter = ref<FrequencyFilterMode>('all');
  const highFrequencyMinimum = ref(readPositiveInteger('nebula.highFrequencyMinimum', DEFAULT_HIGH_FREQUENCY_MINIMUM, 2));
  const lowFrequencyMaximum = ref(readPositiveInteger('nebula.lowFrequencyMaximum', DEFAULT_LOW_FREQUENCY_MAXIMUM, 1));
  const insightTopLimit = ref(readPositiveInteger('nebula.insightTopLimit', DEFAULT_INSIGHT_TOP_LIMIT, 3, 20));
  const insightTrendLimit = ref(readPositiveInteger('nebula.insightTrendLimit', DEFAULT_INSIGHT_TREND_LIMIT, 3, 20));
  const insightCooccurrenceLimit = ref(readPositiveInteger('nebula.insightCooccurrenceLimit', DEFAULT_INSIGHT_COOCCURRENCE_LIMIT, 3, 20));
  const nebulaPriorityDisplayLimit = ref(readPositiveInteger('nebula.priorityDisplayLimit', DEFAULT_NEBULA_PRIORITY_DISPLAY_LIMIT, 0, 30));
  const nebulaHeatWindowDays = ref(readPositiveInteger('nebula.heatWindowDays', DEFAULT_NEBULA_HEAT_WINDOW_DAYS, 1, 90));
  const nebulaHeatMinimumDelta = ref(readPositiveInteger('nebula.heatMinimumDelta', DEFAULT_NEBULA_HEAT_MINIMUM_DELTA, 1, 99));
  const nebulaHeatMediumDelta = ref(readPositiveInteger('nebula.heatMediumDelta', DEFAULT_NEBULA_HEAT_MEDIUM_DELTA, 1, 99));
  const nebulaHeatStrongDelta = ref(readPositiveInteger('nebula.heatStrongDelta', DEFAULT_NEBULA_HEAT_STRONG_DELTA, 1, 99));
  const nebulaHeatFlatOpacity = ref(readPositiveInteger('nebula.heatFlatOpacity', DEFAULT_NEBULA_HEAT_FLAT_OPACITY, 5, 80));
  const nebulaLogDensityMode = ref<NebulaLogDensityMode>(localStorage.getItem('nebula.logDensityMode') === 'single' ? 'single' : 'auto');
  const sortMode = ref<NebulaSortMode>('layout');
  const customStartDate = ref('');
  const customEndDate = ref('');
  const relatedPage = ref(0);
  const nebulaLogCard = ref<{ logId: number; x: number; y: number; width?: number; height?: number } | null>(null);
  const domainFocusTagIds = ref<Set<number>>(new Set());
  let domainFocusTimer: number | null = null;

  function initFromLocalStorage() {
    const savedTimeFilter = localStorage.getItem('nebula.timeFilter');
    const savedFrequencyFilter = localStorage.getItem('nebula.frequencyFilter');
    const savedSortMode = localStorage.getItem('nebula.sortMode');
    if (savedTimeFilter === 'week' || savedTimeFilter === 'month' || savedTimeFilter === 'quarter' || savedTimeFilter === 'custom') {
      timeFilter.value = savedTimeFilter;
    }
    if (savedFrequencyFilter === 'high' || savedFrequencyFilter === 'low') {
      frequencyFilter.value = savedFrequencyFilter;
    }
    highFrequencyMinimum.value = readPositiveInteger(
      'nebula.highFrequencyMinimum',
      DEFAULT_HIGH_FREQUENCY_MINIMUM,
      2
    );
    lowFrequencyMaximum.value = Math.min(
      readPositiveInteger('nebula.lowFrequencyMaximum', DEFAULT_LOW_FREQUENCY_MAXIMUM, 1),
      Math.max(1, highFrequencyMinimum.value - 1)
    );
    insightTopLimit.value = readPositiveInteger('nebula.insightTopLimit', DEFAULT_INSIGHT_TOP_LIMIT, 3, 20);
    insightTrendLimit.value = readPositiveInteger('nebula.insightTrendLimit', DEFAULT_INSIGHT_TREND_LIMIT, 3, 20);
    insightCooccurrenceLimit.value = readPositiveInteger('nebula.insightCooccurrenceLimit', DEFAULT_INSIGHT_COOCCURRENCE_LIMIT, 3, 20);
    nebulaPriorityDisplayLimit.value = readPositiveInteger('nebula.priorityDisplayLimit', DEFAULT_NEBULA_PRIORITY_DISPLAY_LIMIT, 0, 30);
    nebulaHeatWindowDays.value = readPositiveInteger('nebula.heatWindowDays', DEFAULT_NEBULA_HEAT_WINDOW_DAYS, 1, 90);
    nebulaHeatMinimumDelta.value = readPositiveInteger('nebula.heatMinimumDelta', DEFAULT_NEBULA_HEAT_MINIMUM_DELTA, 1, 99);
    nebulaHeatMediumDelta.value = Math.max(
      nebulaHeatMinimumDelta.value,
      readPositiveInteger('nebula.heatMediumDelta', DEFAULT_NEBULA_HEAT_MEDIUM_DELTA, 1, 99)
    );
    nebulaHeatStrongDelta.value = Math.max(
      nebulaHeatMediumDelta.value,
      readPositiveInteger('nebula.heatStrongDelta', DEFAULT_NEBULA_HEAT_STRONG_DELTA, 1, 99)
    );
    nebulaHeatFlatOpacity.value = readPositiveInteger('nebula.heatFlatOpacity', DEFAULT_NEBULA_HEAT_FLAT_OPACITY, 5, 80);
    nebulaLogDensityMode.value = localStorage.getItem('nebula.logDensityMode') === 'single' ? 'single' : 'auto';
    if (savedSortMode === 'frequency' || savedSortMode === 'lowFrequency' || savedSortMode === 'recent') {
      sortMode.value = savedSortMode;
    }
    customStartDate.value = localStorage.getItem('nebula.customStartDate') ?? '';
    customEndDate.value = localStorage.getItem('nebula.customEndDate') ?? '';
  }

  function persistToLocalStorage() {
    localStorage.setItem('nebula.timeFilter', timeFilter.value);
    localStorage.setItem('nebula.frequencyFilter', frequencyFilter.value);
    localStorage.setItem('nebula.highFrequencyMinimum', String(highFrequencyMinimum.value));
    localStorage.setItem('nebula.lowFrequencyMaximum', String(lowFrequencyMaximum.value));
    localStorage.setItem('nebula.insightTopLimit', String(insightTopLimit.value));
    localStorage.setItem('nebula.insightTrendLimit', String(insightTrendLimit.value));
    localStorage.setItem('nebula.insightCooccurrenceLimit', String(insightCooccurrenceLimit.value));
    localStorage.setItem('nebula.priorityDisplayLimit', String(nebulaPriorityDisplayLimit.value));
    localStorage.setItem('nebula.heatWindowDays', String(nebulaHeatWindowDays.value));
    localStorage.setItem('nebula.heatMinimumDelta', String(nebulaHeatMinimumDelta.value));
    localStorage.setItem('nebula.heatMediumDelta', String(nebulaHeatMediumDelta.value));
    localStorage.setItem('nebula.heatStrongDelta', String(nebulaHeatStrongDelta.value));
    localStorage.setItem('nebula.heatFlatOpacity', String(nebulaHeatFlatOpacity.value));
    localStorage.setItem('nebula.logDensityMode', nebulaLogDensityMode.value);
    localStorage.setItem('nebula.sortMode', sortMode.value);
    localStorage.setItem('nebula.customStartDate', customStartDate.value);
    localStorage.setItem('nebula.customEndDate', customEndDate.value);
  }

  function setTimeFilter(filter: TimeFilterMode) {
    timeFilter.value = filter;
    persistToLocalStorage();
  }

  function setFrequencyFilter(filter: FrequencyFilterMode) {
    frequencyFilter.value = filter;
    persistToLocalStorage();
  }

  function setHighFrequencyMinimum(value: number) {
    highFrequencyMinimum.value = Math.min(99, Math.max(2, Math.round(Number(value) || DEFAULT_HIGH_FREQUENCY_MINIMUM)));
    if (lowFrequencyMaximum.value >= highFrequencyMinimum.value) {
      lowFrequencyMaximum.value = Math.max(1, highFrequencyMinimum.value - 1);
    }
    persistToLocalStorage();
  }

  function setLowFrequencyMaximum(value: number) {
    lowFrequencyMaximum.value = Math.min(
      Math.max(1, highFrequencyMinimum.value - 1),
      Math.max(1, Math.round(Number(value) || DEFAULT_LOW_FREQUENCY_MAXIMUM))
    );
    persistToLocalStorage();
  }

  function setInsightTopLimit(value: number) {
    insightTopLimit.value = Math.min(20, Math.max(3, Math.round(Number(value) || DEFAULT_INSIGHT_TOP_LIMIT)));
    persistToLocalStorage();
  }

  function setInsightTrendLimit(value: number) {
    insightTrendLimit.value = Math.min(20, Math.max(3, Math.round(Number(value) || DEFAULT_INSIGHT_TREND_LIMIT)));
    persistToLocalStorage();
  }

  function setInsightCooccurrenceLimit(value: number) {
    insightCooccurrenceLimit.value = Math.min(20, Math.max(3, Math.round(Number(value) || DEFAULT_INSIGHT_COOCCURRENCE_LIMIT)));
    persistToLocalStorage();
  }

  function setNebulaPriorityDisplayLimit(value: number) {
    const parsed = Math.round(Number(value));
    nebulaPriorityDisplayLimit.value = Number.isFinite(parsed)
      ? Math.min(30, Math.max(0, parsed))
      : DEFAULT_NEBULA_PRIORITY_DISPLAY_LIMIT;
    persistToLocalStorage();
  }

  function setNebulaHeatWindowDays(value: number) {
    const parsed = Math.round(Number(value));
    nebulaHeatWindowDays.value = Number.isFinite(parsed)
      ? Math.min(90, Math.max(1, parsed))
      : DEFAULT_NEBULA_HEAT_WINDOW_DAYS;
    persistToLocalStorage();
  }

  function setNebulaHeatMinimumDelta(value: number) {
    const parsed = Math.round(Number(value));
    nebulaHeatMinimumDelta.value = Number.isFinite(parsed)
      ? Math.min(99, Math.max(1, parsed))
      : DEFAULT_NEBULA_HEAT_MINIMUM_DELTA;
    if (nebulaHeatMediumDelta.value < nebulaHeatMinimumDelta.value) {
      nebulaHeatMediumDelta.value = nebulaHeatMinimumDelta.value;
    }
    if (nebulaHeatStrongDelta.value < nebulaHeatMediumDelta.value) {
      nebulaHeatStrongDelta.value = nebulaHeatMediumDelta.value;
    }
    persistToLocalStorage();
  }

  function setNebulaHeatMediumDelta(value: number) {
    const parsed = Math.round(Number(value));
    nebulaHeatMediumDelta.value = Number.isFinite(parsed)
      ? Math.min(99, Math.max(nebulaHeatMinimumDelta.value, parsed))
      : DEFAULT_NEBULA_HEAT_MEDIUM_DELTA;
    if (nebulaHeatStrongDelta.value < nebulaHeatMediumDelta.value) {
      nebulaHeatStrongDelta.value = nebulaHeatMediumDelta.value;
    }
    persistToLocalStorage();
  }

  function setNebulaHeatStrongDelta(value: number) {
    const parsed = Math.round(Number(value));
    nebulaHeatStrongDelta.value = Number.isFinite(parsed)
      ? Math.min(99, Math.max(nebulaHeatMediumDelta.value, parsed))
      : DEFAULT_NEBULA_HEAT_STRONG_DELTA;
    persistToLocalStorage();
  }

  function setNebulaHeatFlatOpacity(value: number) {
    const parsed = Math.round(Number(value));
    nebulaHeatFlatOpacity.value = Number.isFinite(parsed)
      ? Math.min(80, Math.max(5, parsed))
      : DEFAULT_NEBULA_HEAT_FLAT_OPACITY;
    persistToLocalStorage();
  }

  function setNebulaLogDensityMode(mode: NebulaLogDensityMode) {
    nebulaLogDensityMode.value = mode === 'single' ? 'single' : 'auto';
    persistToLocalStorage();
  }

  function setSortMode(mode: NebulaSortMode) {
    sortMode.value = mode;
    persistToLocalStorage();
  }

  function toggleTag(tagId: number) {
    const next = new Set(activeTagIds.value);
    if (next.has(tagId)) {
      next.delete(tagId);
    } else {
      next.add(tagId);
    }
    activeTagIds.value = next;
  }

  function clearActiveTags() {
    activeTagIds.value = new Set();
  }

  function focusTag(tagId: number) {
    activeTagIds.value = new Set([tagId]);
  }

  function focusDomainCategory(category: DomainCategory) {
    const mapsStore = useMapsStore();
    const matchIds = resolveDomainCategoryTagIds(category, filteredGraph.value ?? mapsStore.graph);
    domainFocusTagIds.value = new Set(matchIds);
    if (domainFocusTimer !== null) {
      window.clearTimeout(domainFocusTimer);
    }
    domainFocusTimer = window.setTimeout(() => {
      domainFocusTagIds.value = new Set();
      domainFocusTimer = null;
    }, 2200);
  }

  // --- Computed filtered graph ---
  const filteredGraph = computed<GraphData | null>(() => {
    const mapsStore = useMapsStore();
    const g = mapsStore.graph;
    if (!g) return null;

    const timeLogs = g.logs.filter(log =>
      matchesTimeFilter(log, timeFilter.value, customStartDate.value, customEndDate.value)
    );
    const tagUsage = buildTagUsageStats(timeLogs);
    const thresholds = buildFrequencyThresholds(highFrequencyMinimum.value, lowFrequencyMaximum.value);
    const tagFilterActive =
      isTimeFilterActive(timeFilter.value, customStartDate.value, customEndDate.value) ||
      frequencyFilter.value !== 'all';

    const tags = g.tags
      .map(tag => ({ ...tag, count: tagUsage.get(tag.id)?.count ?? 0 }))
      .filter(tag => (!tagFilterActive || tag.count > 0) && matchesFrequencyFilter(tag.count, thresholds, frequencyFilter.value));

    const visibleTagIds = new Set(tags.map(t => t.id));
    const logs = tagFilterActive
      ? timeLogs.filter(log => log.tags.some(tag => visibleTagIds.has(tag.id)))
      : timeLogs;
    const visibleLogIds = new Set(logs.map(l => l.id));

    return {
      ...g,
      tags,
      logs,
      edges: g.edges.filter(e => visibleLogIds.has(e.logId) && visibleTagIds.has(e.tagId)),
      tagSimilarities: g.tagSimilarities.filter(
        s => visibleTagIds.has(s.tagAId) && visibleTagIds.has(s.tagBId)
      ),
      tagGroups: g.tagGroups
        .map(grp => ({ ...grp, tagIds: grp.tagIds.filter(tid => visibleTagIds.has(tid)) }))
        .filter(grp => grp.tagIds.length > 0)
    };
  });

  const filteredLogs = computed(() => {
    if (!filteredGraph.value) return [];
    const active = [...activeTagIds.value];
    if (active.length === 0) return filteredGraph.value.logs;
    return filteredGraph.value.logs.filter(log => active.every(tid => log.tags.some(t => t.id === tid)));
  });

  const activeTags = computed(() => {
    if (!filteredGraph.value) return [];
    return filteredGraph.value.tags.filter(t => activeTagIds.value.has(t.id));
  });

  const priorityTagIds = computed(() => {
    if (sortMode.value === 'layout' || !filteredGraph.value) return [];
    return sortTagsForPriority(filteredGraph.value.tags, filteredGraph.value.logs, sortMode.value).map(t => t.id);
  });

  const relatedTagItems = computed(() => {
    if (!filteredGraph.value || activeTagIds.value.size === 0) return [];
    const score = new Map<number, number>();
    for (const log of filteredLogs.value) {
      for (const tag of log.tags) {
        if (!activeTagIds.value.has(tag.id)) {
          score.set(tag.id, (score.get(tag.id) ?? 0) + 1);
        }
      }
    }
    return [...score.entries()]
      .map(([id, count]) => ({ tag: filteredGraph.value!.tags.find(t => t.id === id)!, count }))
      .filter(item => Boolean(item.tag))
      .sort((a, b) => b.count - a.count);
  });

  const relatedCanPaginate = computed(() => relatedTagItems.value.length > RELATED_TAG_PAGE_SIZE);
  const relatedTotalPages = computed(() =>
    Math.max(1, Math.ceil(relatedTagItems.value.length / RELATED_TAG_PAGE_SIZE))
  );
  const relatedTags = computed(() => {
    if (!relatedCanPaginate.value) return relatedTagItems.value;
    const start = relatedPage.value * RELATED_TAG_PAGE_SIZE;
    return relatedTagItems.value.slice(start, start + RELATED_TAG_PAGE_SIZE);
  });
  const relatedPageLabel = computed(() =>
    `${Math.min(relatedPage.value + 1, relatedTotalPages.value)} / ${relatedTotalPages.value}`
  );

  // Stats
  const stats = computed(() => {
    if (!filteredGraph.value) return { tags: 0, logs: 0, filtered: 0 };
    const filterActive =
      activeTagIds.value.size > 0 ||
      isTimeFilterActive(timeFilter.value, customStartDate.value, customEndDate.value) ||
      frequencyFilter.value !== 'all';
    return {
      tags: filteredGraph.value.tags.length,
      logs: filteredGraph.value.logs.length,
      filtered: filterActive ? filteredLogs.value.length : 0
    };
  });

  // Canvas overlay card: resolve log from nebulaLogCard.logId
  const nebulaCardLog = computed(() => {
    const mapsStore = useMapsStore();
    if (!mapsStore.graph || !nebulaLogCard.value) return null;
    const log = mapsStore.graph.logs.find(l => l.id === nebulaLogCard.value!.logId);
    return log ? { log, x: nebulaLogCard.value.x, y: nebulaLogCard.value.y } : null;
  });

  // Canvas tag menu: resolve tag from ui.nebulaTagMenu.tagId
  const nebulaTagMenuTag = computed(() => {
    const uiStore = useUiStore();
    const mapsStore = useMapsStore();
    if (!mapsStore.graph || !uiStore.nebulaTagMenu) return null;
    return mapsStore.graph.tags.find(t => t.id === uiStore.nebulaTagMenu!.tagId) ?? null;
  });

  // Request delete tag (with confirm dialog)
  function requestDeleteTag(tag: TagNode) {
    const uiStore = useUiStore();
    const mapsStore = useMapsStore();
    const logIds = mapsStore.graph?.logs
      .filter(log => log.tags.some(t => t.id === tag.id))
      .map(log => log.id) ?? [];
    uiStore.showConfirm(
      '删除标签',
      `确认删除「${tag.name}」吗？删除后可以用撤销恢复。`,
      '删除',
      async () => {
        if (!mapsStore.activeMapId) return;
        const snapshot: TagNode = { ...tag };
        await deleteTag(tag.id);
        uiStore.pushDeleteHistory({ kind: 'tag', tag: snapshot, mapId: mapsStore.activeMapId, logIds });
        activeTagIds.value = new Set([...activeTagIds.value].filter(id => id !== tag.id));
        uiStore.closeTagMenu();
        await mapsStore.refreshData();
        uiStore.showNotice('标签已删除，可撤销');
      }
    );
  }

  // Auto-reset related page when active tags change
  watch(activeTagIds, () => {
    relatedPage.value = 0;
  });

  watch(relatedTotalPages, (pages) => {
    if (relatedPage.value >= pages) {
      relatedPage.value = Math.max(0, pages - 1);
    }
  });

  return {
    activeTagIds,
    selectedLogId,
    timeFilter,
    frequencyFilter,
    highFrequencyMinimum,
    lowFrequencyMaximum,
    insightTopLimit,
    insightTrendLimit,
    insightCooccurrenceLimit,
    nebulaPriorityDisplayLimit,
    nebulaHeatWindowDays,
    nebulaHeatMinimumDelta,
    nebulaHeatMediumDelta,
    nebulaHeatStrongDelta,
    nebulaHeatFlatOpacity,
    nebulaLogDensityMode,
    sortMode,
    customStartDate,
    customEndDate,
    relatedPage,
    nebulaLogCard,
    domainFocusTagIds,
    filteredGraph,
    filteredLogs,
    activeTags,
    priorityTagIds,
    relatedTagItems,
    relatedCanPaginate,
    relatedTotalPages,
    relatedTags,
    relatedPageLabel,
    stats,
    nebulaCardLog,
    nebulaTagMenuTag,
    initFromLocalStorage,
    persistToLocalStorage,
    setTimeFilter,
    setFrequencyFilter,
    setHighFrequencyMinimum,
    setLowFrequencyMaximum,
    setInsightTopLimit,
    setInsightTrendLimit,
    setInsightCooccurrenceLimit,
    setNebulaPriorityDisplayLimit,
    setNebulaHeatWindowDays,
    setNebulaHeatMinimumDelta,
    setNebulaHeatMediumDelta,
    setNebulaHeatStrongDelta,
    setNebulaHeatFlatOpacity,
    setNebulaLogDensityMode,
    setSortMode,
    toggleTag,
    clearActiveTags,
    focusTag,
    focusDomainCategory,
    requestDeleteTag
  };
});
