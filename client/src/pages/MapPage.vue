<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronLeft,
  ChevronRight,
  Edit3,
  RefreshCw,
  RotateCcw,
  Save,
  Undo2,
  Redo2,
  FilePlus2,
  FileText,
  Tags,
  Link2,
  Layers,
  FolderTree,
  SlidersHorizontal,
  X,
  Check,
  List,
  Download,
  Trash2,
  Map as MapIcon,
  Plus
} from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useMapsStore } from '../stores/maps';
import { useGraphStore } from '../stores/graph';
import { useUiStore } from '../stores/ui';
import NebulaCanvas from '../components/NebulaCanvas.vue';
import WebGpuNebulaCanvas from '../components/WebGpuNebulaCanvas.vue';
import LogEditor from '../components/LogEditor.vue';
import TagManager from '../components/TagManager.vue';
import InsightPanel from '../components/InsightPanel.vue';
import DomainCategoryManager from '../components/DomainCategoryManager.vue';
import { createLog, updateLog, deleteLog } from '../services/api';
import type { NebulaMap, DomainCategory, LogEntry, DraftLog, TagNode } from '../types/domain';

defineOptions({ name: 'MapPage' });

const auth = useAuthStore();
const mapsStore = useMapsStore();
const graphStore = useGraphStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

const canvasRef = ref<any>(null);
const showDrawer = ref(false);
type DrawerTab = 'tags' | 'related' | 'manage' | 'insights' | 'domains' | 'maps' | 'logs';
const drawerTab = ref<DrawerTab | null>(null);
const selectedLogId = ref<number | null>(null);
const focusPulseLogId = ref<number | null>(null);
const activeClusterLogIds = ref<Set<number> | null>(null);
let focusPulseTimer: number | null = null;
let shortcutsBound = false;

const mapId = computed(() => Number(route.params.id));
const visibleGraph = computed(() => graphStore.filteredGraph);
const drawerLogs = computed(() => (
  [...graphStore.filteredLogs]
    .filter((log) => !activeClusterLogIds.value || activeClusterLogIds.value.has(log.id))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
));
const activeClusterCount = computed(() => activeClusterLogIds.value?.size ?? 0);
const drawerTitle = computed(() => {
  const titles: Partial<Record<DrawerTab, string>> = {
    tags: '激活标签',
    related: '相关标签',
    manage: '标签管理',
    insights: '洞察',
    domains: '领域大类',
    maps: '星图'
  };
  return drawerTab.value ? (titles[drawerTab.value] ?? '日志定位') : '';
});
const priorityModeTitle = computed(() => {
  if (graphStore.sortMode === 'frequency') return '高频排名';
  if (graphStore.sortMode === 'lowFrequency') return '低频排名';
  if (graphStore.sortMode === 'recent') return '活跃排名';
  return '';
});
const priorityRankRows = computed(() => {
  const tags = new Map<number, TagNode>((visibleGraph.value?.tags ?? []).map(tag => [tag.id, tag]));
  return graphStore.priorityTagIds
    .map((id, index) => {
      const tag = tags.get(id);
      return tag ? { rank: index + 1, tag } : null;
    })
    .filter((item): item is { rank: number; tag: TagNode } => Boolean(item));
});
const showPriorityRankPanel = computed(() => graphStore.sortMode !== 'layout' && priorityRankRows.value.length > 0);
const priorityRankTotal = computed(() => visibleGraph.value?.tags.length ?? 0);

onMounted(async () => {
  bindNebulaShortcuts();
  await mapsStore.fetchMaps();
  await ensureMapSelected();
  applyDrawerQuery();
  await applyFocusLogQuery();
});

onActivated(async () => {
  bindNebulaShortcuts();
  await ensureMapSelected();
  applyDrawerQuery();
  void applyFocusLogQuery();
});

onDeactivated(() => {
  unbindNebulaShortcuts();
});

onBeforeUnmount(() => {
  persistCurrentNebulaLayout();
  unbindNebulaShortcuts();
  if (focusPulseTimer !== null) {
    window.clearTimeout(focusPulseTimer);
    focusPulseTimer = null;
  }
});

watch(mapId, async (id, previousId) => {
  if (id && !isNaN(id)) {
    if (previousId && id !== previousId) {
      persistCurrentNebulaLayout();
      clearMapSelectionState();
    }
    await ensureMapSelected(id);
    applyDrawerQuery();
    await applyFocusLogQuery();
  }
});

watch(
  () => route.query.drawer,
  () => {
    applyDrawerQuery();
    void applyFocusLogQuery();
  }
);

watch(
  () => route.query.focusLog,
  () => {
    void applyFocusLogQuery();
  }
);

watch(
  () => [
    mapId.value,
    graphStore.timeFilter,
    graphStore.frequencyFilter,
    graphStore.customStartDate,
    graphStore.customEndDate,
    [...graphStore.activeTagIds].sort((a, b) => a - b).join(',')
  ],
  () => clearActiveLogCluster()
);

function toggleDrawer(tab: DrawerTab) {
  if (drawerTab.value === tab) {
    showDrawer.value = !showDrawer.value;
  } else {
    drawerTab.value = tab;
    showDrawer.value = true;
  }
  if (tab === 'logs' && showDrawer.value && selectedLogId.value !== null) {
    void scrollDrawerLogIntoView(selectedLogId.value);
  }
}

function closeDrawer() {
  showDrawer.value = false;
}

function persistCurrentNebulaLayout() {
  canvasRef.value?.saveCompleteLayout?.();
}

function clearMapSelectionState() {
  graphStore.clearActiveTags();
  graphStore.selectedLogId = null;
  graphStore.nebulaLogCard = null;
  graphStore.domainFocusTagIds = new Set();
  selectedLogId.value = null;
  activeClusterLogIds.value = null;
  focusPulseLogId.value = null;
  if (focusPulseTimer !== null) {
    window.clearTimeout(focusPulseTimer);
    focusPulseTimer = null;
  }
  ui.closeTagMenu();
}

function clearForeignMapSelectionState() {
  const graph = mapsStore.graph;
  if (!graph) {
    return;
  }
  const validTagIds = new Set(graph.tags.map((tag) => tag.id));
  const validLogIds = new Set(graph.logs.map((log) => log.id));
  const hasForeignTag = [...graphStore.activeTagIds].some((id) => !validTagIds.has(id));
  const hasForeignDomainFocus = [...graphStore.domainFocusTagIds].some((id) => !validTagIds.has(id));
  const hasForeignSelectedLog = selectedLogId.value !== null && !validLogIds.has(selectedLogId.value);
  const hasForeignStoreSelectedLog = graphStore.selectedLogId !== null && !validLogIds.has(graphStore.selectedLogId);
  const hasForeignCard = graphStore.nebulaLogCard !== null && !validLogIds.has(graphStore.nebulaLogCard.logId);
  const hasForeignTagMenu = ui.nebulaTagMenu !== null && !validTagIds.has(ui.nebulaTagMenu.tagId);
  if (
    hasForeignTag ||
    hasForeignDomainFocus ||
    hasForeignSelectedLog ||
    hasForeignStoreSelectedLog ||
    hasForeignCard ||
    hasForeignTagMenu
  ) {
    clearMapSelectionState();
  }
}

