<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronLeft,
  FilePlus2,
  Edit3,
  Trash2,
  Clock,
  Download,
  Search,
  X,
  Plus,
  Map as MapIcon,
  Sparkles
} from 'lucide-vue-next';
import { useMapsStore } from '../stores/maps';
import { useGraphStore } from '../stores/graph';
import { useUiStore } from '../stores/ui';
import LogEditor from '../components/LogEditor.vue';
import MapSwitcher from '../components/MapSwitcher.vue';
import { createLog, deleteLog, updateLog } from '../services/api';
import type { LogEntry, DraftLog } from '../types/domain';

const mapsStore = useMapsStore();
const graphStore = useGraphStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

const mapId = computed(() => Number(route.params.id));
const showEditor = ref(false);
const editingLog = ref<LogEntry | null>(null);
const selectedLogId = ref<number | null>(null);
const searchQuery = ref('');
const notice = ref('');
const READER_FONT_SIZE_KEY = 'nebula.readerFontSize';
const READER_FONT_SIZE_MIN = 13;
const READER_FONT_SIZE_MAX = 22;
const READER_FONT_SIZE_DEFAULT = 15;
const readerFontSize = ref(readReaderFontSize());
const LOG_LIST_PANE_WIDTH_KEY = 'nebula.logsListPaneWidth';
const LOG_LIST_PANE_WIDTH_MIN = 300;
const LOG_LIST_PANE_WIDTH_FALLBACK_MAX = 960;
const LOG_DETAIL_MIN_WIDTH = 360;
const LOG_LIST_PANE_WIDTH_DEFAULT = 420;
const logsLayoutRef = ref<HTMLElement | null>(null);
const listPaneWidth = ref(readLogListPaneWidth());
const isResizingLayout = ref(false);

onMounted(async () => {
  await mapsStore.fetchMaps();
  if (mapId.value) {
    mapsStore.activeMapId = mapId.value;
    await mapsStore.selectMap(mapId.value);
    openFromRouteQuery();
  }
});

watch(mapId, async (id) => {
  if (id && !isNaN(id)) {
    mapsStore.activeMapId = id;
    await mapsStore.selectMap(id);
    closeEditor();
    selectedLogId.value = null;
    openFromRouteQuery();
  }
});

watch(
  () => [route.query.edit, route.query.new, route.query.selected],
  () => openFromRouteQuery()
);

watch(
  () => route.query.q,
  () => syncSearchFromRoute()
);

const logs = computed(() => {
  let list = graphStore.filteredLogs;
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter(
      log => log.title.toLowerCase().includes(q) ||
             log.content.toLowerCase().includes(q) ||
             log.tags.some(t => t.name.toLowerCase().includes(q))
    );
  }
  return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
});

const selectedLog = computed(() => (
  logs.value.find(log => log.id === selectedLogId.value) ??
  mapsStore.graph?.logs.find(log => log.id === selectedLogId.value) ??
  null
));
const allLogCount = computed(() => mapsStore.graph?.logs.length ?? 0);
const tagCount = computed(() => mapsStore.graph?.tags.length ?? 0);
const readerFontStyle = computed(() => ({
  fontSize: `${readerFontSize.value}px`
}));
const logsLayoutStyle = computed(() => ({
  gridTemplateColumns: `${listPaneWidth.value}px 10px minmax(${LOG_DETAIL_MIN_WIDTH}px, 1fr)`
}));

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('zh-CN');
}

function readReaderFontSize() {
  const value = Number(localStorage.getItem(READER_FONT_SIZE_KEY));
  if (!Number.isFinite(value)) return READER_FONT_SIZE_DEFAULT;
  return Math.min(READER_FONT_SIZE_MAX, Math.max(READER_FONT_SIZE_MIN, value));
}

function setReaderFontSize(value: number) {
  const next = Math.min(READER_FONT_SIZE_MAX, Math.max(READER_FONT_SIZE_MIN, value));
  readerFontSize.value = next;
  localStorage.setItem(READER_FONT_SIZE_KEY, String(next));
}

function adjustReaderFontSize(delta: number) {
  setReaderFontSize(readerFontSize.value + delta);
}

