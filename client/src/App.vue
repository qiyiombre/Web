<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ChevronLeft,
  ChevronRight,
  Check,
  Cpu,
  Download,
  Edit3,
  FilePlus2,
  Layers,
  Link2,
  List,
  LogOut,
  Map as MapIcon,
  Orbit,
  PenLine,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Tags,
  Trash2,
  Undo2,
  UserRound,
  X
} from 'lucide-vue-next';
import AuthPanel from './components/AuthPanel.vue';
import DomainCategoryManager from './components/DomainCategoryManager.vue';
import InsightPanel from './components/InsightPanel.vue';
import LogEditor from './components/LogEditor.vue';
import NebulaCanvas from './components/NebulaCanvas.vue';
import TagManager from './components/TagManager.vue';
import WebGpuNebulaCanvas from './components/WebGpuNebulaCanvas.vue';
import {
  clearDraft,
  createLog,
  createMap,
  deleteMap,
  deleteTag,
  deleteLog,
  generateAdvice,
  getCurrentUser,
  getGraph,
  getInsights,
  listMaps,
  loadDraft,
  logout,
  restoreLog,
  restoreTag,
  saveDraft,
  updateLog,
  updateMap,
  updateTag
} from './services/api';
import type {
  AdviceResponse,
  AiMeta,
  DomainCategory,
  DraftLog,
  GraphData,
  Insight,
  LayoutMode,
  LogEntry,
  NebulaMap,
  TagNode,
  UserAccount
} from './types/domain';

type NebulaLogCard = {
  logId: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
};

type NebulaRenderer = {
  focusTag: (tagId: number) => void;
  focusLog: (logId: number) => NebulaLogCard | null;
  focusDomainCategory: (category: DomainCategory) => boolean;
  fitAllTags: () => boolean;
  resetTagLayout: () => void;
  refreshLayout: () => void;
  saveLayout: () => boolean;
  undoLayout: () => boolean;
  redoLayout: () => boolean;
};

type RightPanel = 'logs' | 'editor' | 'insight';
type LeftPanel = 'maps' | 'active' | 'related' | 'manage' | 'domains';
type TimeFilterMode = 'all' | 'week' | 'month' | 'quarter' | 'custom';
type FrequencyFilterMode = 'all' | 'high' | 'low';
type NebulaSortMode = 'layout' | 'frequency' | 'lowFrequency' | 'recent';
type NebulaConfirm = {
  title: string;
  message: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => Promise<void>;
};
type NebulaTagMenu = {
  tagId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  mode: 'menu' | 'edit';
};
type DeletedLogAction = { kind: 'log'; log: LogEntry };
type DeletedTagAction = { kind: 'tag'; tag: TagNode; mapId: number; logIds: number[] };
type DeleteHistoryAction = DeletedLogAction | DeletedTagAction;

const RELATED_TAG_PAGE_SIZE = 5;

const maps = ref<NebulaMap[]>([]);
const activeMapId = ref<number | null>(null);
const graph = ref<GraphData | null>(null);
const insights = ref<Insight | null>(null);
const activeTagIds = ref<Set<number>>(new Set());
const selectedLogId = ref<number | null>(null);
const nebulaLogCard = ref<NebulaLogCard | null>(null);
const editorMode = ref<'new' | 'edit' | null>('new');
const editingLog = ref<LogEntry | null>(null);
const draft = ref<DraftLog | undefined>();
const currentUser = ref<UserAccount | null>(null);
const checkingAuth = ref(true);
const loading = ref(false);
const adviceLoading = ref(false);
const error = ref('');
const notice = ref('');
const isOnline = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
const draftSavedAt = ref('');
const draftRestored = ref(false);
const rendererMode = ref<'canvas' | 'webgpu'>(localStorage.getItem('nebula.rendererMode') === 'webgpu' ? 'webgpu' : 'canvas');
const layoutMode = ref<LayoutMode>(localStorage.getItem('nebula.layoutMode') === 'domain' ? 'domain' : 'semantic');
const savedTimeFilter = localStorage.getItem('nebula.timeFilter');
const savedFrequencyFilter = localStorage.getItem('nebula.frequencyFilter');
const savedSortMode = localStorage.getItem('nebula.sortMode');
const timeFilter = ref<TimeFilterMode>(
  savedTimeFilter === 'week' || savedTimeFilter === 'month' || savedTimeFilter === 'quarter' || savedTimeFilter === 'custom'
    ? savedTimeFilter
    : 'all'
);
const frequencyFilter = ref<FrequencyFilterMode>(
  savedFrequencyFilter === 'high' || savedFrequencyFilter === 'low' ? savedFrequencyFilter : 'all'
);
const sortMode = ref<NebulaSortMode>(
  savedSortMode === 'frequency' || savedSortMode === 'lowFrequency' || savedSortMode === 'recent' ? savedSortMode : 'layout'
);
const customStartDate = ref(localStorage.getItem('nebula.customStartDate') ?? '');
const customEndDate = ref(localStorage.getItem('nebula.customEndDate') ?? '');
const nebulaRenderKey = ref(0);
const canvasRef = ref<NebulaRenderer | null>(null);
const tagManagerRef = ref<InstanceType<typeof TagManager> | null>(null);
const rightPanel = ref<RightPanel | null>(null);
const leftPanel = ref<LeftPanel | null>(null);
const layoutDirty = ref(false);
const renamingMapId = ref<number | null>(null);
const renameLocation = ref<'list' | 'title'>('title');
const renameDraft = ref('');
const renameSaving = ref(false);
const nebulaConfirm = ref<NebulaConfirm | null>(null);
const nebulaTagMenu = ref<NebulaTagMenu | null>(null);
const tagEditName = ref('');
const tagEditColor = ref('#62d6ff');
const tagEditSaving = ref(false);
const deleteUndoStack = ref<DeleteHistoryAction[]>([]);
const deleteRedoStack = ref<DeleteHistoryAction[]>([]);
const relatedPage = ref(0);

const visibleGraph = computed<GraphData | null>(() => {
  if (!graph.value) {
    return null;
  }
  const timeLogs = graph.value.logs.filter((log) => matchesTimeFilter(log, timeFilter.value));
  const tagUsage = buildTagUsageStats(timeLogs);
  const thresholds = buildFrequencyThresholds(tagUsage);
  const tagFilterActive = timeFilter.value !== 'all' || frequencyFilter.value !== 'all';
  const tags = graph.value.tags
    .map((tag) => ({ ...tag, count: tagUsage.get(tag.id)?.count ?? 0 }))
    .filter((tag) => (!tagFilterActive || tag.count > 0) && matchesFrequencyFilter(tag.count, thresholds));
  const visibleTagIds = new Set(tags.map((tag) => tag.id));
  const logs = tagFilterActive
    ? timeLogs.filter((log) => log.tags.some((tag) => visibleTagIds.has(tag.id)))
    : timeLogs;
  const visibleLogIds = new Set(logs.map((log) => log.id));
  return {
    ...graph.value,
    tags,
    logs,
    edges: graph.value.edges.filter((edge) => visibleLogIds.has(edge.logId) && visibleTagIds.has(edge.tagId)),
    tagSimilarities: graph.value.tagSimilarities.filter(
      (item) => visibleTagIds.has(item.tagAId) && visibleTagIds.has(item.tagBId)
    ),
    tagGroups: graph.value.tagGroups
      .map((group) => ({ ...group, tagIds: group.tagIds.filter((tagId) => visibleTagIds.has(tagId)) }))
      .filter((group) => group.tagIds.length > 0)
  };
});

const priorityTagIds = computed(() => {
  if (sortMode.value === 'layout' || !visibleGraph.value) {
    return [];
  }
  return sortTagsForPriority(visibleGraph.value.tags, visibleGraph.value.logs, sortMode.value).map((tag) => tag.id);
});

const nebulaCardLog = computed(() => {
  if (!visibleGraph.value || !nebulaLogCard.value) {
    return null;
  }
  const log = visibleGraph.value.logs.find((item) => item.id === nebulaLogCard.value?.logId);
  return log ? { log, x: nebulaLogCard.value.x, y: nebulaLogCard.value.y } : null;
});