function switchMap(nextMapId: number) {
  if (!Number.isFinite(nextMapId) || nextMapId === mapId.value) {
    return;
  }
  persistCurrentNebulaLayout();
  clearMapSelectionState();
  router.push(`/maps/${nextMapId}`);
}

async function ensureMapSelected(id = mapId.value) {
  if (!id || Number.isNaN(id)) return;
  if (mapsStore.graph?.map.id && mapsStore.graph.map.id !== id) {
    clearMapSelectionState();
  }
  mapsStore.activeMapId = id;
  await mapsStore.selectMap(id);
  clearForeignMapSelectionState();
}

function applyDrawerQuery() {
  const drawer = route.query.drawer;
  if (typeof drawer !== 'string') return;
  if (!['tags', 'related', 'manage', 'insights', 'domains', 'maps', 'logs'].includes(drawer)) return;
  drawerTab.value = drawer as DrawerTab;
  showDrawer.value = true;
}

function handleTagToggle(tagId: number) {
  clearActiveLogCluster();
  graphStore.toggleTag(tagId);
}

function handleLogOpen(logId: number) {
  selectedLogId.value = selectedLogId.value === logId ? null : logId;
  graphStore.nebulaLogCard = null;
  if (selectedLogId.value !== null && showDrawer.value && drawerTab.value === 'logs') {
    void scrollDrawerLogIntoView(logId);
  }
}

function handleLogInspect(payload: { logId: number; x: number; y: number; width: number; height: number }) {
  selectedLogId.value = payload.logId;
  drawerTab.value = 'logs';
  showDrawer.value = true;
  const width = payload.width ?? window.innerWidth;
  const height = payload.height ?? window.innerHeight;
  const maxX = Math.max(16, width - 356);
  const maxY = Math.max(16, height - 300);
  graphStore.nebulaLogCard = {
    logId: payload.logId,
    x: Math.min(maxX, Math.max(16, payload.x + 16)),
    y: Math.min(maxY, Math.max(16, payload.y - 16)),
    width,
    height
  };
  void scrollDrawerLogIntoView(payload.logId);
}

function handleLogClusterOpen(payload: { logIds: number[]; x: number; y: number; width: number; height: number }) {
  activeClusterLogIds.value = new Set(payload.logIds);
  selectedLogId.value = null;
  graphStore.nebulaLogCard = null;
  drawerTab.value = 'logs';
  showDrawer.value = true;
  ui.showNotice(`已展开 ${payload.logIds.length} 条聚合日志`);
}

function clearActiveLogCluster() {
  activeClusterLogIds.value = null;
}

function focusLogFromDrawer(logId: number) {
  if (selectedLogId.value === logId) {
    selectedLogId.value = null;
    graphStore.nebulaLogCard = null;
    return;
  }
  selectedLogId.value = logId;
  graphStore.nebulaLogCard = null;
  canvasRef.value?.focusLog?.(logId);
  markLogFocus(logId);
  void scrollDrawerLogIntoView(logId);
}

function openLogFromDrawer(logId: number) {
  router.push({ path: `/maps/${mapId.value}/logs`, query: { selected: String(logId) } });
}

function handleLayoutDirty(dirty: boolean) {
  mapsStore.handleLayoutDirty(dirty);
}

function focusTag(tagId: number) {
  graphStore.focusTag(tagId);
  if (canvasRef.value?.focusTag) {
    canvasRef.value.focusTag(tagId);
  }
}

function addAndFocusRelatedTag(tagId: number) {
  if (!graphStore.activeTagIds.has(tagId)) {
    graphStore.toggleTag(tagId);
  }
  if (canvasRef.value?.focusTag) {
    canvasRef.value.focusTag(tagId);
  }
}

function updatePriorityDisplayLimit(event: Event) {
  const input = event.target as HTMLInputElement;
  graphStore.setNebulaPriorityDisplayLimit(Number(input.value));
}

function focusDomainCategory(cat: DomainCategory) {
  graphStore.focusDomainCategory(cat);
  if (canvasRef.value?.focusDomainCategory) {
    canvasRef.value.focusDomainCategory(cat);
  }
}

async function applyFocusLogQuery() {
  const drawer = Array.isArray(route.query.drawer) ? route.query.drawer[0] : route.query.drawer;
  if (drawer !== 'logs') return;
  const raw = Array.isArray(route.query.focusLog) ? route.query.focusLog[0] : route.query.focusLog;
  const logId = raw ? Number(raw) : NaN;
  if (!Number.isFinite(logId)) return;
  const visibleLog = graphStore.filteredLogs.find((item) => item.id === logId);
  const log = visibleLog ?? mapsStore.graph?.logs.find((item) => item.id === logId);
  if (!log) return;
  clearActiveLogCluster();
  drawerTab.value = 'logs';
  showDrawer.value = true;
  if (!visibleLog) {
    selectedLogId.value = null;
    graphStore.nebulaLogCard = null;
    ui.showNotice('该日志不在当前筛选范围内');
    return;
  }
  selectedLogId.value = log.id;
  graphStore.nebulaLogCard = null;
  await nextTick();
  focusLogAndOpenCard(log.id);
  markLogFocus(log.id);
  await scrollDrawerLogIntoView(log.id);
}

function focusLogAndOpenCard(logId: number) {
  const payload = canvasRef.value?.focusLog?.(logId);
  if (payload) {
    handleLogInspect(payload);
    return;
  }
  window.setTimeout(() => {
    if (selectedLogId.value !== logId) return;
    const retryPayload = canvasRef.value?.focusLog?.(logId);
    if (retryPayload) {
      handleLogInspect(retryPayload);
    }
  }, 180);
}