function resetReaderFontSize() {
  setReaderFontSize(READER_FONT_SIZE_DEFAULT);
}

function readLogListPaneWidth() {
  const value = Number(localStorage.getItem(LOG_LIST_PANE_WIDTH_KEY));
  if (!Number.isFinite(value)) return LOG_LIST_PANE_WIDTH_DEFAULT;
  return Math.min(LOG_LIST_PANE_WIDTH_FALLBACK_MAX, Math.max(LOG_LIST_PANE_WIDTH_MIN, value));
}

function clampLogListPaneWidth(value: number) {
  const layout = logsLayoutRef.value;
  const max = layout
    ? Math.max(LOG_LIST_PANE_WIDTH_MIN, layout.clientWidth - LOG_DETAIL_MIN_WIDTH - 10)
    : LOG_LIST_PANE_WIDTH_FALLBACK_MAX;
  return Math.round(Math.min(max, Math.max(LOG_LIST_PANE_WIDTH_MIN, value)));
}

function setLogListPaneWidth(value: number) {
  const next = clampLogListPaneWidth(value);
  listPaneWidth.value = next;
  localStorage.setItem(LOG_LIST_PANE_WIDTH_KEY, String(next));
}

function startLayoutResize(event: PointerEvent) {
  isResizingLayout.value = true;
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  updateLayoutResize(event);
}

function updateLayoutResize(event: PointerEvent) {
  if (!isResizingLayout.value || !logsLayoutRef.value) return;
  const rect = logsLayoutRef.value.getBoundingClientRect();
  setLogListPaneWidth(event.clientX - rect.left);
}

function stopLayoutResize(event: PointerEvent) {
  isResizingLayout.value = false;
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
}

function resetLayoutResize() {
  setLogListPaneWidth(LOG_LIST_PANE_WIDTH_DEFAULT);
}

function startNew() {
  editingLog.value = null;
  selectedLogId.value = null;
  showEditor.value = true;
}

function startEdit(log: LogEntry) {
  editingLog.value = log;
  selectedLogId.value = log.id;
  showEditor.value = true;
}

function closeEditor() {
  showEditor.value = false;
  editingLog.value = null;
}

function selectLog(log: LogEntry) {
  selectedLogId.value = selectedLogId.value === log.id ? null : log.id;
  showEditor.value = false;
  editingLog.value = null;
}

function inspectLog(log: LogEntry) {
  selectedLogId.value = log.id;
  showEditor.value = false;
  editingLog.value = null;
}

function locateLogInNebula(logId: number) {
  router.push({
    path: `/maps/${mapId.value}`,
    query: {
      drawer: 'logs',
      focusLog: String(logId)
    }
  });
}

function switchMap(nextId: number) {
  if (!Number.isFinite(nextId) || nextId === mapId.value) return;
  router.push(`/maps/${nextId}/logs`);
}

function openFromRouteQuery() {
  syncSearchFromRoute();
  if (route.query.new === '1') {
    startNew();
    return;
  }
  const rawEditId = Array.isArray(route.query.edit) ? route.query.edit[0] : route.query.edit;
  const editId = rawEditId ? Number(rawEditId) : NaN;
  if (Number.isFinite(editId)) {
    const log = mapsStore.graph?.logs.find(item => item.id === editId);
    if (log) startEdit(log);
    return;
  }
  const rawSelectedId = Array.isArray(route.query.selected) ? route.query.selected[0] : route.query.selected;
  const selectedId = rawSelectedId ? Number(rawSelectedId) : NaN;
  if (!Number.isFinite(selectedId)) return;
  const log = mapsStore.graph?.logs.find(item => item.id === selectedId);
  if (!log) return;
  selectedLogId.value = log.id;
  showEditor.value = false;
  editingLog.value = null;
  scrollSelectedLogIntoView(log.id);
}

function syncSearchFromRoute() {
  const rawQuery = Array.isArray(route.query.q) ? route.query.q[0] : route.query.q;
  if (typeof rawQuery === 'string' && rawQuery.trim()) {
    searchQuery.value = rawQuery.trim();
  }
}