const filteredLogs = computed(() => {
  if (!visibleGraph.value) {
    return [];
  }
  const active = [...activeTagIds.value];
  if (active.length === 0) {
    return visibleGraph.value.logs;
  }
  return visibleGraph.value.logs.filter((log) => active.every((tagId) => log.tags.some((tag) => tag.id === tagId)));
});

const activeTags = computed(() => {
  if (!visibleGraph.value) {
    return [];
  }
  return visibleGraph.value.tags.filter((tag) => activeTagIds.value.has(tag.id));
});

const nebulaTagMenuTag = computed(() => {
  if (!visibleGraph.value || !nebulaTagMenu.value) {
    return null;
  }
  return visibleGraph.value.tags.find((tag) => tag.id === nebulaTagMenu.value?.tagId) ?? null;
});

const relatedTagItems = computed(() => {
  if (!visibleGraph.value) {
    return [];
  }
  const score = new Map<number, number>();
  const candidates = activeTagIds.value.size > 0 ? filteredLogs.value : visibleGraph.value.logs;
  for (const log of candidates) {
    for (const tag of log.tags) {
      if (!activeTagIds.value.has(tag.id)) {
        score.set(tag.id, (score.get(tag.id) ?? 0) + 1);
      }
    }
  }
  return [...score.entries()]
    .map(([id, count]) => ({ tag: visibleGraph.value!.tags.find((item) => item.id === id), count }))
    .filter((item): item is { tag: TagNode; count: number } => Boolean(item.tag))
    .sort((a, b) => b.count - a.count);
});

const relatedCanPaginate = computed(() => activeTagIds.value.size > 0);

const relatedTotalPages = computed(() => {
  if (!relatedCanPaginate.value) {
    return 1;
  }
  return Math.max(1, Math.ceil(relatedTagItems.value.length / RELATED_TAG_PAGE_SIZE));
});

const relatedTags = computed(() => {
  if (!relatedCanPaginate.value) {
    return relatedTagItems.value.slice(0, RELATED_TAG_PAGE_SIZE);
  }
  const start = relatedPage.value * RELATED_TAG_PAGE_SIZE;
  return relatedTagItems.value.slice(start, start + RELATED_TAG_PAGE_SIZE);
});

const relatedPageLabel = computed(() => `${Math.min(relatedPage.value + 1, relatedTotalPages.value)} / ${relatedTotalPages.value}`);

const logListHint = computed(() => {
  if (timeFilter.value !== 'all' && frequencyFilter.value !== 'all') {
    return '时间 + 频率';
  }
  if (timeFilter.value !== 'all') {
    return '按时间筛选';
  }
  if (frequencyFilter.value !== 'all') {
    return '按频率筛选';
  }
  if (sortMode.value === 'frequency') {
    return '高频优先';
  }
  if (sortMode.value === 'lowFrequency') {
    return '低频优先';
  }
  if (sortMode.value === 'recent') {
    return '最近活跃';
  }
  return '默认布局';
});
watch(activeTagIds, () => {
  relatedPage.value = 0;
});

watch(relatedTotalPages, (pages) => {
  if (relatedPage.value >= pages) {
    relatedPage.value = Math.max(0, pages - 1);
  }
});

const stats = computed(() => ({
  tags: visibleGraph.value?.tags.length ?? 0,
  logs: visibleGraph.value?.logs.length ?? 0,
  filtered:
    activeTagIds.value.size === 0 && timeFilter.value === 'all' && frequencyFilter.value === 'all'
      ? 0
      : filteredLogs.value.length
}));

function matchesTimeFilter(log: LogEntry, mode: TimeFilterMode) {
  if (mode === 'all') {
    return true;
  }
  const created = new Date(log.createdAt).getTime();
  if (!Number.isFinite(created)) {
    return true;
  }
  if (mode === 'custom') {
    const start = customStartDate.value ? new Date(`${customStartDate.value}T00:00:00`).getTime() : -Infinity;
    const end = customEndDate.value ? new Date(`${customEndDate.value}T23:59:59`).getTime() : Infinity;
    return created >= start && created <= end;
  }
  const now = Date.now();
  const day = 1000 * 60 * 60 * 24;
  const range =
    mode === 'week'
      ? day * 7
      : mode === 'month'
        ? day * 30
        : day * 90;
  return now - created <= range;
}

function buildTagUsageStats(logs: LogEntry[]) {
  const usage = new Map<number, { count: number; latest: number }>();
  for (const log of logs) {
    const created = new Date(log.createdAt).getTime();
    for (const tag of log.tags) {
      const current = usage.get(tag.id) ?? { count: 0, latest: 0 };
      current.count += 1;
      current.latest = Math.max(current.latest, Number.isFinite(created) ? created : 0);
      usage.set(tag.id, current);
    }
  }
  return usage;
}

function buildFrequencyThresholds(usage: Map<number, { count: number; latest: number }>) {
  const counts = [...usage.values()].map((item) => item.count).filter((count) => count > 0);
  const max = Math.max(0, ...counts);
  return {
    high: Math.max(2, Math.ceil(max * 0.66)),
    low: Math.max(1, Math.floor(max * 0.34))
  };
}

function matchesFrequencyFilter(count: number, thresholds: { high: number; low: number }) {
  if (frequencyFilter.value === 'high') {
    return count >= thresholds.high;
  }
  if (frequencyFilter.value === 'low') {
    return count > 0 && count <= thresholds.low;
  }
  return true;
}

function sortTagsForPriority(tags: TagNode[], logs: LogEntry[], mode: NebulaSortMode) {
  const usage = buildTagUsageStats(logs);
  return [...tags].sort((a, b) => {
    const aUsage = usage.get(a.id) ?? { count: a.count, latest: 0 };
    const bUsage = usage.get(b.id) ?? { count: b.count, latest: 0 };
    if (mode === 'frequency') {
      return bUsage.count - aUsage.count || a.name.localeCompare(b.name);
    }
    if (mode === 'lowFrequency') {
      return aUsage.count - bUsage.count || a.name.localeCompare(b.name);
    }
    if (mode === 'recent') {
      return bUsage.latest - aUsage.latest || bUsage.count - aUsage.count || a.name.localeCompare(b.name);
    }
    return 0;
  });
}

function setTimeFilter(mode: TimeFilterMode) {
  timeFilter.value = mode;
  localStorage.setItem('nebula.timeFilter', mode);
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  nebulaRenderKey.value += 1;
}

function setFrequencyFilter(mode: FrequencyFilterMode) {
  frequencyFilter.value = mode;
  localStorage.setItem('nebula.frequencyFilter', mode);
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  nebulaRenderKey.value += 1;
}

function setSortMode(mode: NebulaSortMode) {
  sortMode.value = mode;
  localStorage.setItem('nebula.sortMode', mode);
}

function updateCustomTimeRange() {
  localStorage.setItem('nebula.customStartDate', customStartDate.value);
  localStorage.setItem('nebula.customEndDate', customEndDate.value);
  setTimeFilter('custom');
}

const layoutAiStatus = computed(() => {
  const isDomain = layoutMode.value === 'domain';
  const meta = isDomain ? graph.value?.aiMeta?.tagGroups : graph.value?.aiMeta?.tagRelations;
  const suffix = isDomain ? '分组' : '语义';
  if (!meta) {
    return {
      label: isDomain ? '领域分组' : '语义布局',
      title: isDomain ? '尚未获取领域分组状态' : '尚未获取语义关系状态'
    };
  }
  const labels = {
    deepseek: `DeepSeek ${suffix}`,
    cache: `DeepSeek 缓存${suffix}`,
    local: `本地${suffix}`,
    none: `无 AI ${suffix}`
  };
  return {
    label: labels[meta.source] ?? `本地${suffix}`,
    title: meta.message ?? (isDomain ? '后端未返回领域分组状态' : '后端未返回语义关系状态')
  };
});

const hasNoMaps = computed(() => currentUser.value !== null && maps.value.length === 0);