async function scrollDrawerLogIntoView(logId: number) {
  await nextTick();
  const item = document.querySelector<HTMLElement>(`[data-drawer-log-id="${logId}"]`);
  item?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function markLogFocus(logId: number) {
  focusPulseLogId.value = logId;
  if (focusPulseTimer !== null) {
    window.clearTimeout(focusPulseTimer);
  }
  focusPulseTimer = window.setTimeout(() => {
    if (focusPulseLogId.value === logId) {
      focusPulseLogId.value = null;
    }
    focusPulseTimer = null;
  }, 1800);
}

function bindNebulaShortcuts() {
  if (shortcutsBound) return;
  window.addEventListener('keydown', handleNebulaShortcut);
  shortcutsBound = true;
}

function unbindNebulaShortcuts() {
  if (!shortcutsBound) return;
  window.removeEventListener('keydown', handleNebulaShortcut);
  shortcutsBound = false;
}

function refreshNebulaView() {
  canvasRef.value?.refreshLayout?.();
}

function saveNebulaLayout() {
  const saved = canvasRef.value?.saveLayout?.() ?? false;
  if (saved) ui.showNotice('星云布局已保存');
  else ui.showNotice('当前没有可保存的星云布局');
}

async function undoNebulaLayout() {
  if (await ui.undoDeleteAction()) return;
  const undone = canvasRef.value?.undoLayout?.() ?? false;
  if (undone) mapsStore.layoutDirty = true;
  ui.showNotice(undone ? '已撤销上一次星云布局调整' : '没有可撤销的星云布局调整');
}

async function redoNebulaLayout() {
  if (await ui.redoDeleteAction()) return;
  const redone = canvasRef.value?.redoLayout?.() ?? false;
  if (redone) mapsStore.layoutDirty = true;
  ui.showNotice(redone ? '已重做上一次星云布局调整' : '没有可重做的星云布局调整');
}

function resetAiLayout() {
  canvasRef.value?.resetTagLayout?.();
}

function fitAllTags() {
  canvasRef.value?.fitAllTags?.();
}

function requestDeleteMap(map: NebulaMap) {
  ui.showConfirm(
    '删除星云图',
    `确定删除「${map.name}」吗？里面的日志、标签、领域大类都会一起删除。`,
    '删除',
    async () => {
      await mapsStore.removeMap(map.id);
      if (mapsStore.maps.length > 0) {
        router.push(`/maps/${mapsStore.maps[0].id}`);
      } else {
        router.push('/');
      }
      ui.showNotice('星云图已删除');
    }
  );
}

function requestNewMapDetails() {
  const name = window.prompt('星图名称', '未命名星图')?.trim();
  if (!name) {
    return null;
  }
  const description = window.prompt('星图描述（可选）', '')?.trim() ?? '';
  return { name, description };
}

async function createAndEnter() {
  const draft = requestNewMapDetails();
  if (!draft) {
    return;
  }
  const map = await mapsStore.addMap(draft.name, draft.description);
  router.push(`/maps/${map.id}`);
}

// --- Overlay helpers ---
async function confirmNebulaAction() {
  const dialog = ui.nebulaConfirm;
  if (!dialog || dialog.pending) return;
  dialog.pending = true;
  try {
    await dialog.onConfirm();
    ui.closeConfirm();
  } catch {
    dialog.pending = false;
  }
}

function closeNebulaCard() {
  graphStore.nebulaLogCard = null;
  selectedLogId.value = null;
}

function startEditLog(logId: number) {
  router.push({ path: `/maps/${mapId.value}/logs`, query: { edit: String(logId) } });
}

function exportLog(logId: number) {
  const log = mapsStore.graph?.logs.find(l => l.id === logId);
  if (!log) return;
  const md = [
    `# ${log.title}`,
    '',
    `创建时间：${formatDate(log.createdAt)}`,
    `标签：${log.tags.map(t => `#${t.name}`).join(' ')}`,
    '',
    log.content
  ].join('\n');
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${log.title || '日志'}.md`;
  a.click();
  URL.revokeObjectURL(url);
  ui.showNotice('已导出 Markdown');
}

async function removeLog(logId: number) {
  const log = mapsStore.graph?.logs.find(l => l.id === logId);
  if (!log) return;
  ui.showConfirm(
    '删除日志',
    `确认删除「${log.title}」吗？删除后可以用撤销恢复。`,
    '删除',
    async () => {
      const snapshot: LogEntry = { ...log, tags: log.tags.map(t => ({ ...t })) };
      await deleteLog(log.id);
      ui.pushDeleteHistory({ kind: 'log', log: snapshot });
      if (selectedLogId.value === log.id) selectedLogId.value = null;
      closeNebulaCard();
      await mapsStore.refreshData();
      ui.showNotice('日志已删除，可撤销');
    }
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function handleNebulaShortcut(event: KeyboardEvent) {
  if (!mapsStore.graph || isTextInput(event.target)) return;
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
  if (event.key === 'Escape') {
    if (ui.nebulaConfirm) { ui.closeConfirm(); return; }
    if (ui.nebulaTagMenu) { ui.closeTagMenu(); return; }
    if (graphStore.nebulaLogCard) { graphStore.nebulaLogCard = null; return; }
    if (showDrawer.value) { showDrawer.value = false; return; }
  }
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

const layoutAiStatus = computed(() => {
  if (!mapsStore.graph?.aiMeta?.tagRelations) {
    return { label: '本地', title: '使用本地布局算法' };
  }
  const meta = mapsStore.graph.aiMeta.tagRelations;
  if (meta.source === 'deepseek') return { label: 'AI 布局', title: 'DeepSeek AI 语义布局' };
  if (meta.source === 'cache') return { label: '缓存布局', title: '使用缓存的 AI 布局' };
  return { label: '本地', title: '使用本地布局算法' };
});
</script>

<template>
  <div class="map-page">
    <!-- Top toolbar -->
    <header class="map-toolbar">
      <div class="toolbar-left">
        <button class="icon-button" title="返回首页" @click="router.push('/')">
          <ChevronLeft :size="18" />
        </button>
        <div class="toolbar-title">
          <h2>{{ mapsStore.graph?.map.name ?? '加载中...' }}</h2>
          <span v-if="mapsStore.layoutDirty" class="dirty-mark">* 已修改</span>
        </div>
      </div>

      <div class="toolbar-center">
        <div class="filter-group">
          <button :class="{ active: graphStore.timeFilter === 'all' }" @click="graphStore.setTimeFilter('all')">全部</button>
          <button :class="{ active: graphStore.timeFilter === 'week' }" @click="graphStore.setTimeFilter('week')">7天</button>
          <button :class="{ active: graphStore.timeFilter === 'month' }" @click="graphStore.setTimeFilter('month')">30天</button>
          <button :class="{ active: graphStore.timeFilter === 'quarter' }" @click="graphStore.setTimeFilter('quarter')">90天</button>
          <button :class="{ active: graphStore.timeFilter === 'custom' }" @click="graphStore.setTimeFilter('custom')">自定义</button>
        </div>
        <div v-if="graphStore.timeFilter === 'custom'" class="date-row">
          <input v-model="graphStore.customStartDate" type="date" @change="graphStore.persistToLocalStorage()" />
          <span>至</span>
          <input v-model="graphStore.customEndDate" type="date" @change="graphStore.persistToLocalStorage()" />
        </div>
        <div class="filter-group">
          <button :class="{ active: graphStore.frequencyFilter === 'all' }" @click="graphStore.setFrequencyFilter('all')">全部频率</button>
          <button :class="{ active: graphStore.frequencyFilter === 'high' }" @click="graphStore.setFrequencyFilter('high')">高频</button>
          <button :class="{ active: graphStore.frequencyFilter === 'low' }" @click="graphStore.setFrequencyFilter('low')">低频</button>
        </div>
        <div class="filter-group">
          <button :class="{ active: graphStore.sortMode === 'layout' }" @click="graphStore.setSortMode('layout')">布局</button>
          <button :class="{ active: graphStore.sortMode === 'frequency' }" @click="graphStore.setSortMode('frequency')">高频优先</button>
          <button :class="{ active: graphStore.sortMode === 'lowFrequency' }" @click="graphStore.setSortMode('lowFrequency')">低频优先</button>
          <button :class="{ active: graphStore.sortMode === 'recent' }" @click="graphStore.setSortMode('recent')">最近活跃</button>
        </div>
        <span class="stat-badge">{{ graphStore.stats.tags }} 标签</span>
        <span class="stat-badge">{{ graphStore.stats.logs }} 日志</span>
        <span class="stat-badge highlight">{{ graphStore.stats.filtered }} 命中</span>
        <span class="stat-badge ai-badge" :title="layoutAiStatus.title">{{ layoutAiStatus.label }}</span>
      </div>

      <div class="toolbar-right">
        <button class="icon-button" title="刷新" @click="refreshNebulaView"><RefreshCw :size="16" /></button>
        <button class="icon-button" title="重置AI布局" @click="resetAiLayout"><RotateCcw :size="16" /></button>
        <button class="icon-button" title="保存布局" @click="saveNebulaLayout"><Save :size="16" /></button>
        <button class="icon-button" title="撤销" @click="undoNebulaLayout"><Undo2 :size="16" /></button>
        <button class="icon-button" title="重做" @click="redoNebulaLayout"><Redo2 :size="16" /></button>
        <button class="primary-button sm" @click="router.push({ path: `/maps/${mapId}/logs`, query: { new: '1' } })">
          <FilePlus2 :size="15" />
          新日志
        </button>
        <button class="icon-button" title="日志定位" @click="toggleDrawer('logs')"><FileText :size="16" /></button>
        <button class="icon-button" title="星图列表" @click="toggleDrawer('maps')"><MapIcon :size="16" /></button>
        <button class="icon-button" title="标签" @click="toggleDrawer('tags')"><Tags :size="16" /></button>
        <button class="icon-button" title="管理" @click="toggleDrawer('manage')"><SlidersHorizontal :size="16" /></button>
        <button class="icon-button" title="领域大类" @click="toggleDrawer('domains')"><FolderTree :size="16" /></button>
        <button class="icon-button" title="洞察" @click="toggleDrawer('insights')"><List :size="16" /></button>
      </div>
    </header>

    <!-- Canvas area -->
    <div class="canvas-area">
      <NebulaCanvas
        v-if="visibleGraph && auth.rendererMode === 'canvas'"
        :key="`canvas-${mapId}-${mapsStore.nebulaRenderKey}`"
        ref="canvasRef"
        :graph="visibleGraph"
        :layout-mode="auth.layoutMode"
        :active-tag-ids="graphStore.activeTagIds"
        :selected-log-id="selectedLogId"
        :focus-pulse-log-id="focusPulseLogId"
        :priority-tag-ids="graphStore.priorityTagIds"
        :priority-display-limit="graphStore.nebulaPriorityDisplayLimit"
        :log-clustering-enabled="graphStore.nebulaLogDensityMode === 'auto'"
        :active-cluster-log-ids="activeClusterLogIds"
        :domain-focus-tag-ids="graphStore.domainFocusTagIds"
        @tag-toggle="handleTagToggle"
        @tag-context="(p: any) => ui.openTagMenu(p.tagId, p.x, p.y, p.width, p.height)"
        @log-open="handleLogOpen"
        @log-inspect="handleLogInspect"
        @log-cluster-open="handleLogClusterOpen"
        @layout-dirty="handleLayoutDirty"
      >
        <template #overlay>
          <div v-if="ui.nebulaConfirm" class="nebula-confirm-card" role="dialog" aria-modal="true">
            <p class="nebula-confirm-eyebrow">{{ ui.nebulaConfirm.title }}</p>
            <p class="nebula-confirm-message">{{ ui.nebulaConfirm.message }}</p>
            <div class="nebula-confirm-actions">
              <button class="secondary-button" type="button" :disabled="ui.nebulaConfirm.pending" @click="ui.closeConfirm">取消</button>
              <button class="danger-confirm" type="button" :disabled="ui.nebulaConfirm.pending" @click="confirmNebulaAction">
                {{ ui.nebulaConfirm.pending ? '处理中' : ui.nebulaConfirm.confirmLabel }}
              </button>
            </div>
          </div>
          <div
            v-if="ui.nebulaTagMenu && graphStore.nebulaTagMenuTag"
            class="nebula-tag-menu"
            :style="{ left: `${ui.nebulaTagMenu.x}px`, top: `${ui.nebulaTagMenu.y}px` }"
            @click.stop @pointerdown.stop @pointerup.stop @contextmenu.prevent.stop
          >
            <div class="nebula-tag-menu-head">
              <span>标签操作</span>
              <button class="icon-button" title="关闭" @click="ui.closeTagMenu"><X :size="14" /></button>
            </div>
            <template v-if="ui.nebulaTagMenu.mode === 'menu'">
              <div class="nebula-tag-menu-preview">
                <span class="tag-dot" :style="{ backgroundColor: graphStore.nebulaTagMenuTag.color }"></span>
                <strong>{{ graphStore.nebulaTagMenuTag.name }}</strong>
                <small>{{ graphStore.nebulaTagMenuTag.count }} 篇</small>
              </div>
              <button class="secondary-button wide" @click="ui.startTagEdit(graphStore.nebulaTagMenuTag.id, graphStore.nebulaTagMenuTag.name, graphStore.nebulaTagMenuTag.color)">
                <Edit3 :size="15" />编辑标签
              </button>
              <button class="danger-context-button wide" @click="ui.deleteContextTag()">
                <Trash2 :size="15" />删除标签
              </button>
            </template>
            <form v-else class="nebula-tag-edit-form" @submit.prevent="ui.saveContextTagEdit()">
              <label><span>名称</span><input v-model="ui.tagEditName" data-nebula-tag-edit-name /></label>
              <label><span>颜色</span><input v-model="ui.tagEditColor" class="color-input" type="color" /></label>
              <div class="nebula-tag-menu-actions">
                <button class="secondary-button" type="button" @click="ui.closeTagMenu()">取消</button>
                <button class="primary-button" :disabled="ui.tagEditSaving || !ui.tagEditName.trim()">
                  {{ ui.tagEditSaving ? '保存中' : '保存' }}
                </button>
              </div>
            </form>
          </div>
          <div
            v-if="graphStore.nebulaCardLog"
            class="nebula-log-card"
            :style="{
              left: `${graphStore.nebulaCardLog.x}px`,
              top: `${graphStore.nebulaCardLog.y}px`,
              '--card-accent': graphStore.nebulaCardLog.log.tags[0]?.color || 'var(--accent-primary)'
            }"
            @click.stop @pointerdown.stop @pointerup.stop
          >
            <div class="nebula-log-card-head">
              <div class="nebula-log-card-eyebrow">
                <span>日志星卡</span>
                <small>{{ formatDate(graphStore.nebulaCardLog.log.createdAt) }}</small>
              </div>
              <button class="icon-button" title="关闭" @click.stop="closeNebulaCard"><X :size="14" /></button>
            </div>
            <div class="nebula-log-card-title-row">
              <h3>{{ graphStore.nebulaCardLog.log.title || '无标题' }}</h3>
              <span>{{ graphStore.nebulaCardLog.log.tags.length }} 标签</span>
            </div>
            <p class="nebula-log-card-content">{{ graphStore.nebulaCardLog.log.content }}</p>
            <div class="chip-list nebula-log-card-tags">
              <button
                v-for="tag in graphStore.nebulaCardLog.log.tags"
                :key="tag.id" class="chip"
                :style="{ borderColor: tag.color }"
                @click.stop="focusTag(tag.id)"
              >
                {{ tag.name }}
              </button>
            </div>
            <div class="nebula-log-card-actions">
              <button class="nebula-log-card-detail" title="查看详情" @click.stop="openLogFromDrawer(graphStore.nebulaCardLog.log.id)">
                <FileText :size="15" />
                <span>阅读详情</span>
              </button>
              <div class="nebula-log-card-icon-row">
                <button class="icon-button" title="编辑" @click.stop="startEditLog(graphStore.nebulaCardLog.log.id)"><Edit3 :size="15" /></button>
                <button class="icon-button" title="导出 Markdown" @click.stop="exportLog(graphStore.nebulaCardLog.log.id)"><Download :size="15" /></button>
                <button class="icon-button danger" title="删除" @click.stop="removeLog(graphStore.nebulaCardLog.log.id)"><Trash2 :size="15" /></button>
              </div>
            </div>
          </div>
        </template>
      </NebulaCanvas>
      <WebGpuNebulaCanvas
        v-else-if="visibleGraph"
        :key="`webgpu-${mapId}-${graphStore.timeFilter}-${graphStore.frequencyFilter}-${mapsStore.nebulaRenderKey}`"
        ref="canvasRef"
        :graph="visibleGraph"
        :layout-mode="auth.layoutMode"
        :active-tag-ids="graphStore.activeTagIds"
        :selected-log-id="selectedLogId"
        :focus-pulse-log-id="focusPulseLogId"
        :priority-tag-ids="graphStore.priorityTagIds"
        :priority-display-limit="graphStore.nebulaPriorityDisplayLimit"
        :heat-window-days="graphStore.nebulaHeatWindowDays"
        :heat-minimum-delta="graphStore.nebulaHeatMinimumDelta"
        :heat-medium-delta="graphStore.nebulaHeatMediumDelta"
        :heat-strong-delta="graphStore.nebulaHeatStrongDelta"
        :heat-flat-opacity="graphStore.nebulaHeatFlatOpacity"
        :log-clustering-enabled="graphStore.nebulaLogDensityMode === 'auto'"
        :active-cluster-log-ids="activeClusterLogIds"
        :domain-focus-tag-ids="graphStore.domainFocusTagIds"
        @tag-toggle="handleTagToggle"
        @tag-context="(p: any) => ui.openTagMenu(p.tagId, p.x, p.y, p.width, p.height)"
        @log-open="handleLogOpen"
        @log-inspect="handleLogInspect"
        @log-cluster-open="handleLogClusterOpen"
        @layout-dirty="handleLayoutDirty"
      >
        <template #overlay>
          <div v-if="ui.nebulaConfirm" class="nebula-confirm-card" role="dialog" aria-modal="true">
            <p class="nebula-confirm-eyebrow">{{ ui.nebulaConfirm.title }}</p>
            <p class="nebula-confirm-message">{{ ui.nebulaConfirm.message }}</p>
            <div class="nebula-confirm-actions">
              <button class="secondary-button" type="button" :disabled="ui.nebulaConfirm.pending" @click="ui.closeConfirm">取消</button>
              <button class="danger-confirm" type="button" :disabled="ui.nebulaConfirm.pending" @click="confirmNebulaAction">
                {{ ui.nebulaConfirm.pending ? '处理中' : ui.nebulaConfirm.confirmLabel }}
              </button>
            </div>
          </div>
          <div
            v-if="ui.nebulaTagMenu && graphStore.nebulaTagMenuTag"
            class="nebula-tag-menu"
            :style="{ left: `${ui.nebulaTagMenu.x}px`, top: `${ui.nebulaTagMenu.y}px` }"
            @click.stop @pointerdown.stop @pointerup.stop @contextmenu.prevent.stop
          >
            <div class="nebula-tag-menu-head">
              <span>标签操作</span>
              <button class="icon-button" title="关闭" @click="ui.closeTagMenu"><X :size="14" /></button>
            </div>
            <template v-if="ui.nebulaTagMenu.mode === 'menu'">
              <div class="nebula-tag-menu-preview">
                <span class="tag-dot" :style="{ backgroundColor: graphStore.nebulaTagMenuTag.color }"></span>
                <strong>{{ graphStore.nebulaTagMenuTag.name }}</strong>
                <small>{{ graphStore.nebulaTagMenuTag.count }} 篇</small>
              </div>
              <button class="secondary-button wide" @click="ui.startTagEdit(graphStore.nebulaTagMenuTag.id, graphStore.nebulaTagMenuTag.name, graphStore.nebulaTagMenuTag.color)">
                <Edit3 :size="15" />编辑标签
              </button>
              <button class="danger-context-button wide" @click="ui.deleteContextTag()">
                <Trash2 :size="15" />删除标签
              </button>
            </template>
            <form v-else class="nebula-tag-edit-form" @submit.prevent="ui.saveContextTagEdit()">
              <label><span>名称</span><input v-model="ui.tagEditName" data-nebula-tag-edit-name /></label>
              <label><span>颜色</span><input v-model="ui.tagEditColor" class="color-input" type="color" /></label>
              <div class="nebula-tag-menu-actions">
                <button class="secondary-button" type="button" @click="ui.closeTagMenu()">取消</button>
                <button class="primary-button" :disabled="ui.tagEditSaving || !ui.tagEditName.trim()">
                  {{ ui.tagEditSaving ? '保存中' : '保存' }}
                </button>
              </div>
            </form>
          </div>
          <div
            v-if="graphStore.nebulaCardLog"
            class="nebula-log-card"
            :style="{
              left: `${graphStore.nebulaCardLog.x}px`,
              top: `${graphStore.nebulaCardLog.y}px`,
              '--card-accent': graphStore.nebulaCardLog.log.tags[0]?.color || 'var(--accent-primary)'
            }"
            @click.stop @pointerdown.stop @pointerup.stop
          >
            <div class="nebula-log-card-head">
              <div class="nebula-log-card-eyebrow">
                <span>日志星卡</span>
                <small>{{ formatDate(graphStore.nebulaCardLog.log.createdAt) }}</small>
              </div>
              <button class="icon-button" title="关闭" @click.stop="closeNebulaCard"><X :size="14" /></button>
            </div>
            <div class="nebula-log-card-title-row">
              <h3>{{ graphStore.nebulaCardLog.log.title || '无标题' }}</h3>
              <span>{{ graphStore.nebulaCardLog.log.tags.length }} 标签</span>
            </div>
            <p class="nebula-log-card-content">{{ graphStore.nebulaCardLog.log.content }}</p>
            <div class="chip-list nebula-log-card-tags">
              <button
                v-for="tag in graphStore.nebulaCardLog.log.tags"
                :key="tag.id" class="chip"
                :style="{ borderColor: tag.color }"
                @click.stop="focusTag(tag.id)"
              >
                {{ tag.name }}
              </button>
            </div>
            <div class="nebula-log-card-actions">
              <button class="nebula-log-card-detail" title="查看详情" @click.stop="openLogFromDrawer(graphStore.nebulaCardLog.log.id)">
                <FileText :size="15" />
                <span>阅读详情</span>
              </button>
              <div class="nebula-log-card-icon-row">
                <button class="icon-button" title="编辑" @click.stop="startEditLog(graphStore.nebulaCardLog.log.id)"><Edit3 :size="15" /></button>
                <button class="icon-button" title="导出 Markdown" @click.stop="exportLog(graphStore.nebulaCardLog.log.id)"><Download :size="15" /></button>
                <button class="icon-button danger" title="删除" @click.stop="removeLog(graphStore.nebulaCardLog.log.id)"><Trash2 :size="15" /></button>
              </div>
            </div>
          </div>
        </template>
      </WebGpuNebulaCanvas>
      <div v-else class="canvas-placeholder">
        <p v-if="mapsStore.loading">加载中...</p>
        <p v-else-if="mapsStore.error">{{ mapsStore.error }}</p>
        <p v-else>选择一个星图开始探索</p>
      </div>
      <aside
        v-if="showPriorityRankPanel"
        class="priority-rank-panel"
        aria-label="星云标签排行"
        @click.stop
        @pointerdown.stop
        @wheel.stop
      >
        <div class="priority-rank-head">
          <div class="priority-rank-title">
            <button class="priority-rank-back" title="回到布局模式" @click="graphStore.setSortMode('layout')">
              <ChevronLeft :size="14" />
            </button>
            <h3>{{ priorityModeTitle }}</h3>
          </div>
          <span>全部 {{ priorityRankTotal }}</span>
        </div>
        <label class="priority-rank-control">
          <span>星云标记 {{ graphStore.nebulaPriorityDisplayLimit }} 个</span>
          <input
            type="range"
            min="0"
            max="30"
            :value="graphStore.nebulaPriorityDisplayLimit"
            @input="updatePriorityDisplayLimit"
          />
        </label>
        <div class="priority-rank-list">
          <button
            v-for="row in priorityRankRows"
            :key="row.tag.id"
            class="priority-rank-item"
            :class="{ marked: row.rank <= graphStore.nebulaPriorityDisplayLimit }"
            @click="focusTag(row.tag.id)"
          >
            <span class="priority-rank-index">#{{ row.rank }}</span>
            <span class="priority-rank-dot" :style="{ backgroundColor: row.tag.color, boxShadow: `0 0 12px ${row.tag.color}` }"></span>
            <span class="priority-rank-name">{{ row.tag.name }}</span>
            <span class="priority-rank-count">{{ row.tag.count }}</span>
          </button>
        </div>
      </aside>
    </div>

    <!-- Drawer overlay -->
    <transition name="drawer-slide">
      <aside v-if="showDrawer" class="drawer">
        <div class="drawer-head">
          <span>
            {{ drawerTitle }}
          </span>
          <button class="icon-button" @click="closeDrawer"><X :size="16" /></button>
        </div>
        <div class="drawer-body">
          <template v-if="drawerTab === 'tags'">
            <div v-if="graphStore.activeTags.length" class="chip-list">
              <button
                v-for="tag in graphStore.activeTags"
                :key="tag.id"
                class="chip active"
                :style="{ borderColor: tag.color }"
                @click="graphStore.toggleTag(tag.id)"
              >
                {{ tag.name }}
              </button>
            </div>
            <p v-else class="muted">点击星云中的恒星激活标签</p>
            <button v-if="graphStore.activeTags.length" class="text-button" @click="graphStore.clearActiveTags()">清空全部</button>

            <!-- Related tags -->
            <div v-if="graphStore.activeTags.length && graphStore.relatedTags.length" class="drawer-section">
              <h4>相关标签</h4>
              <button
                v-for="item in graphStore.relatedTags"
                :key="item.tag.id"
                class="related-item"
                @click="addAndFocusRelatedTag(item.tag.id)"
              >
                <span class="tag-dot" :style="{ backgroundColor: item.tag.color }" />
                <span>{{ item.tag.name }}</span>
                <small>{{ item.count }}</small>
              </button>
              <div v-if="graphStore.relatedCanPaginate && graphStore.relatedTotalPages > 1" class="related-pager">
                <button class="icon-button" :disabled="graphStore.relatedPage === 0" @click="graphStore.relatedPage = Math.max(0, graphStore.relatedPage - 1)">
                  <ChevronLeft :size="15" />
                </button>
                <span>{{ graphStore.relatedPageLabel }}</span>
                <button class="icon-button" :disabled="graphStore.relatedPage >= graphStore.relatedTotalPages - 1" @click="graphStore.relatedPage = Math.min(graphStore.relatedTotalPages - 1, graphStore.relatedPage + 1)">
                  <ChevronRight :size="15" />
                </button>
              </div>
            </div>
            <p v-else-if="graphStore.activeTags.length" class="muted drawer-hint">当前筛选下暂无相关标签</p>
          </template>

          <template v-if="drawerTab === 'manage' && mapId">
            <TagManager
              :map-id="mapId"
              :tags="mapsStore.graph?.tags ?? []"
              @changed="mapsStore.refreshData"
              @focus="focusTag"
            />
          </template>

          <template v-if="drawerTab === 'domains' && mapId">
            <DomainCategoryManager
              :map-id="mapId"
              :domain-categories="mapsStore.graph?.domainCategories ?? []"
              @changed="mapsStore.refreshData"
              @focus="focusDomainCategory"
            />
          </template>

          <template v-if="drawerTab === 'maps'">
            <div class="drawer-section">
              <h4>星云图</h4>
              <button class="text-button" @click="createAndEnter()">
                <Plus :size="15" />新建
              </button>
            </div>
            <div v-for="map in mapsStore.maps" :key="map.id" class="drawer-map-row">
              <form
                v-if="mapsStore.renamingMapId === map.id && mapsStore.renameLocation === 'list'"
                class="map-rename-form"
                @submit.prevent="mapsStore.saveRenameMap(map.id)"
              >
                <div class="map-rename-fields">
                  <input v-model="mapsStore.renameDraft" placeholder="星图名称" @keydown.escape.prevent="mapsStore.cancelRenameMap()" />
                  <input
                    v-model="mapsStore.renameDescriptionDraft"
                    placeholder="星图描述（可选）"
                    @keydown.escape.prevent="mapsStore.cancelRenameMap()"
                  />
                </div>
                <div class="map-rename-actions">
                  <button class="icon-button" :disabled="mapsStore.renameSaving"><Check :size="15" /></button>
                  <button class="icon-button" type="button" @click="mapsStore.cancelRenameMap"><X :size="15" /></button>
                </div>
              </form>
              <template v-else>
                <button class="drawer-map-item" :class="{ active: map.id === mapId }" @click="switchMap(map.id)">
                  <span>{{ map.name }}</span>
                </button>
                <button class="icon-button sm" title="重命名" @click="mapsStore.startRenameMap(map.id, 'list')"><Edit3 :size="14" /></button>
                <button class="icon-button sm danger" title="删除" @click="requestDeleteMap(map)"><Trash2 :size="14" /></button>
              </template>
            </div>
          </template>

          <template v-if="drawerTab === 'logs' && mapId">
            <div class="drawer-section compact">
              <h4>日志定位</h4>
              <p class="muted drawer-hint">显示当前筛选命中的日志，点击后会在星云图中定位并打开详情。</p>
              <div v-if="activeClusterLogIds" class="cluster-drawer-filter">
                <span>当前展开日志簇：{{ activeClusterCount }} 条</span>
                <button type="button" @click="clearActiveLogCluster">显示全部筛选日志</button>
              </div>
            </div>
            <div v-if="drawerLogs.length" class="drawer-log-list">
              <div
                v-for="log in drawerLogs"
                :key="log.id"
                role="button"
                tabindex="0"
                :data-drawer-log-id="log.id"
                class="drawer-log-item"
                :class="{ active: selectedLogId === log.id, pulse: focusPulseLogId === log.id }"
                @click="focusLogFromDrawer(log.id)"
                @keydown.enter.prevent="focusLogFromDrawer(log.id)"
                @keydown.space.prevent="focusLogFromDrawer(log.id)"
              >
                <span class="drawer-log-title">{{ log.title || '无标题' }}</span>
                <span class="drawer-log-meta">{{ formatDate(log.updatedAt || log.createdAt) }}</span>
                <span class="drawer-log-tags">
                  <i
                    v-for="tag in log.tags.slice(0, 4)"
                    :key="tag.id"
                    :style="{ borderColor: tag.color, color: tag.color }"
                  >
                    {{ tag.name }}
                  </i>
                  <small v-if="log.tags.length > 4">+{{ log.tags.length - 4 }}</small>
                </span>
                <span class="drawer-log-actions" @click.stop>
                  <button type="button" @click="openLogFromDrawer(log.id)">
                    <FileText :size="12" />
                    详情
                  </button>
                </span>
              </div>
            </div>
            <p v-else class="muted">当前筛选下暂无日志</p>
          </template>

          <template v-if="drawerTab === 'insights' && mapId">
            <InsightPanel
              :insight="mapsStore.insights"
              :advice-loading="ui.adviceLoading"
              @generate-advice="() => router.push(`/maps/${mapId}/insights`)"
            />
          </template>
        </div>
      </aside>
    </transition>
  </div>
</template>

<style scoped>
.map-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

.map-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: color-mix(in srgb, var(--panel-bg-strong) 90%, transparent);
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
  z-index: 10;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toolbar-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-title h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  white-space: nowrap;
}

.dirty-mark {
  font-size: 11px;
  color: var(--warning);
}

.toolbar-center {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  justify-content: center;
}

.filter-group {
  display: flex;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--control-border);
}

.filter-group button {
  padding: 5px 12px;
  font-size: 12px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-right: 1px solid var(--control-border);
}

.filter-group button:last-child { border-right: none; }

.filter-group button.active {
  background: var(--control-active-bg);
  color: var(--accent-primary);
}

.stat-badge {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 20px;
  background: var(--control-bg);
  color: var(--text-muted);
}

.ai-badge {
  color: var(--accent-secondary);
  background: color-mix(in srgb, var(--accent-secondary) 12%, transparent);
}

.stat-badge.highlight {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
}

.date-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.date-row input {
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  color: var(--text-strong);
  font-size: 12px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.primary-button.sm {
  padding: 6px 14px;
  border-radius: 8px;
  background: var(--accent-primary);
  color: var(--app-bg);
  font-weight: 600;
  font-size: 13px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}

.primary-button.sm:hover {
  background: color-mix(in srgb, var(--accent-primary) 84%, white 8%);
}

.icon-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.icon-button:hover {
  color: var(--text-strong);
  background: var(--control-bg);
}

.canvas-area {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: radial-gradient(ellipse at center, color-mix(in srgb, var(--accent-primary) 12%, transparent) 0%, var(--canvas-bg) 70%);
}

.canvas-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: color-mix(in srgb, var(--text-muted) 42%, transparent);
  font-size: 16px;
}

.priority-rank-panel {
  position: absolute;
  left: 16px;
  top: 16px;
  z-index: 12;
  display: flex;
  width: min(270px, calc(100% - 32px));
  max-height: min(430px, calc(100% - 32px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--panel-border);
  border-radius: 14px;
  background:
    radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--accent-primary) 12%, transparent), transparent 42%),
    color-mix(in srgb, var(--panel-bg-strong) 92%, transparent);
  box-shadow:
    0 18px 46px rgba(0, 0, 0, 0.28),
    inset 0 0 0 1px color-mix(in srgb, var(--text-strong) 3%, transparent);
  backdrop-filter: blur(18px);
}

.priority-rank-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--panel-border);
}

.priority-rank-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.priority-rank-title h3 {
  overflow: hidden;
  margin: 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.priority-rank-head > span {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.priority-rank-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}

.priority-rank-back:hover {
  background: var(--control-bg);
  color: var(--text-strong);
}

.priority-rank-control {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 9px 12px 10px;
  color: var(--text-muted);
  font-size: 11px;
}

.priority-rank-control input {
  min-width: 0;
  accent-color: var(--accent-primary);
}

.priority-rank-list {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  padding: 0 8px 8px;
  scrollbar-color: color-mix(in srgb, var(--accent-primary) 34%, transparent) transparent;
  scrollbar-width: thin;
}

.priority-rank-list::-webkit-scrollbar {
  width: 8px;
}

.priority-rank-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent-primary) 28%, transparent);
}

.priority-rank-list::-webkit-scrollbar-track {
  background: transparent;
}

.priority-rank-item {
  display: grid;
  grid-template-columns: 40px 14px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: color-mix(in srgb, var(--control-bg) 64%, transparent);
  color: var(--text-strong);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;
}

.priority-rank-item:hover,
.priority-rank-item:focus-visible {
  transform: translateX(2px);
  border-color: color-mix(in srgb, var(--accent-primary) 26%, transparent);
  background: color-mix(in srgb, var(--accent-primary) 10%, var(--control-bg));
  outline: none;
}

.priority-rank-item.marked {
  border-color: color-mix(in srgb, var(--accent-primary) 18%, transparent);
}

.priority-rank-index {
  color: var(--accent-primary);
  font-size: 12px;
  font-weight: 800;
}

.priority-rank-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
}

.priority-rank-name {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.priority-rank-count {
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* Drawer */
.drawer {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 340px;
  background: var(--panel-bg-strong);
  border-left: 1px solid var(--panel-border);
  backdrop-filter: blur(16px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--panel-border);
  font-size: 14px;
  font-weight: 600;
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px;
}

.drawer-body :deep(.tag-manager-panel),
.drawer-body :deep(.domain-manager-panel),
.drawer-body :deep(.tag-manage-list),
.drawer-body :deep(.domain-category-list) {
  max-height: none;
  overflow: visible;
}

.drawer-section {
  margin-top: 20px;
}

.drawer-section.compact {
  margin-top: 0;
}

.cluster-drawer-filter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 24%, var(--control-border));
  color: var(--text-strong);
  font-size: 12px;
}

.cluster-drawer-filter button {
  border: 0;
  padding: 4px 8px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
  color: var(--accent-primary);
  font-size: 12px;
  cursor: pointer;
}

.cluster-drawer-filter button:hover {
  background: color-mix(in srgb, var(--accent-primary) 30%, transparent);
}

.drawer-section h4 {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.drawer-log-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.drawer-log-item {
  width: 100%;
  padding: 11px 12px;
  border-radius: 11px;
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--panel-bg) 54%, transparent);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s, transform 0.16s;
}

.drawer-log-item:hover,
.drawer-log-item.active {
  border-color: color-mix(in srgb, var(--accent-primary) 30%, var(--panel-border));
  background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
}

.drawer-log-item.pulse {
  border-color: color-mix(in srgb, var(--accent-primary) 64%, var(--panel-border));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent-primary) 24%, transparent),
    0 0 22px color-mix(in srgb, var(--accent-primary) 20%, transparent);
  animation: drawer-log-pulse 0.9s ease-in-out 2;
}

.drawer-log-item:hover {
  transform: translateX(-2px);
}

.drawer-log-title,
.drawer-log-meta,
.drawer-log-tags {
  display: block;
}

.drawer-log-title {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-log-meta {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 11px;
}

.drawer-log-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}

.drawer-log-tags i,
.drawer-log-tags small {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid currentColor;
  background: color-mix(in srgb, var(--panel-bg) 42%, transparent);
  font-size: 11px;
  font-style: normal;
}

.drawer-log-tags small {
  border-color: var(--panel-border);
  color: var(--text-muted);
}

.drawer-log-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 9px;
}

.drawer-log-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--accent-primary);
  font-size: 12px;
  cursor: pointer;
}

.drawer-log-actions button:hover {
  color: color-mix(in srgb, var(--accent-primary) 72%, white 18%);
}

@keyframes drawer-log-pulse {
  0%, 100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(-3px);
  }
}

.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.chip {
  padding: 5px 12px;
  border-radius: 16px;
  font-size: 12px;
  border: 1px solid var(--control-border);
  background: transparent;
  color: var(--text-strong);
  cursor: pointer;
  transition: all 0.15s;
}

.chip.active {
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
}

.chip:hover {
  border-color: color-mix(in srgb, var(--text-strong) 28%, transparent);
}

.tag-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.related-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  background: transparent;
  border: none;
  color: var(--text-strong);
  cursor: pointer;
  font-size: 13px;
}

.related-item:hover {
  background: var(--control-bg);
}

.related-item small {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 12px;
}

.muted {
  color: var(--text-muted);
  font-size: 13px;
}

.drawer-hint {
  margin-top: 16px;
}

.text-button {
  font-size: 12px;
  color: var(--accent-primary);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px 0;
}

.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.25s ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
}

/* Drawer extras */
.related-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 12px;
  color: rgba(238, 246, 255, 0.4);
}

.drawer-map-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
}

.drawer-map-item {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  background: transparent;
  border: none;
  color: #eef6ff;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}

.drawer-map-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.drawer-map-item.active {
  background: color-mix(in srgb, var(--accent-primary) 11%, transparent);
  color: var(--accent-primary);
}

.map-rename-form {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  flex: 1;
}

.map-rename-fields {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.map-rename-actions {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
}

.map-rename-form input {
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #eef6ff;
  font-size: 13px;
}

.icon-button.sm {
  width: 28px;
  height: 28px;
}

.icon-button.danger:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 11%, transparent);
}
</style>