async function scrollSelectedLogIntoView(logId: number) {
  await nextTick();
  const item = document.querySelector<HTMLElement>(`[data-log-id="${logId}"]`);
  item?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function handleSave(payload: { title: string; content: string; tagNames: string[] }) {
  const wasEditing = editingLog.value !== null;
  if (!ui.isOnline && !wasEditing) {
    await mapsStore.saveCurrentDraft(payload);
    ui.showNotice('当前离线，草稿已保存在本地，联网后再点保存。');
    return;
  }
  if (!ui.isOnline && wasEditing) {
    ui.showNotice('当前离线，已保存日志暂不直接修改；联网后再保存。');
    return;
  }
  try {
    if (wasEditing) {
      await updateLog(editingLog.value!.id, payload);
    } else {
      await createLog({ mapId: mapId.value, ...payload });
    }
    await mapsStore.clearCurrentDraft();
    closeEditor();
    await mapsStore.refreshData();
    ui.showNotice(wasEditing ? '日志已更新' : '日志已保存');
  } catch (e: any) {
    if (!wasEditing) {
      await mapsStore.saveCurrentDraft(payload);
    }
    ui.showNotice(e.message ?? '保存失败');
  }
}

function handleDelete(logId: number) {
  const log = logs.value.find(l => l.id === logId);
  if (!log) return;
  ui.showConfirm(
    '删除日志',
    `确认删除「${log.title}」吗？删除后可以用撤销恢复。`,
    '删除',
    async () => {
      const snapshot: LogEntry = { ...log, tags: log.tags.map(t => ({ ...t })) };
      await deleteLog(log.id);
      ui.pushDeleteHistory({ kind: 'log', log: snapshot });
      if (editingLog.value?.id === log.id) closeEditor();
      await mapsStore.refreshData();
      ui.showNotice('日志已删除，可撤销');
    }
  );
}

async function handleDraftChange(payload: DraftLog) {
  if (editingLog.value) return; // only for new logs
  await mapsStore.saveCurrentDraft(payload);
}

function handleExport(logId: number) {
  // Simple markdown export
  const log = logs.value.find(l => l.id === logId);
  if (!log) return;
  const md = `# ${log.title}\n\n${log.content}\n\n---\n标签: ${log.tags.map(t => t.name).join(', ')}\n日期: ${formatDate(log.createdAt)}`;
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${log.title || '日志'}.md`;
  a.click();
  URL.revokeObjectURL(url);
  setNotice('已导出 Markdown');
}

function setNotice(msg: string) {
  notice.value = msg;
  setTimeout(() => { if (notice.value === msg) notice.value = ''; }, 3000);
}
</script>

<template>
  <div class="logs-page stardust-page stardust-page--quiet">
    <!-- Header -->
    <header class="page-header">
      <div class="header-left">
        <button class="icon-button" title="返回星图" @click="router.push(`/maps/${mapId}`)">
          <ChevronLeft :size="18" />
        </button>
        <h2>{{ mapsStore.graph?.map.name ?? '日志' }}</h2>
        <MapSwitcher :maps="mapsStore.maps" :model-value="mapId" @change="switchMap" />
      </div>
      <div class="header-right">
        <div class="search-box">
          <Search :size="15" />
          <input v-model="searchQuery" placeholder="搜索日志..." />
          <button v-if="searchQuery" class="icon-button sm" @click="searchQuery = ''">
            <X :size="14" />
          </button>
        </div>
        <button class="primary-button sm" @click="startNew">
          <Plus :size="16" />
          写日志
        </button>
      </div>
    </header>

    <div v-if="notice" class="notice-toast">{{ notice }}</div>

    <!-- Log + Editor layout -->
    <div
      ref="logsLayoutRef"
      class="logs-layout"
      :class="{ resizing: isResizingLayout }"
      :style="logsLayoutStyle"
    >
      <div class="logs-list-col">
        <div class="logs-list-head">
          <div>
            <strong>日志列表</strong>
            <small>{{ logs.length }} 篇 · 点击卡片在右侧阅读</small>
          </div>
          <button class="text-action" @click="startNew">
            <Plus :size="14" />
            新日志
          </button>
        </div>

        <section class="map-context-card">
          <div class="map-context-copy">
            <span>当前星图</span>
            <strong>{{ mapsStore.graph?.map.name ?? '星图' }}</strong>
            <small>{{ allLogCount }} 篇日志 · {{ tagCount }} 个标签</small>
          </div>
          <div class="map-context-actions">
            <button type="button" title="打开星云图" @click="router.push(`/maps/${mapId}`)">
              <MapIcon :size="14" />
            </button>
            <button type="button" title="查看洞察" @click="router.push(`/maps/${mapId}/insights`)">
              <Sparkles :size="14" />
            </button>
          </div>
        </section>

        <div v-if="logs.length === 0" class="empty-logs">
          <FilePlus2 :size="36" class="empty-icon" />
          <p v-if="searchQuery">没有找到匹配的日志</p>
          <p v-else>还没有日志，点击"写日志"开始记录</p>
        </div>

        <div v-else class="log-cards">
          <article
            v-for="log in logs"
            :key="log.id"
            :data-log-id="log.id"
            class="log-card"
            :class="{ selected: selectedLogId === log.id }"
            @click="selectLog(log)"
            @contextmenu.prevent="inspectLog(log)"
          >
            <div class="log-card-tags">
              <span
                v-for="tag in log.tags"
                :key="tag.id"
                class="mini-tag"
                :style="{ borderColor: tag.color }"
              >
                {{ tag.name }}
              </span>
            </div>
            <h3>{{ log.title || '无标题' }}</h3>
            <p class="log-preview">{{ log.content.slice(0, 120) }}{{ log.content.length > 120 ? '...' : '' }}</p>
            <div class="log-meta">
              <span><Clock :size="12" /> {{ formatDate(log.createdAt) }}</span>
              <div class="log-actions" @click.stop>
                <button class="icon-button sm" title="编辑" @click="startEdit(log)"><Edit3 :size="14" /></button>
                <button class="icon-button sm" title="导出" @click="handleExport(log.id)"><Download :size="14" /></button>
                <button class="icon-button sm danger" title="删除" @click="handleDelete(log.id)"><Trash2 :size="14" /></button>
              </div>
            </div>
          </article>
        </div>
      </div>

      <div
        class="logs-resizer"
        role="separator"
        aria-label="Resize log list"
        aria-orientation="vertical"
        title="Resize log list"
        @pointerdown="startLayoutResize"
        @pointermove="updateLayoutResize"
        @pointerup="stopLayoutResize"
        @pointercancel="stopLayoutResize"
        @dblclick="resetLayoutResize"
      />

      <!-- Editor / reader panel -->
      <aside class="detail-panel" :class="{ editing: showEditor, empty: !showEditor && !selectedLog }">
        <LogEditor
          v-if="showEditor"
          :map-id="mapId"
          :initial-log="editingLog"
          :draft="mapsStore.draft"
          :existing-tags="mapsStore.graph?.tags ?? []"
          :offline="!ui.isOnline"
          :draft-restored="ui.draftRestored"
          :draft-saved-at="ui.draftSavedAt"
          @save="handleSave"
          @cancel="closeEditor"
          @draft-change="handleDraftChange"
        />
        <template v-else-if="selectedLog">
        <div class="reader-toolbar">
          <span>阅读日志</span>
          <div class="reader-actions">
            <div class="reader-font-controls" aria-label="调整正文字号">
              <button
                class="font-step"
                type="button"
                :disabled="readerFontSize <= READER_FONT_SIZE_MIN"
                title="减小字号"
                @click="adjustReaderFontSize(-1)"
              >
                A-
              </button>
              <span>{{ readerFontSize }}px</span>
              <button class="font-reset" type="button" title="恢复默认字号" @click="resetReaderFontSize">
                默认
              </button>
              <button
                class="font-step"
                type="button"
                :disabled="readerFontSize >= READER_FONT_SIZE_MAX"
                title="增大字号"
                @click="adjustReaderFontSize(1)"
              >
                A+
              </button>
            </div>
            <button class="icon-button sm" title="在星云中定位" @click="locateLogInNebula(selectedLog.id)"><MapIcon :size="14" /></button>
            <button class="icon-button sm" title="编辑" @click="startEdit(selectedLog)"><Edit3 :size="14" /></button>
            <button class="icon-button sm" title="导出 Markdown" @click="handleExport(selectedLog.id)"><Download :size="14" /></button>
            <button class="icon-button sm danger" title="删除" @click="handleDelete(selectedLog.id)"><Trash2 :size="14" /></button>
            <button class="icon-button sm" title="关闭" @click="selectedLogId = null"><X :size="14" /></button>
          </div>
        </div>
        <article class="reader-card">
          <div class="reader-meta">
            <span><Clock :size="13" /> {{ formatDate(selectedLog.createdAt) }}</span>
          </div>
          <h2>{{ selectedLog.title || '无标题' }}</h2>
          <div class="reader-tags">
            <span
              v-for="tag in selectedLog.tags"
              :key="tag.id"
              class="reader-tag"
              :style="{ borderColor: tag.color, color: tag.color }"
            >
              {{ tag.name }}
            </span>
          </div>
          <p class="reader-content" :style="readerFontStyle">{{ selectedLog.content }}</p>
        </article>
        </template>

        <div v-else class="reader-empty-state">
          <FilePlus2 :size="34" />
          <strong>选择一篇日志查看正文</strong>
          <span>左侧日志列表和右侧正文区各自滚动，不会互相挤占。</span>
          <button class="primary-button sm" @click="startNew">
            <Plus :size="16" />
            写新日志
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.logs-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.page-header {
  position: relative;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: rgba(10, 20, 36, 0.9);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-left h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(238, 246, 255, 0.4);
}

.search-box input {
  background: transparent;
  border: none;
  color: #eef6ff;
  font-size: 13px;
  outline: none;
  width: 180px;
}

.notice-toast {
  position: fixed;
  top: 64px;
  right: 20px;
  padding: 10px 20px;
  border-radius: 8px;
  background: rgba(140, 240, 180, 0.15);
  color: #8cf0b4;
  font-size: 13px;
  z-index: 200;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Layout */
.logs-layout {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(320px, 0.86fr) 10px minmax(420px, 1.14fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background:
    linear-gradient(135deg, rgba(159, 255, 203, 0.035), transparent 34%, rgba(185, 156, 255, 0.035));
}

.logs-layout.resizing,
.logs-layout.resizing * {
  cursor: col-resize;
  user-select: none;
}

.logs-list-col {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 18px 22px;
  border-right: 1px solid rgba(255, 255, 255, 0.07);
}

.logs-resizer {
  position: relative;
  z-index: 5;
  min-width: 10px;
  height: 100%;
  cursor: col-resize;
  background:
    linear-gradient(90deg, transparent, rgba(98, 214, 255, 0.06), transparent);
}

.logs-resizer::before {
  content: '';
  position: absolute;
  top: 18px;
  bottom: 18px;
  left: 50%;
  width: 2px;
  border-radius: 999px;
  background: rgba(98, 214, 255, 0.16);
  box-shadow: 0 0 16px rgba(98, 214, 255, 0.12);
  transform: translateX(-50%);
  transition: background 0.15s, box-shadow 0.15s;
}

.logs-resizer:hover::before,
.logs-layout.resizing .logs-resizer::before {
  background: rgba(98, 214, 255, 0.5);
  box-shadow: 0 0 18px rgba(98, 214, 255, 0.32);
}

.logs-list-head {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -18px -22px 14px;
  padding: 16px 22px 12px;
  background: linear-gradient(180deg, rgba(8, 17, 31, 0.98), rgba(8, 17, 31, 0.82));
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(16px);
}

.map-context-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 13px 14px;
  border-radius: 12px;
  border: 1px solid rgba(98, 214, 255, 0.14);
  background:
    radial-gradient(circle at 12% 0%, rgba(98, 214, 255, 0.13), transparent 34%),
    rgba(255, 255, 255, 0.035);
}

.map-context-copy {
  min-width: 0;
}

.map-context-copy span,
.map-context-copy small {
  display: block;
  color: rgba(238, 246, 255, 0.42);
  font-size: 12px;
}

.map-context-copy strong {
  display: block;
  margin: 4px 0 3px;
  overflow: hidden;
  color: #eef6ff;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.map-context-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.map-context-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  border: 1px solid rgba(98, 214, 255, 0.18);
  background: rgba(98, 214, 255, 0.08);
  color: #8ddfff;
  cursor: pointer;
}

.map-context-actions button:hover {
  color: #08111f;
  background: #62d6ff;
}

.logs-list-head strong,
.logs-list-head small {
  display: block;
}

.logs-list-head strong {
  color: #eef6ff;
  font-size: 14px;
}

.logs-list-head small {
  margin-top: 3px;
  color: rgba(238, 246, 255, 0.38);
  font-size: 12px;
}

.text-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid rgba(98, 214, 255, 0.22);
  background: rgba(98, 214, 255, 0.09);
  color: #62d6ff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.text-action:hover {
  background: rgba(98, 214, 255, 0.16);
}

.empty-logs {
  text-align: center;
  padding: 60px 20px;
  color: rgba(238, 246, 255, 0.3);
}

.empty-icon {
  margin-bottom: 12px;
}

.log-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.log-card {
  padding: 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition: all 0.15s;
}

.log-card:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.1);
}

.log-card.selected {
  border-color: rgba(98, 214, 255, 0.3);
  background: rgba(98, 214, 255, 0.04);
}

.log-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.mini-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(238, 246, 255, 0.6);
}

.log-card h3 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}

.log-preview {
  margin: 0 0 10px;
  font-size: 13px;
  color: rgba(238, 246, 255, 0.45);
  line-height: 1.5;
}

.log-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: rgba(238, 246, 255, 0.3);
}

.log-meta span {
  display: flex;
  align-items: center;
  gap: 4px;
}

.log-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.log-card:hover .log-actions {
  opacity: 1;
}

.detail-panel {
  position: relative;
  isolation: isolate;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 16px;
  background:
    radial-gradient(circle at 18% 12%, rgba(140, 240, 180, 0.08), transparent 34%),
    rgba(9, 18, 31, 0.94);
  overflow: hidden;
  overscroll-behavior: contain;
}

.detail-panel:not(.editing)::before,
.detail-panel:not(.editing)::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.detail-panel:not(.editing)::before {
  background:
    radial-gradient(circle at 10% 22%, rgba(98, 214, 255, 0.42) 0 1.2px, transparent 2.8px),
    radial-gradient(circle at 22% 78%, rgba(133, 105, 255, 0.38) 0 1.3px, transparent 3px),
    radial-gradient(circle at 48% 18%, rgba(185, 156, 255, 0.34) 0 1.1px, transparent 2.8px),
    radial-gradient(circle at 72% 64%, rgba(98, 214, 255, 0.32) 0 1px, transparent 2.8px),
    radial-gradient(circle at 92% 34%, rgba(140, 240, 180, 0.24) 0 1px, transparent 2.8px);
  background-size: 340px 240px, 420px 300px, 380px 260px, 460px 320px, 440px 300px;
  opacity: 0.58;
  filter: drop-shadow(0 0 6px rgba(98, 214, 255, 0.2));
  animation: readerStageStardustDrift 46s linear infinite;
}

.detail-panel:not(.editing)::after {
  background:
    radial-gradient(circle at 18% 18%, rgba(98, 214, 255, 0.1), transparent 18%),
    radial-gradient(circle at 82% 76%, rgba(185, 156, 255, 0.09), transparent 20%),
    linear-gradient(120deg, transparent 8%, rgba(238, 246, 255, 0.028) 42%, transparent 74%);
  opacity: 0.78;
}

.detail-panel.editing {
  padding: 18px 20px;
  overflow-y: auto;
  overscroll-behavior: contain;
  background:
    radial-gradient(circle at 14% 18%, rgba(98, 214, 255, 0.08), transparent 30%),
    radial-gradient(circle at 82% 72%, rgba(185, 156, 255, 0.07), transparent 32%),
    rgba(10, 20, 36, 0.95);
}

.detail-panel.editing :deep(.editor-panel) {
  width: min(900px, 100%);
  min-height: 0;
  margin: 0 auto;
}

.detail-panel.editing :deep(.log-editor-panel) {
  display: flex;
  flex-direction: column;
  padding: 22px;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.085);
  background:
    linear-gradient(145deg, rgba(16, 30, 50, 0.95), rgba(10, 20, 35, 0.98)),
    rgba(255, 255, 255, 0.04);
  box-shadow:
    0 18px 56px rgba(0, 0, 0, 0.24),
    inset 0 0 0 1px rgba(98, 214, 255, 0.035);
}

.detail-panel.editing :deep(.log-editor-title) {
  align-items: center;
  min-height: 38px;
  margin-bottom: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.detail-panel.editing :deep(.log-editor-title span) {
  color: #eef6ff;
  font-size: 18px;
  font-weight: 800;
}

.detail-panel.editing :deep(.log-editor-panel .field) {
  gap: 8px;
  margin-bottom: 16px;
}

.detail-panel.editing :deep(.log-editor-panel .field > span) {
  color: rgba(238, 246, 255, 0.58);
  font-size: 12px;
  font-weight: 700;
}

.detail-panel.editing :deep(.log-editor-panel .field input),
.detail-panel.editing :deep(.log-editor-panel .field textarea) {
  border-radius: 13px;
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(6, 14, 25, 0.56);
}

.detail-panel.editing :deep(.log-editor-panel .field input) {
  min-height: 46px;
  padding: 0 14px;
  color: #f5fbff;
  font-size: 16px;
  font-weight: 700;
}

.detail-panel.editing :deep(.log-editor-panel .field textarea) {
  min-height: 240px;
  padding: 14px 15px;
  color: rgba(238, 246, 255, 0.88);
  font-size: 15px;
  line-height: 1.8;
  resize: vertical;
}

.detail-panel.editing :deep(.log-editor-panel .draft-status) {
  margin-bottom: 16px;
  border-radius: 12px;
}

.detail-panel.editing :deep(.log-editor-panel .editor-row) {
  align-items: center;
  margin: 0 0 14px;
}

.detail-panel.editing :deep(.log-editor-panel .secondary-button) {
  min-height: 38px;
  border-color: rgba(98, 214, 255, 0.2);
  background: rgba(98, 214, 255, 0.09);
  color: #9ee7ff;
}

.detail-panel.editing :deep(.log-editor-panel .suggestion-box) {
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  margin: 12px 0 16px;
}

.detail-panel.editing :deep(.log-editor-panel .suggestion-item) {
  min-height: 78px;
  border: 1px solid rgba(255, 255, 255, 0.085);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
}

.detail-panel.editing :deep(.log-editor-panel .chip-list) {
  gap: 7px;
}

.detail-panel.editing :deep(.log-editor-panel .chip) {
  min-height: 30px;
  padding: 0 11px;
  background: rgba(255, 255, 255, 0.055);
}

.detail-panel.editing :deep(.log-editor-panel .compact-tags) {
  max-height: 116px;
  padding: 10px;
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.055);
}

.detail-panel.editing :deep(.log-editor-panel .input-with-button input) {
  font-weight: 500;
}

.detail-panel.editing :deep(.log-editor-panel .primary-button.wide) {
  min-height: 42px;
  margin-top: 2px;
  border-radius: 12px;
}

.detail-panel.empty {
  justify-content: center;
  align-items: center;
}

.reader-toolbar {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  width: min(860px, calc(100% - 32px));
  margin-inline: auto;
  margin-bottom: 12px;
  color: rgba(238, 246, 255, 0.5);
  font-size: 12px;
}

.reader-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.reader-font-controls {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 28px;
  margin-right: 6px;
  padding: 2px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.045);
}

.reader-font-controls span {
  min-width: 38px;
  color: rgba(238, 246, 255, 0.48);
  font-size: 11px;
  text-align: center;
}

.font-step,
.font-reset {
  min-height: 24px;
  border-radius: 7px;
  border: 0;
  background: transparent;
  color: rgba(238, 246, 255, 0.62);
  font-size: 11px;
  font-weight: 750;
  cursor: pointer;
}

.font-step {
  width: 30px;
}

.font-reset {
  padding: 0 7px;
}

.font-step:hover:not(:disabled),
.font-reset:hover {
  color: #62d6ff;
  background: rgba(98, 214, 255, 0.1);
}

.font-step:disabled {
  opacity: 0.36;
  cursor: not-allowed;
}

.reader-card {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  width: 100%;
  height: min(660px, calc(100vh - 168px));
  max-height: calc(100vh - 168px);
  margin: 0;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 22px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background:
    linear-gradient(135deg, rgba(15, 28, 46, 0.92), rgba(12, 21, 36, 0.96)),
    rgba(255, 255, 255, 0.035);
  box-shadow: inset 0 0 0 1px rgba(98, 214, 255, 0.025);
}

.reader-card h2 {
  margin: 8px 0 12px;
  color: #eef6ff;
  font-size: 22px;
  line-height: 1.35;
}

.reader-meta {
  display: flex;
  align-items: center;
  color: rgba(238, 246, 255, 0.38);
  font-size: 12px;
}

.reader-meta span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.reader-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 18px;
}

.reader-tag {
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid currentColor;
  background: rgba(255, 255, 255, 0.035);
  font-size: 12px;
}

.reader-content {
  margin: 0;
  color: rgba(238, 246, 255, 0.76);
  font-size: 14px;
  line-height: 1.85;
  white-space: pre-wrap;
}

@keyframes readerStageStardustDrift {
  from {
    background-position: 0 0, 0 0, 0 0, 0 0, 0 0;
  }
  to {
    background-position: 340px 240px, -420px 300px, 380px -260px, -460px -320px, 440px 300px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .detail-panel:not(.editing)::before {
    animation: none;
  }
}

.reader-empty-state {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 360px;
  text-align: center;
  color: rgba(238, 246, 255, 0.42);
}

.reader-empty-state svg {
  margin-bottom: 14px;
  color: rgba(98, 214, 255, 0.62);
}

.reader-empty-state strong {
  color: #eef6ff;
  font-size: 16px;
  margin-bottom: 8px;
}

.reader-empty-state span {
  font-size: 13px;
  line-height: 1.65;
  margin-bottom: 18px;
}

/* Shared button styles */
.icon-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: transparent;
  border: none;
  color: rgba(238, 246, 255, 0.5);
  cursor: pointer;
  transition: all 0.15s;
}

.icon-button:hover { color: #eef6ff; background: rgba(255, 255, 255, 0.06); }
.icon-button.sm { width: 28px; height: 28px; }
.icon-button.danger:hover { color: #ff8fa3; background: rgba(255, 143, 163, 0.1); }

.primary-button.sm {
  padding: 7px 16px;
  border-radius: 8px;
  background: #62d6ff;
  color: #08111f;
  font-weight: 600;
  font-size: 13px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}

.primary-button.sm:hover { background: #4dc8f5; }

@media (max-width: 820px) {
  .page-header {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }

  .header-left,
  .header-right {
    flex-wrap: wrap;
  }

  .logs-layout {
    grid-template-columns: 1fr !important;
    overflow: hidden;
  }

  .logs-resizer {
    display: none;
  }

  .logs-list-col,
  .detail-panel {
    width: auto;
  }

  .logs-list-col {
    height: 42vh;
    max-height: 42vh;
    border-right: 0;
  }

  .detail-panel {
    height: calc(58vh - 88px);
    min-height: 360px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .detail-panel.editing {
    padding: 12px;
  }

  .detail-panel.editing :deep(.log-editor-panel) {
    padding: 16px;
    border-radius: 14px;
  }

  .detail-panel.editing :deep(.log-editor-panel .field textarea) {
    min-height: 190px;
  }

  .reader-actions {
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .reader-font-controls {
    order: -1;
    margin-right: 0;
  }

  .reader-card {
    height: clamp(220px, calc(58vh - 160px), 420px);
  }
}
</style>