onMounted(async () => {
  window.addEventListener('online', handleNetworkChange);
  window.addEventListener('offline', handleNetworkChange);
  window.addEventListener('keydown', handleNebulaShortcut);
  await bootstrap();
});

onBeforeUnmount(() => {
  window.removeEventListener('online', handleNetworkChange);
  window.removeEventListener('offline', handleNetworkChange);
  window.removeEventListener('keydown', handleNebulaShortcut);
});

async function bootstrap() {
  checkingAuth.value = true;
  try {
    const result = await getCurrentUser();
    currentUser.value = result.user;
    await loadWorkspace();
  } catch {
    currentUser.value = null;
    resetWorkspace();
  } finally {
    checkingAuth.value = false;
  }
}

async function handleAuthenticated(user: UserAccount) {
  currentUser.value = user;
  checkingAuth.value = false;
  resetWorkspace();
  await loadWorkspace();
  showNotice('登录成功');
}

async function handleLogout() {
  await logout().catch(() => undefined);
  currentUser.value = null;
  resetWorkspace();
}

async function loadWorkspace() {
  await refreshMaps();
  const remembered = Number(localStorage.getItem(activeMapStorageKey()));
  const first = maps.value.find((map) => map.id === remembered) ?? maps.value[0];
  if (first) {
    await selectMap(first.id);
    return;
  }
  activeMapId.value = null;
  graph.value = null;
  insights.value = null;
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  editorMode.value = null;
}

function resetWorkspace() {
  maps.value = [];
  activeMapId.value = null;
  graph.value = null;
  insights.value = null;
  activeTagIds.value = new Set();
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  editorMode.value = 'new';
  editingLog.value = null;
  draft.value = undefined;
  draftRestored.value = false;
  draftSavedAt.value = '';
  layoutDirty.value = false;
  leftPanel.value = null;
  rightPanel.value = null;
  error.value = '';
  notice.value = '';
  clearDeleteHistory();
}

async function refreshMaps() {
  maps.value = await listMaps();
}

async function selectMap(mapId: number) {
  clearDeleteHistory();
  activeMapId.value = mapId;
  localStorage.setItem(activeMapStorageKey(), String(mapId));
  localStorage.setItem('nebula.activeMapId', String(mapId));
  activeTagIds.value = new Set();
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  editorMode.value = 'new';
  editingLog.value = null;
  layoutDirty.value = false;
  leftPanel.value = null;
  rightPanel.value = null;
  draft.value = await loadDraft(mapId).catch(() => undefined);
  draftRestored.value = hasDraftContent(draft.value);
  draftSavedAt.value = draftRestored.value ? '刚刚' : '';
  await refreshData();
}

async function refreshData() {
  if (!activeMapId.value) {
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const [nextGraph, nextInsights] = await Promise.all([getGraph(activeMapId.value), getInsights(activeMapId.value)]);
    graph.value = nextGraph;
    insights.value = nextInsights;
    const validTagIds = new Set(nextGraph.tags.map((tag) => tag.id));
    activeTagIds.value = new Set([...activeTagIds.value].filter((id) => validTagIds.has(id)));
    const relationMeta = nextGraph.aiMeta?.tagRelations;
    if (relationMeta?.attempted || relationMeta?.source === 'cache') {
      showNotice(relationMeta.message);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function refreshNebulaView() {
  if (!activeMapId.value) {
    return;
  }
  activeTagIds.value = new Set();
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  rightPanel.value = null;
  nebulaRenderKey.value += 1;
  layoutDirty.value = false;
  await nextTick();
  showNotice('星云图已回到主视角');
}

async function handleGenerateAdvice() {
  if (!activeMapId.value || !insights.value) {
    return;
  }
  adviceLoading.value = true;
  error.value = '';
  try {
    const result = normalizeAdviceResponse(await generateAdvice(activeMapId.value));
    insights.value = {
      ...insights.value,
      suggestions: result.suggestions,
      adviceMeta: result.aiMeta
    };
    showNotice(result.aiMeta.message);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '生成建议失败';
  } finally {
    adviceLoading.value = false;
  }
}

function normalizeAdviceResponse(result: AdviceResponse): AdviceResponse {
  return {
    cached: Boolean(result.cached),
    suggestions: result.suggestions ?? [],
    aiMeta:
      result.aiMeta ??
      fallbackAiMeta('advice', '建议已生成，但后端未返回 DeepSeek 调用状态')
  };
}

function fallbackAiMeta(feature: AiMeta['feature'], message: string): AiMeta {
  return {
    feature,
    source: 'local',
    attempted: false,
    message
  };
}

async function addMap() {
  const created = await createMap(uniqueMapName('新的星云图'), '我的个人行为观察星云');
  await refreshMaps();
  await selectMap(created.id);
  startRenameMap(created.id, leftPanel.value === 'maps' ? 'list' : 'title');
  showNotice('星云图已创建，可直接改名');
}

function startRenameMap(mapId = activeMapId.value, location: 'list' | 'title' = 'title') {
  if (!mapId) {
    return;
  }
  const target = maps.value.find((map) => map.id === mapId) ?? graph.value?.map;
  if (!target) {
    return;
  }
  renamingMapId.value = mapId;
  renameLocation.value = location;
  renameDraft.value = target.name;
  void nextTick(() => {
    const input =
      document.querySelector<HTMLInputElement>(`[data-map-rename-input="${location}-${mapId}"]`) ??
      document.querySelector<HTMLInputElement>(`[data-map-rename-input$="-${mapId}"]`);
    input?.focus();
    input?.select();
  });
}

function cancelRenameMap() {
  renamingMapId.value = null;
  renameLocation.value = 'title';
  renameDraft.value = '';
}

async function saveRenameMap(mapId = renamingMapId.value) {
  if (!mapId) {
    return;
  }
  const target = maps.value.find((map) => map.id === mapId) ?? graph.value?.map;
  const nextName = renameDraft.value.trim();
  if (!target || !nextName) {
    return;
  }
  if (nextName === target.name) {
    cancelRenameMap();
    return;
  }
  renameSaving.value = true;
  try {
    const updated = await updateMap(mapId, {
      name: nextName,
      description: target.description ?? ''
    });
    maps.value = maps.value.map((map) => (map.id === updated.id ? updated : map));
    if (graph.value?.map.id === updated.id) {
      graph.value = {
        ...graph.value,
        map: updated
      };
    }
    cancelRenameMap();
    showNotice('星云图名称已更新');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '更新星云图名称失败';
  } finally {
    renameSaving.value = false;
  }
}

function requestDeleteMap(map: NebulaMap) {
  openNebulaConfirm({
    title: '删除星云图',
    message: `确定删除「${map.name}」吗？里面的日志、标签、领域大类都会一起删除。`,
    confirmLabel: '删除',
    onConfirm: async () => {
      await deleteMap(map.id);
      await clearDraft(map.id).catch(() => undefined);
      maps.value = maps.value.filter((item) => item.id !== map.id);
      if (renamingMapId.value === map.id) {
        cancelRenameMap();
      }

      if (activeMapId.value === map.id) {
        localStorage.removeItem(activeMapStorageKey());
        const nextMap = maps.value[0] ?? null;
        if (nextMap) {
          await selectMap(nextMap.id);
        } else {
          clearActiveMapState();
        }
      } else {
        await refreshMaps();
      }
      showNotice('星云图已删除');
    }
  });
}

function clearActiveMapState() {
  activeMapId.value = null;
  graph.value = null;
  insights.value = null;
  activeTagIds.value = new Set();
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  editorMode.value = 'new';
  editingLog.value = null;
  draft.value = undefined;
  draftRestored.value = false;
  draftSavedAt.value = '';
  layoutDirty.value = false;
  rightPanel.value = null;
}

function uniqueMapName(baseName: string) {
  const names = new Set(maps.value.map((map) => map.name));
  if (!names.has(baseName)) {
    return baseName;
  }
  let index = 2;
  while (names.has(`${baseName} ${index}`)) {
    index += 1;
  }
  return `${baseName} ${index}`;
}

function startNewLog() {
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  editingLog.value = null;
  editorMode.value = 'new';
  rightPanel.value = 'editor';
}

function startEditLog(logId = selectedLogId.value) {
  const log = logId === null ? null : visibleGraph.value?.logs.find((item) => item.id === logId) ?? null;
  if (!log) {
    return;
  }
  editingLog.value = log;
  editorMode.value = 'edit';
  nebulaLogCard.value = null;
  rightPanel.value = 'editor';
}

async function handleSaveLog(payload: DraftLog) {
  if (!activeMapId.value) {
    return;
  }

  const wasEditing = editorMode.value === 'edit' ? editingLog.value : null;
  if (!isOnline.value && !wasEditing) {
    await saveDraft(activeMapId.value, payload).catch(() => undefined);
    draft.value = payload;
    draftSavedAt.value = formatTime(new Date());
    draftRestored.value = false;
    showNotice('当前离线，草稿已保存在本地，联网后再点保存。');
    return;
  }
  if (!isOnline.value && wasEditing) {
    showNotice('当前离线，已保存日志暂不直接修改；联网后再保存。');
    return;
  }

  try {
    const saved = wasEditing
      ? await updateLog(wasEditing.id, payload)
      : await createLog({ mapId: activeMapId.value, ...payload });

    await clearDraft(activeMapId.value).catch(() => undefined);
    draft.value = undefined;
    draftRestored.value = false;
    draftSavedAt.value = '';
    selectedLogId.value = saved.id;
    nebulaLogCard.value = null;
    editorMode.value = null;
    editingLog.value = null;
    rightPanel.value = null;
    await refreshData();
    showNotice(wasEditing ? '日志已更新' : '日志已保存');
  } catch (err) {
    if (!wasEditing) {
      await saveDraft(activeMapId.value, payload).catch(() => undefined);
      draft.value = payload;
      draftSavedAt.value = formatTime(new Date());
    }
    error.value = err instanceof Error ? err.message : '保存失败';
  }
}

async function removeLog(logId = selectedLogId.value) {
  const log = logId === null ? null : visibleGraph.value?.logs.find((item) => item.id === logId) ?? null;
  if (!log) {
    return;
  }
  openNebulaConfirm({
    title: '删除日志',
    message: `确认删除「${log.title}」吗？删除后可以用撤销恢复。`,
    confirmLabel: '删除',
    onConfirm: async () => {
      const snapshot = cloneLogSnapshot(log);
      await deleteLog(log.id);
      pushDeleteHistory({ kind: 'log', log: snapshot });
      if (selectedLogId.value === log.id) {
        selectedLogId.value = null;
      }
      if (editingLog.value?.id === log.id) {
        editorMode.value = 'new';
        editingLog.value = null;
        rightPanel.value = null;
      }
      nebulaLogCard.value = null;
      await refreshData();
      showNotice('日志已删除，可撤销');
    }
  });
}

function requestDeleteTag(tag: TagNode) {
  const mapId = activeMapId.value;
  const logIds =
    visibleGraph.value?.logs.filter((log) => log.tags.some((item) => item.id === tag.id)).map((log) => log.id) ?? [];
  openNebulaConfirm({
    title: '删除标签',
    message: `确认删除「${tag.name}」吗？删除后可以用撤销恢复。`,
    confirmLabel: '删除',
    onConfirm: async () => {
      if (!mapId) {
        return;
      }
      await deleteTag(tag.id);
      pushDeleteHistory({ kind: 'tag', tag: cloneTagSnapshot(tag), mapId, logIds });
      activeTagIds.value = new Set([...activeTagIds.value].filter((id) => id !== tag.id));
      closeTagContext();
      await refreshData();
      showNotice('标签已删除，可撤销');
    }
  });
}

function openTagContext(payload: { tagId: number; x: number; y: number; width: number; height: number }) {
  const tag = visibleGraph.value?.tags.find((item) => item.id === payload.tagId);
  if (!tag) {
    return;
  }
  const menuWidth = 236;
  const menuHeight = 172;
  nebulaLogCard.value = null;
  nebulaTagMenu.value = {
    tagId: payload.tagId,
    x: Math.min(Math.max(14, payload.x + 14), Math.max(14, payload.width - menuWidth - 14)),
    y: Math.min(Math.max(14, payload.y + 10), Math.max(14, payload.height - menuHeight - 14)),
    width: payload.width,
    height: payload.height,
    mode: 'menu'
  };
  tagEditName.value = tag.name;
  tagEditColor.value = tag.color;
}

function closeTagContext() {
  if (tagEditSaving.value) {
    return;
  }
  nebulaTagMenu.value = null;
  tagEditName.value = '';
  tagEditColor.value = '#62d6ff';
}

function startContextTagEdit() {
  const tag = nebulaTagMenuTag.value;
  if (!tag || !nebulaTagMenu.value) {
    return;
  }
  tagEditName.value = tag.name;
  tagEditColor.value = tag.color;
  nebulaTagMenu.value = {
    ...nebulaTagMenu.value,
    mode: 'edit'
  };
  void nextTick(() => {
    document.querySelector<HTMLInputElement>('[data-nebula-tag-edit-name]')?.focus();
  });
}

async function saveContextTagEdit() {
  const tag = nebulaTagMenuTag.value;
  const nextName = tagEditName.value.trim();
  if (!tag || !nextName) {
    return;
  }
  tagEditSaving.value = true;
  error.value = '';
  try {
    await updateTag(tag.id, { name: nextName, color: tagEditColor.value });
    await refreshData();
    tagEditSaving.value = false;
    closeTagContext();
    showNotice('标签已更新');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '更新标签失败';
  } finally {
    tagEditSaving.value = false;
  }
}

function deleteContextTag() {
  const tag = nebulaTagMenuTag.value;
  if (!tag) {
    return;
  }
  closeTagContext();
  requestDeleteTag(tag);
}

function cloneLogSnapshot(log: LogEntry): LogEntry {
  return {
    ...log,
    tags: log.tags.map((tag) => ({ ...tag }))
  };
}

function cloneTagSnapshot(tag: TagNode): TagNode {
  return { ...tag };
}

function pushDeleteHistory(action: DeleteHistoryAction) {
  deleteUndoStack.value = [...deleteUndoStack.value, action];
  deleteRedoStack.value = [];
}

function clearDeleteHistory() {
  deleteUndoStack.value = [];
  deleteRedoStack.value = [];
}

async function undoDeleteAction() {
  const action = deleteUndoStack.value.at(-1);
  if (!action) {
    return false;
  }

  try {
    const restoredAction = await restoreDeletedAction(action);
    deleteUndoStack.value = deleteUndoStack.value.slice(0, -1);
    deleteRedoStack.value = [...deleteRedoStack.value, restoredAction];
    await refreshData();
    showNotice(`已撤销删除：${deleteActionLabel(restoredAction)}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '撤销删除失败';
  }
  return true;
}

async function redoDeleteAction() {
  const action = deleteRedoStack.value.at(-1);
  if (!action) {
    return false;
  }

  try {
    await deleteRestoredAction(action);
    deleteRedoStack.value = deleteRedoStack.value.slice(0, -1);
    deleteUndoStack.value = [...deleteUndoStack.value, action];
    await refreshData();
    showNotice(`已重做删除：${deleteActionLabel(action)}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '重做删除失败';
  }
  return true;
}

async function restoreDeletedAction(action: DeleteHistoryAction): Promise<DeleteHistoryAction> {
  if (action.kind === 'log') {
    const restored = await restoreLog(action.log);
    return { kind: 'log', log: cloneLogSnapshot(restored) };
  }

  const restored = await restoreTag({
    id: action.tag.id,
    mapId: action.mapId,
    name: action.tag.name,
    color: action.tag.color,
    logIds: action.logIds
  });
  return { ...action, tag: cloneTagSnapshot(restored) };
}

async function deleteRestoredAction(action: DeleteHistoryAction) {
  if (action.kind === 'log') {
    await deleteLog(action.log.id);
    if (selectedLogId.value === action.log.id) {
      selectedLogId.value = null;
      nebulaLogCard.value = null;
    }
    if (editingLog.value?.id === action.log.id) {
      editorMode.value = 'new';
      editingLog.value = null;
      rightPanel.value = null;
    }
    return;
  }

  await deleteTag(action.tag.id);
  activeTagIds.value = new Set([...activeTagIds.value].filter((id) => id !== action.tag.id));
  closeTagContext();
}

function deleteActionLabel(action: DeleteHistoryAction) {
  return action.kind === 'log' ? action.log.title : action.tag.name;
}

function openNebulaConfirm(payload: Omit<NebulaConfirm, 'pending'>) {
  nebulaConfirm.value = {
    ...payload,
    pending: false
  };
}

function closeNebulaConfirm() {
  if (nebulaConfirm.value?.pending) {
    return;
  }
  nebulaConfirm.value = null;
}

async function confirmNebulaAction() {
  const dialog = nebulaConfirm.value;
  if (!dialog || dialog.pending) {
    return;
  }
  dialog.pending = true;
  error.value = '';
  try {
    await dialog.onConfirm();
    nebulaConfirm.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '操作失败';
    dialog.pending = false;
  }
}

function exportLog(logId = selectedLogId.value) {
  const log = logId === null ? null : visibleGraph.value?.logs.find((item) => item.id === logId) ?? null;
  if (!log) {
    return;
  }
  const markdown = [
    `# ${log.title}`,
    '',
    `创建时间：${formatDate(log.createdAt)}`,
    `标签：${log.tags.map((tag) => `#${tag.name}`).join(' ')}`,
    '',
    log.content
  ].join('\n');
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${log.title}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

async function toggleTag(tagId: number) {
  const next = new Set(activeTagIds.value);
  if (next.has(tagId)) {
    next.delete(tagId);
  } else {
    next.add(tagId);
  }
  activeTagIds.value = next;
  await nextTick();
  tagManagerRef.value?.scrollToTag(tagId);
  scrollFirstFilteredLogIntoView();
}

function selectLogOnly(logId: number, resetEditor = true) {
  selectedLogId.value = logId;
  nebulaLogCard.value = null;
  if (resetEditor) {
    editorMode.value = null;
    editingLog.value = null;
  }
}

async function selectLogFromList(logId: number) {
  selectLogOnly(logId);
  await nextTick();
  let card = canvasRef.value?.focusLog(logId);
  if (!card) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    card = canvasRef.value?.focusLog(logId);
  }
  if (card) {
    inspectNebulaLog(card);
  }
}

function selectNebulaLog(logId: number) {
  if (selectedLogId.value === logId) {
    selectedLogId.value = null;
    nebulaLogCard.value = null;
    return;
  }
  selectLogOnly(logId, rightPanel.value !== 'editor');
  if (rightPanel.value === 'logs') {
    nextTick(() => scrollLogIntoView(logId));
  }
}

function scrollFirstFilteredLogIntoView() {
  const first = filteredLogs.value[0];
  if (!first) {
    return;
  }
  scrollLogIntoView(first.id);
}

function scrollLogIntoView(logId: number) {
  window.requestAnimationFrame(() => {
    document.querySelector(`[data-log-id="${logId}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    });
  });
}

function inspectNebulaLog(payload: NebulaLogCard) {
  const width = payload.width ?? window.innerWidth;
  const height = payload.height ?? window.innerHeight;
  const maxX = Math.max(16, width - 356);
  const maxY = Math.max(16, height - 300);
  selectedLogId.value = payload.logId;
  if (rightPanel.value !== 'editor') {
    editorMode.value = null;
    editingLog.value = null;
  }
  nebulaLogCard.value = {
    logId: payload.logId,
    x: Math.min(maxX, Math.max(16, payload.x + 16)),
    y: Math.min(maxY, Math.max(16, payload.y - 16)),
    width,
    height
  };
}

function closeNebulaCard() {
  nebulaLogCard.value = null;
}

function focusTag(tagId: number) {
  canvasRef.value?.focusTag(tagId);
}

async function focusDomainCategory(category: DomainCategory) {
  if (layoutMode.value !== 'domain') {
    layoutMode.value = 'domain';
    localStorage.setItem('nebula.layoutMode', 'domain');
  }
  activeTagIds.value = new Set();
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  await nextTick();
  window.requestAnimationFrame(() => {
    const focused = canvasRef.value?.focusDomainCategory(category) ?? false;
    if (!focused) {
      canvasRef.value?.fitAllTags();
    }
  });
}

function previousRelatedPage() {
  relatedPage.value = Math.max(0, relatedPage.value - 1);
}

function nextRelatedPage() {
  relatedPage.value = Math.min(relatedTotalPages.value - 1, relatedPage.value + 1);
}

function resetAiLayout() {
  canvasRef.value?.resetTagLayout();
  showNotice(layoutMode.value === 'domain' ? '已清除手动位置，正在恢复领域分组布局' : '已清除手动位置，正在恢复语义优先布局');
}

function saveNebulaLayout() {
  error.value = '';
  const layoutSaved = canvasRef.value?.saveLayout() ?? false;
  if (layoutSaved) {
    layoutDirty.value = false;
  }
  showNotice(layoutSaved ? '星云布局已保存' : '当前没有可保存的星云布局');
}

async function undoNebulaLayout() {
  if (await undoDeleteAction()) {
    return;
  }
  const undone = canvasRef.value?.undoLayout() ?? false;
  if (undone) {
    layoutDirty.value = true;
  }
  showNotice(undone ? '已撤销上一次星云布局调整' : '没有可撤销的星云布局调整');
}

async function redoNebulaLayout() {
  if (await redoDeleteAction()) {
    return;
  }
  const redone = canvasRef.value?.redoLayout() ?? false;
  if (redone) {
    layoutDirty.value = true;
  }
  showNotice(redone ? '已重做上一次星云布局调整' : '没有可重做的星云布局调整');
}

function handleLayoutDirty(dirty: boolean) {
  layoutDirty.value = dirty;
}

function handleNebulaShortcut(event: KeyboardEvent) {
  if (!graph.value || isTextInput(event.target)) {
    return;
  }
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 's') {
    event.preventDefault();
    saveNebulaLayout();
  }
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault();
    void undoNebulaLayout();
  }
  if ((event.ctrlKey || event.metaKey) && key === 'y') {
    event.preventDefault();
    void redoNebulaLayout();
  }
}

function isTextInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function cancelEditor() {
  editorMode.value = null;
  editingLog.value = null;
  rightPanel.value = null;
}

function toggleRightPanel(panel: RightPanel) {
  if (rightPanel.value === panel) {
    rightPanel.value = null;
    return;
  }
  if (panel === 'editor' && !editorMode.value) {
    if (selectedLogId.value !== null) {
      startEditLog(selectedLogId.value);
      return;
    }
    startNewLog();
    return;
  }
  rightPanel.value = panel;
}

function toggleLeftPanel(panel: LeftPanel) {
  leftPanel.value = leftPanel.value === panel ? null : panel;
}

function switchRenderer(mode: 'canvas' | 'webgpu') {
  rendererMode.value = mode;
  localStorage.setItem('nebula.rendererMode', mode);
  nebulaLogCard.value = null;
  showNotice(mode === 'webgpu' ? '已切换到 WebGPU 星云渲染' : '已切换到 Canvas 兼容渲染');
}

function switchLayoutMode(mode: LayoutMode) {
  layoutMode.value = mode;
  localStorage.setItem('nebula.layoutMode', mode);
  nebulaLogCard.value = null;
  showNotice(mode === 'domain' ? '已切换到领域分组布局' : '已切换到语义优先布局');
}

async function activateTagAndFocus(tagId: number) {
  activeTagIds.value = new Set([tagId]);
  selectedLogId.value = null;
  nebulaLogCard.value = null;
  await nextTick();
  window.requestAnimationFrame(() => canvasRef.value?.focusTag(tagId));
}

async function handleDraftChange(nextDraft: DraftLog) {
  if (!activeMapId.value || editorMode.value !== 'new') {
    return;
  }
  draft.value = nextDraft;
  draftRestored.value = false;
  await saveDraft(activeMapId.value, nextDraft).catch(() => undefined);
  draftSavedAt.value = formatTime(new Date());
}

function handleNetworkChange() {
  isOnline.value = navigator.onLine;
  showNotice(isOnline.value ? '网络已恢复，可以手动保存本地草稿。' : '当前离线，草稿会继续自动保存到本地。');
}

function showNotice(message: string) {
  notice.value = message;
  window.setTimeout(() => {
    if (notice.value === message) {
      notice.value = '';
    }
  }, 1800);
}

function hasDraftContent(value?: DraftLog) {
  return Boolean(value?.title?.trim() || value?.content?.trim() || value?.tagNames?.length);
}

function activeMapStorageKey() {
  return `nebula.activeMapId.${currentUser.value?.id ?? 'guest'}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(value);
}
</script>

<template>
  <AuthPanel v-if="!checkingAuth && !currentUser" @authenticated="handleAuthenticated" />

  <main v-else-if="currentUser" class="app-shell">
    <aside class="left-rail">
      <section class="brand-block">
        <div class="brand-mark">
          <Orbit :size="24" />
        </div>
        <div class="brand-copy">
          <h1>星云洞察</h1>
          <p>个人日志知识图谱</p>
        </div>
      </section>

      <div class="left-panel-tabs" aria-label="左侧信息面板">
        <button :class="{ active: leftPanel === 'maps' }" title="星云图" @click="toggleLeftPanel('maps')">
          <MapIcon :size="17" />
          星图
        </button>
        <button :class="{ active: leftPanel === 'active' }" title="激活标签" @click="toggleLeftPanel('active')">
          <Tags :size="17" />
          标签
        </button>
        <button :class="{ active: leftPanel === 'related' }" title="相关标签" @click="toggleLeftPanel('related')">
          <Link2 :size="17" />
          相关
        </button>
        <button
          :class="{ active: leftPanel === 'manage' }"
          :disabled="!activeMapId || !graph"
          title="标签管理"
          @click="toggleLeftPanel('manage')"
        >
          <Layers :size="17" />
          管理
        </button>
        <button
          :class="{ active: leftPanel === 'domains' }"
          :disabled="!activeMapId || !graph"
          title="领域大类"
          @click="toggleLeftPanel('domains')"
        >
          <Layers :size="17" />
          大类
        </button>
      </div>

      <section v-if="leftPanel === 'maps'" class="panel">
        <div class="panel-title">
          <span>星云图</span>
          <button class="icon-button" title="新建星云图" @click="addMap">
            <Plus :size="17" />
          </button>
        </div>
        <div class="map-list">
          <div v-for="map in maps" :key="map.id" class="map-row">
            <form
              v-if="renamingMapId === map.id && renameLocation === 'list'"
              class="map-rename-form"
              @submit.prevent="saveRenameMap(map.id)"
            >
              <input
                v-model="renameDraft"
                :data-map-rename-input="`list-${map.id}`"
                aria-label="星云图名称"
                @keydown.escape.prevent="cancelRenameMap"
              />
              <button class="icon-button" title="保存名称" :disabled="renameSaving">
                <Check :size="15" />
              </button>
              <button class="icon-button" type="button" title="取消改名" @click="cancelRenameMap">
                <X :size="15" />
              </button>
            </form>
            <template v-else>
              <button class="map-item" :class="{ active: map.id === activeMapId }" @click="selectMap(map.id)">
                <span>{{ map.name }}{{ layoutDirty && map.id === activeMapId ? ' *' : '' }}</span>
                <small>{{ map.description || '无描述' }}</small>
              </button>
              <button class="icon-button map-edit-button" title="修改星云图名称" @click="startRenameMap(map.id, 'list')">
                <Edit3 :size="15" />
              </button>
              <button class="icon-button map-edit-button danger" title="删除星云图" @click.stop="requestDeleteMap(map)">
                <Trash2 :size="15" />
              </button>
            </template>
          </div>
        </div>
      </section>

      <section v-if="leftPanel === 'active'" class="panel">
        <div class="panel-title">
          <span>激活标签</span>
          <button class="text-button compact" @click="activeTagIds = new Set()">清空</button>
        </div>
        <div v-if="activeTags.length" class="chip-list">
          <button
            v-for="tag in activeTags"
            :key="tag.id"
            class="chip active"
            :style="{ borderColor: tag.color }"
            @click="toggleTag(tag.id)"
          >
            {{ tag.name }}
          </button>
        </div>
        <p v-else class="muted">点击星云中的恒星即可激活标签。</p>
      </section>

      <section v-if="leftPanel === 'related'" class="panel">
        <div class="panel-title">
          <span>相关标签</span>
          <small>{{ relatedCanPaginate ? `${relatedTagItems.length} 个` : '热门' }}</small>
        </div>
        <div class="related-list">
          <button v-for="item in relatedTags" :key="item.tag.id" class="related-item" @click="focusTag(item.tag.id)">
            <span class="tag-dot" :style="{ backgroundColor: item.tag.color }"></span>
            <span>{{ item.tag.name }}</span>
            <small>{{ item.count }}</small>
          </button>
          <p v-if="relatedTags.length === 0" class="empty-inline">暂无相关标签</p>
        </div>
        <div v-if="relatedCanPaginate && relatedTotalPages > 1" class="related-pager">
          <button class="icon-button" title="上一页" :disabled="relatedPage === 0" @click="previousRelatedPage">
            <ChevronLeft :size="15" />
          </button>
          <span>{{ relatedPageLabel }}</span>
          <button class="icon-button" title="下一页" :disabled="relatedPage >= relatedTotalPages - 1" @click="nextRelatedPage">
            <ChevronRight :size="15" />
          </button>
        </div>
      </section>

      <TagManager
        v-if="leftPanel === 'manage' && activeMapId && graph"
        ref="tagManagerRef"
        :map-id="activeMapId"
        :tags="graph.tags"
        @changed="refreshData"
        @delete-request="requestDeleteTag"
        @focus="activateTagAndFocus"
      />
      <DomainCategoryManager
        v-if="leftPanel === 'domains' && activeMapId && visibleGraph"
        :map-id="activeMapId"
        :domain-categories="visibleGraph.domainCategories ?? []"
        @changed="refreshData"
        @focus="focusDomainCategory"
      />
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <div class="title-row">
            <form
              v-if="activeMapId && renamingMapId === activeMapId && renameLocation === 'title'"
              class="title-rename-form"
              @submit.prevent="saveRenameMap(activeMapId)"
            >
              <input
                v-model="renameDraft"
                :data-map-rename-input="`title-${activeMapId}`"
                aria-label="星云图名称"
                @keydown.escape.prevent="cancelRenameMap"
              />
              <button class="icon-button compact-title-action" title="保存名称" :disabled="renameSaving">
                <Check :size="15" />
              </button>
              <button class="icon-button compact-title-action" type="button" title="取消改名" @click="cancelRenameMap">
                <X :size="15" />
              </button>
            </form>
            <template v-else>
              <h2>{{ visibleGraph?.map.name ?? (hasNoMaps ? '还没有星云图' : '加载中') }}{{ layoutDirty ? ' *' : '' }}</h2>
              <button
                v-if="activeMapId"
                class="icon-button compact-title-action"
                title="修改星云图名称"
                @click="startRenameMap(activeMapId, 'title')"
              >
                <Edit3 :size="15" />
              </button>
            </template>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="renderer-toggle" title="渲染模式">
            <button :class="{ active: rendererMode === 'canvas' }" @click="switchRenderer('canvas')">
              Canvas
            </button>
            <button :class="{ active: rendererMode === 'webgpu' }" @click="switchRenderer('webgpu')">
              <Cpu :size="14" />
              WebGPU
            </button>
          </div>
          <div class="renderer-toggle layout-mode-toggle" title="AI 布局模式">
            <button :class="{ active: layoutMode === 'semantic' }" @click="switchLayoutMode('semantic')">
              <Link2 :size="14" />
              语义
            </button>
            <button :class="{ active: layoutMode === 'domain' }" @click="switchLayoutMode('domain')">
              <Layers :size="14" />
              领域
            </button>
          </div>
          <div class="renderer-toggle filter-toggle" title="时间筛选">
            <button :class="{ active: timeFilter === 'all' }" @click="setTimeFilter('all')">全部</button>
            <button :class="{ active: timeFilter === 'week' }" @click="setTimeFilter('week')">7天</button>
            <button :class="{ active: timeFilter === 'month' }" @click="setTimeFilter('month')">30天</button>
            <button :class="{ active: timeFilter === 'quarter' }" @click="setTimeFilter('quarter')">90天</button>
            <button :class="{ active: timeFilter === 'custom' }" @click="setTimeFilter('custom')">自定义</button>
          </div>
          <div v-if="timeFilter === 'custom'" class="date-filter-controls">
            <input v-model="customStartDate" type="date" aria-label="开始日期" @change="updateCustomTimeRange" />
            <span>至</span>
            <input v-model="customEndDate" type="date" aria-label="结束日期" @change="updateCustomTimeRange" />
          </div>
          <div class="renderer-toggle frequency-toggle" title="标签使用频率筛选">
            <button :class="{ active: frequencyFilter === 'all' }" @click="setFrequencyFilter('all')">频率全部</button>
            <button :class="{ active: frequencyFilter === 'high' }" @click="setFrequencyFilter('high')">高频</button>
            <button :class="{ active: frequencyFilter === 'low' }" @click="setFrequencyFilter('low')">低频</button>
          </div>
          <div class="renderer-toggle sort-toggle" title="标签排序">
            <button :class="{ active: sortMode === 'layout' }" @click="setSortMode('layout')">布局</button>
            <button :class="{ active: sortMode === 'frequency' }" @click="setSortMode('frequency')">高频优先</button>
            <button :class="{ active: sortMode === 'lowFrequency' }" @click="setSortMode('lowFrequency')">低频优先</button>
            <button :class="{ active: sortMode === 'recent' }" @click="setSortMode('recent')">最近活跃</button>
          </div>
          <div class="stat-pill">{{ stats.tags }} 标签</div>
          <div class="stat-pill">{{ stats.logs }} 日志</div>
          <div class="stat-pill highlight">{{ stats.filtered }} 命中</div>
          <div class="stat-pill" :title="layoutAiStatus.title">{{ layoutAiStatus.label }}</div>
          <button class="icon-button" title="刷新星云图" :disabled="!activeMapId" @click="refreshNebulaView">
            <RefreshCw :size="17" />
          </button>
          <button class="icon-button" title="恢复 AI 布局" :disabled="!activeMapId" @click="resetAiLayout">
            <RotateCcw :size="17" />
          </button>
          <button class="icon-button" title="保存星云布局 Ctrl+S" :disabled="!activeMapId" @click="saveNebulaLayout">
            <Save :size="17" />
          </button>
          <button class="icon-button" title="撤销删除或星云布局 Ctrl+Z" :disabled="!activeMapId" @click="undoNebulaLayout">
            <Undo2 :size="17" />
          </button>
          <button class="icon-button" title="重做删除或星云布局 Ctrl+Y" :disabled="!activeMapId" @click="redoNebulaLayout">
            <Redo2 :size="17" />
          </button>
          <button class="primary-button" :disabled="!activeMapId" @click="startNewLog">
            <FilePlus2 :size="17" />
            新日志
          </button>
          <div class="user-pill" :title="`当前用户：${currentUser.username}`">
            <UserRound :size="16" />
            {{ currentUser.username }}
          </div>
          <button class="icon-button" title="退出登录" @click="handleLogout">
            <LogOut :size="17" />
          </button>
        </div>
      </header>

      <div v-if="error" class="message error">{{ error }}</div>
      <div v-if="notice" class="message success">{{ notice }}</div>
      <div v-if="!isOnline" class="message warning">当前离线：可以继续写新日志，草稿会自动保存到 IndexedDB。</div>

      <NebulaCanvas
        v-if="visibleGraph && rendererMode === 'canvas'"
        :key="`canvas-${activeMapId ?? 'none'}-${nebulaRenderKey}`"
        ref="canvasRef"
        :graph="visibleGraph"
        :layout-mode="layoutMode"
        :active-tag-ids="activeTagIds"
        :selected-log-id="selectedLogId"
        @tag-toggle="toggleTag"
        @tag-context="openTagContext"
        @log-open="selectNebulaLog"
        @log-inspect="inspectNebulaLog"
        @layout-dirty="handleLayoutDirty"
      >
        <template #overlay>
          <div v-if="nebulaConfirm" class="nebula-confirm-card" role="dialog" aria-modal="true">
            <p class="nebula-confirm-eyebrow">{{ nebulaConfirm.title }}</p>
            <p class="nebula-confirm-message">{{ nebulaConfirm.message }}</p>
            <div class="nebula-confirm-actions">
              <button class="secondary-button" type="button" :disabled="nebulaConfirm.pending" @click="closeNebulaConfirm">
                取消
              </button>
              <button class="danger-confirm" type="button" :disabled="nebulaConfirm.pending" @click="confirmNebulaAction">
                {{ nebulaConfirm.pending ? '处理中' : nebulaConfirm.confirmLabel }}
              </button>
            </div>
          </div>
          <div
            v-if="nebulaTagMenu && nebulaTagMenuTag"
            class="nebula-tag-menu"
            :style="{ left: `${nebulaTagMenu.x}px`, top: `${nebulaTagMenu.y}px` }"
            @click.stop
            @pointerdown.stop
            @pointerup.stop
            @contextmenu.prevent.stop
          >
            <div class="nebula-tag-menu-head">
              <span>标签操作</span>
              <button class="icon-button" title="关闭" @click="closeTagContext">
                <X :size="14" />
              </button>
            </div>
            <template v-if="nebulaTagMenu.mode === 'menu'">
              <div class="nebula-tag-menu-preview">
                <span class="tag-dot" :style="{ backgroundColor: nebulaTagMenuTag.color }"></span>
                <strong>{{ nebulaTagMenuTag.name }}</strong>
                <small>{{ nebulaTagMenuTag.count }} 篇</small>
              </div>
              <button class="secondary-button wide" @click="startContextTagEdit">
                <Edit3 :size="15" />
                编辑标签
              </button>
              <button class="danger-context-button wide" @click="deleteContextTag">
                <Trash2 :size="15" />
                删除标签
              </button>
            </template>
            <form v-else class="nebula-tag-edit-form" @submit.prevent="saveContextTagEdit">
              <label>
                <span>名称</span>
                <input v-model="tagEditName" data-nebula-tag-edit-name />
              </label>
              <label>
                <span>颜色</span>
                <input v-model="tagEditColor" class="color-input" type="color" />
              </label>
              <div class="nebula-tag-menu-actions">
                <button class="secondary-button" type="button" @click="closeTagContext">取消</button>
                <button class="primary-button" :disabled="tagEditSaving || !tagEditName.trim()">
                  {{ tagEditSaving ? '保存中' : '保存' }}
                </button>
              </div>
            </form>
          </div>
          <div
            v-if="nebulaCardLog"
            class="nebula-log-card"
            :style="{ left: `${nebulaCardLog.x}px`, top: `${nebulaCardLog.y}px` }"
            @click.stop
            @pointerdown.stop
            @pointerup.stop
          >
            <div class="nebula-log-card-head">
              <span>日志星卡</span>
              <div class="nebula-log-card-actions">
                <button class="icon-button" title="编辑" @click.stop="startEditLog(nebulaCardLog.log.id)">
                  <Edit3 :size="15" />
                </button>
                <button class="icon-button" title="导出 Markdown" @click.stop="exportLog(nebulaCardLog.log.id)">
                  <Download :size="15" />
                </button>
                <button class="icon-button danger" title="删除" @click.stop="removeLog(nebulaCardLog.log.id)">
                  <Trash2 :size="15" />
                </button>
                <button class="icon-button" title="关闭" @click.stop="closeNebulaCard">
                  <X :size="14" />
                </button>
              </div>
            </div>
            <h3>{{ nebulaCardLog.log.title }}</h3>
            <p class="detail-time">{{ formatDate(nebulaCardLog.log.createdAt) }}</p>
            <p class="nebula-log-card-content">{{ nebulaCardLog.log.content }}</p>
            <div class="chip-list">
              <button
                v-for="tag in nebulaCardLog.log.tags"
                :key="tag.id"
                class="chip"
                :style="{ borderColor: tag.color }"
                @click.stop="focusTag(tag.id)"
              >
                {{ tag.name }}
              </button>
            </div>
          </div>
        </template>
      </NebulaCanvas>
      <WebGpuNebulaCanvas
        v-else-if="visibleGraph"
        :key="`webgpu-${activeMapId ?? 'none'}-${timeFilter}-${frequencyFilter}-${customStartDate}-${customEndDate}-${nebulaRenderKey}`"
        ref="canvasRef"
        :graph="visibleGraph"
        :layout-mode="layoutMode"
        :active-tag-ids="activeTagIds"
        :selected-log-id="selectedLogId"
        :priority-tag-ids="priorityTagIds"
        @tag-toggle="toggleTag"
        @tag-context="openTagContext"
        @log-open="selectNebulaLog"
        @log-inspect="inspectNebulaLog"
        @layout-dirty="handleLayoutDirty"
      >
        <template #overlay>
          <div v-if="nebulaConfirm" class="nebula-confirm-card" role="dialog" aria-modal="true">
            <p class="nebula-confirm-eyebrow">{{ nebulaConfirm.title }}</p>
            <p class="nebula-confirm-message">{{ nebulaConfirm.message }}</p>
            <div class="nebula-confirm-actions">
              <button class="secondary-button" type="button" :disabled="nebulaConfirm.pending" @click="closeNebulaConfirm">
                取消
              </button>
              <button class="danger-confirm" type="button" :disabled="nebulaConfirm.pending" @click="confirmNebulaAction">
                {{ nebulaConfirm.pending ? '处理中' : nebulaConfirm.confirmLabel }}
              </button>
            </div>
          </div>
          <div
            v-if="nebulaTagMenu && nebulaTagMenuTag"
            class="nebula-tag-menu"
            :style="{ left: `${nebulaTagMenu.x}px`, top: `${nebulaTagMenu.y}px` }"
            @click.stop
            @pointerdown.stop
            @pointerup.stop
            @contextmenu.prevent.stop
          >
            <div class="nebula-tag-menu-head">
              <span>标签操作</span>
              <button class="icon-button" title="关闭" @click="closeTagContext">
                <X :size="14" />
              </button>
            </div>
            <template v-if="nebulaTagMenu.mode === 'menu'">
              <div class="nebula-tag-menu-preview">
                <span class="tag-dot" :style="{ backgroundColor: nebulaTagMenuTag.color }"></span>
                <strong>{{ nebulaTagMenuTag.name }}</strong>
                <small>{{ nebulaTagMenuTag.count }} 篇</small>
              </div>
              <button class="secondary-button wide" @click="startContextTagEdit">
                <Edit3 :size="15" />
                编辑标签
              </button>
              <button class="danger-context-button wide" @click="deleteContextTag">
                <Trash2 :size="15" />
                删除标签
              </button>
            </template>
            <form v-else class="nebula-tag-edit-form" @submit.prevent="saveContextTagEdit">
              <label>
                <span>名称</span>
                <input v-model="tagEditName" data-nebula-tag-edit-name />
              </label>
              <label>
                <span>颜色</span>
                <input v-model="tagEditColor" class="color-input" type="color" />
              </label>
              <div class="nebula-tag-menu-actions">
                <button class="secondary-button" type="button" @click="closeTagContext">取消</button>
                <button class="primary-button" :disabled="tagEditSaving || !tagEditName.trim()">
                  {{ tagEditSaving ? '保存中' : '保存' }}
                </button>
              </div>
            </form>
          </div>
          <div
            v-if="nebulaCardLog"
            class="nebula-log-card"
            :style="{ left: `${nebulaCardLog.x}px`, top: `${nebulaCardLog.y}px` }"
            @click.stop
            @pointerdown.stop
            @pointerup.stop
          >
            <div class="nebula-log-card-head">
              <span>日志星卡</span>
              <div class="nebula-log-card-actions">
                <button class="icon-button" title="编辑" @click.stop="startEditLog(nebulaCardLog.log.id)">
                  <Edit3 :size="15" />
                </button>
                <button class="icon-button" title="导出 Markdown" @click.stop="exportLog(nebulaCardLog.log.id)">
                  <Download :size="15" />
                </button>
                <button class="icon-button danger" title="删除" @click.stop="removeLog(nebulaCardLog.log.id)">
                  <Trash2 :size="15" />
                </button>
                <button class="icon-button" title="关闭" @click.stop="closeNebulaCard">
                  <X :size="14" />
                </button>
              </div>
            </div>
            <h3>{{ nebulaCardLog.log.title }}</h3>
            <p class="detail-time">{{ formatDate(nebulaCardLog.log.createdAt) }}</p>
            <p class="nebula-log-card-content">{{ nebulaCardLog.log.content }}</p>
            <div class="chip-list">
              <button
                v-for="tag in nebulaCardLog.log.tags"
                :key="tag.id"
                class="chip"
                :style="{ borderColor: tag.color }"
                @click.stop="focusTag(tag.id)"
              >
                {{ tag.name }}
              </button>
            </div>
          </div>
        </template>
      </WebGpuNebulaCanvas>
      <div v-else-if="hasNoMaps" class="empty-state">
        <div class="empty-state-content">
          <h3>这个账号还没有星云图</h3>
          <p>新注册用户默认是空白数据。点击左侧或下方按钮新建一张星云图，再开始写日志。</p>
          <button class="primary-button" @click="addMap">
            <Plus :size="17" />
            新建星云图
          </button>
        </div>
      </div>
      <div v-else class="empty-state">正在生成星云图...</div>

    </section>

    <aside class="right-rail">
      <div class="right-panel-tabs" aria-label="右侧信息面板">
        <button :class="{ active: rightPanel === 'logs' }" title="日志列表" @click="toggleRightPanel('logs')">
          <List :size="17" />
          日志
        </button>
        <button
          :class="{ active: rightPanel === 'editor' }"
          :disabled="!activeMapId"
          title="新建或编辑日志"
          @click="toggleRightPanel('editor')"
        >
          <PenLine :size="17" />
          编辑
        </button>
        <button :class="{ active: rightPanel === 'insight' }" title="推荐建议" @click="toggleRightPanel('insight')">
          <Sparkles :size="17" />
          建议
        </button>
      </div>

      <section v-if="rightPanel === 'logs'" class="panel log-list-panel">
        <div class="panel-title">
          <span>日志列表</span>
          <small>{{ logListHint }}</small>
        </div>
        <div class="log-list">
          <button
            v-for="log in filteredLogs"
            :key="log.id"
            :data-log-id="log.id"
            class="log-item"
            :class="{ active: log.id === selectedLogId }"
            @click="selectLogFromList(log.id)"
          >
            <span>{{ log.title }}</span>
            <small>{{ formatDate(log.createdAt) }}</small>
          </button>
        </div>
      </section>

      <LogEditor
        v-if="rightPanel === 'editor' && activeMapId && editorMode"
        :map-id="activeMapId"
        :initial-log="editingLog"
        :draft="draft"
        :existing-tags="graph?.tags ?? []"
        :offline="!isOnline"
        :draft-saved-at="draftSavedAt"
        :draft-restored="draftRestored"
        @save="handleSaveLog"
        @cancel="cancelEditor"
        @draft-change="handleDraftChange"
      />

      <InsightPanel
        v-if="rightPanel === 'insight'"
        :insight="insights"
        :advice-loading="adviceLoading"
        @generate-advice="handleGenerateAdvice"
      />
    </aside>
  </main>

  <main v-else class="auth-shell">
    <section class="auth-card">
      <p class="muted">正在检查登录状态...</p>
    </section>
  </main>
</template>
