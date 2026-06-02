<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { Cpu, Download, Edit3, FilePlus2, LogOut, Orbit, Plus, RefreshCw, RotateCcw, Trash2, UserRound, X } from 'lucide-vue-next';
import AuthPanel from './components/AuthPanel.vue';
import InsightPanel from './components/InsightPanel.vue';
import LogEditor from './components/LogEditor.vue';
import NebulaCanvas from './components/NebulaCanvas.vue';
import TagManager from './components/TagManager.vue';
import WebGpuNebulaCanvas from './components/WebGpuNebulaCanvas.vue';
import {
  clearDraft,
  createLog,
  createMap,
  deleteLog,
  generateAdvice,
  getCurrentUser,
  getGraph,
  getInsights,
  listMaps,
  loadDraft,
  logout,
  saveDraft,
  updateLog
} from './services/api';
import type { DraftLog, GraphData, Insight, LogEntry, NebulaMap, TagNode, UserAccount } from './types/domain';

type NebulaRenderer = {
  focusTag: (tagId: number) => void;
  resetTagLayout: () => void;
};

type NebulaLogCard = {
  logId: number;
  x: number;
  y: number;
};

const maps = ref<NebulaMap[]>([]);
const activeMapId = ref<number | null>(null);
const graph = ref<GraphData | null>(null);
const insights = ref<Insight | null>(null);
const activeTagIds = ref<Set<number>>(new Set());
const selectedLogId = ref<number | null>(null);
const detailLogId = ref<number | null>(null);
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
const canvasRef = ref<NebulaRenderer | null>(null);
const tagManagerRef = ref<InstanceType<typeof TagManager> | null>(null);

const selectedLog = computed(() => graph.value?.logs.find((log) => log.id === detailLogId.value) ?? null);
const nebulaCardLog = computed(() => {
  if (!graph.value || !nebulaLogCard.value) {
    return null;
  }
  const log = graph.value.logs.find((item) => item.id === nebulaLogCard.value?.logId);
  return log ? { log, x: nebulaLogCard.value.x, y: nebulaLogCard.value.y } : null;
});

const filteredLogs = computed(() => {
  if (!graph.value) {
    return [];
  }
  const active = [...activeTagIds.value];
  if (active.length === 0) {
    return graph.value.logs;
  }
  return graph.value.logs.filter((log) => active.every((tagId) => log.tags.some((tag) => tag.id === tagId)));
});

const activeTags = computed(() => {
  if (!graph.value) {
    return [];
  }
  return graph.value.tags.filter((tag) => activeTagIds.value.has(tag.id));
});

const relatedTags = computed(() => {
  if (!graph.value) {
    return [];
  }
  const score = new Map<number, number>();
  const candidates = activeTagIds.value.size > 0 ? filteredLogs.value : graph.value.logs;
  for (const log of candidates) {
    for (const tag of log.tags) {
      if (!activeTagIds.value.has(tag.id)) {
        score.set(tag.id, (score.get(tag.id) ?? 0) + 1);
      }
    }
  }
  return [...score.entries()]
    .map(([id, count]) => ({ tag: graph.value!.tags.find((item) => item.id === id), count }))
    .filter((item): item is { tag: TagNode; count: number } => Boolean(item.tag))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
});

const stats = computed(() => ({
  tags: graph.value?.tags.length ?? 0,
  logs: graph.value?.logs.length ?? 0,
  filtered: activeTagIds.value.size === 0 ? 0 : filteredLogs.value.length
}));

const hasNoMaps = computed(() => currentUser.value !== null && maps.value.length === 0);

onMounted(async () => {
  window.addEventListener('online', handleNetworkChange);
  window.addEventListener('offline', handleNetworkChange);
  await bootstrap();
});

onBeforeUnmount(() => {
  window.removeEventListener('online', handleNetworkChange);
  window.removeEventListener('offline', handleNetworkChange);
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
  detailLogId.value = null;
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
  detailLogId.value = null;
  nebulaLogCard.value = null;
  editorMode.value = 'new';
  editingLog.value = null;
  draft.value = undefined;
  draftRestored.value = false;
  draftSavedAt.value = '';
  error.value = '';
  notice.value = '';
}

async function refreshMaps() {
  maps.value = await listMaps();
}

async function selectMap(mapId: number) {
  activeMapId.value = mapId;
  localStorage.setItem(activeMapStorageKey(), String(mapId));
  localStorage.setItem('nebula.activeMapId', String(mapId));
  activeTagIds.value = new Set();
  selectedLogId.value = null;
  detailLogId.value = null;
  nebulaLogCard.value = null;
  editorMode.value = 'new';
  editingLog.value = null;
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
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function handleGenerateAdvice() {
  if (!activeMapId.value || !insights.value) {
    return;
  }
  adviceLoading.value = true;
  error.value = '';
  try {
    const result = await generateAdvice(activeMapId.value);
    insights.value = {
      ...insights.value,
      suggestions: result.suggestions
    };
    showNotice(result.cached ? '已使用缓存的 AI 建议' : 'AI 建议已生成');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '生成建议失败';
  } finally {
    adviceLoading.value = false;
  }
}

async function addMap() {
  const name = window.prompt('给新的星云图起个名字', '新的星云图');
  if (!name?.trim()) {
    return;
  }
  const created = await createMap(name.trim(), '我的个人行为观察星云');
  await refreshMaps();
  await selectMap(created.id);
  showNotice('星云图已创建');
}

function startNewLog() {
  selectedLogId.value = null;
  detailLogId.value = null;
  nebulaLogCard.value = null;
  editingLog.value = null;
  editorMode.value = 'new';
}

function startEditLog() {
  if (!selectedLog.value) {
    return;
  }
  editingLog.value = selectedLog.value;
  editorMode.value = 'edit';
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
    detailLogId.value = saved.id;
    nebulaLogCard.value = null;
    editorMode.value = null;
    editingLog.value = null;
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

async function removeSelectedLog() {
  if (!selectedLog.value) {
    return;
  }
  const ok = window.confirm(`确认删除「${selectedLog.value.title}」吗？`);
  if (!ok) {
    return;
  }
  await deleteLog(selectedLog.value.id);
  selectedLogId.value = null;
  detailLogId.value = null;
  nebulaLogCard.value = null;
  editorMode.value = 'new';
  await refreshData();
  showNotice('日志已删除');
}

function exportSelectedLog() {
  if (!selectedLog.value) {
    return;
  }
  const log = selectedLog.value;
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
}

function openLog(logId: number) {
  if (detailLogId.value === logId && editorMode.value === null) {
    detailLogId.value = null;
    selectedLogId.value = null;
    nebulaLogCard.value = null;
    return;
  }
  selectedLogId.value = logId;
  detailLogId.value = logId;
  nebulaLogCard.value = null;
  editorMode.value = null;
  editingLog.value = null;
}

function selectNebulaLog(logId: number) {
  if (selectedLogId.value === logId) {
    selectedLogId.value = null;
    nebulaLogCard.value = null;
    return;
  }
  selectedLogId.value = logId;
  nebulaLogCard.value = null;
}

function inspectNebulaLog(payload: NebulaLogCard) {
  selectedLogId.value = payload.logId;
  nebulaLogCard.value = {
    logId: payload.logId,
    x: Math.min(window.innerWidth - 280, Math.max(24, payload.x + 16)),
    y: Math.min(window.innerHeight - 220, Math.max(24, payload.y - 16))
  };
}

function closeNebulaCard() {
  nebulaLogCard.value = null;
}

function focusTag(tagId: number) {
  canvasRef.value?.focusTag(tagId);
}

function resetAiLayout() {
  canvasRef.value?.resetTagLayout();
  showNotice('已清除手动位置，正在按标签关系重新布局');
}

function switchRenderer(mode: 'canvas' | 'webgpu') {
  rendererMode.value = mode;
  localStorage.setItem('nebula.rendererMode', mode);
  nebulaLogCard.value = null;
  showNotice(mode === 'webgpu' ? '已切换到 WebGPU 星云渲染' : '已切换到 Canvas 兼容渲染');
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
        <div>
          <h1>星云洞察</h1>
          <p>个人日志知识图谱</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-title">
          <span>星云图</span>
          <button class="icon-button" title="新建星云图" @click="addMap">
            <Plus :size="17" />
          </button>
        </div>
        <div class="map-list">
          <button
            v-for="map in maps"
            :key="map.id"
            class="map-item"
            :class="{ active: map.id === activeMapId }"
            @click="selectMap(map.id)"
          >
            <span>{{ map.name }}</span>
            <small>{{ map.description || '无描述' }}</small>
          </button>
        </div>
      </section>

      <section class="panel">
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

      <section class="panel">
        <div class="panel-title">
          <span>相关标签</span>
        </div>
        <div class="related-list">
          <button v-for="item in relatedTags" :key="item.tag.id" class="related-item" @click="focusTag(item.tag.id)">
            <span class="tag-dot" :style="{ backgroundColor: item.tag.color }"></span>
            <span>{{ item.tag.name }}</span>
            <small>{{ item.count }}</small>
          </button>
        </div>
      </section>

      <TagManager
        v-if="activeMapId && graph"
        ref="tagManagerRef"
        :map-id="activeMapId"
        :tags="graph.tags"
        @changed="refreshData"
        @focus="activateTagAndFocus"
      />
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <h2>{{ graph?.map.name ?? (hasNoMaps ? '还没有星云图' : '加载中') }}</h2>
          <p>Canvas 实时渲染 · Web Worker 布局 · REST API · SQLite · Cookie Session · IndexedDB 草稿</p>
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
          <div class="stat-pill">{{ stats.tags }} 标签</div>
          <div class="stat-pill">{{ stats.logs }} 日志</div>
          <div class="stat-pill highlight">{{ stats.filtered }} 命中</div>
          <button class="icon-button" title="刷新" :disabled="!activeMapId" @click="refreshData">
            <RefreshCw :size="17" />
          </button>
          <button class="icon-button" title="恢复 AI 布局" :disabled="!activeMapId" @click="resetAiLayout">
            <RotateCcw :size="17" />
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
        v-if="graph && rendererMode === 'canvas'"
        ref="canvasRef"
        :graph="graph"
        :active-tag-ids="activeTagIds"
        :selected-log-id="selectedLogId"
        @tag-toggle="toggleTag"
        @log-open="selectNebulaLog"
        @log-inspect="inspectNebulaLog"
      />
      <WebGpuNebulaCanvas
        v-else-if="graph"
        ref="canvasRef"
        :graph="graph"
        :active-tag-ids="activeTagIds"
        :selected-log-id="selectedLogId"
        @tag-toggle="toggleTag"
        @log-open="selectNebulaLog"
        @log-inspect="inspectNebulaLog"
      />
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

      <div
        v-if="nebulaCardLog"
        class="nebula-log-card"
        :style="{ left: `${nebulaCardLog.x}px`, top: `${nebulaCardLog.y}px` }"
      >
        <div class="nebula-log-card-head">
          <span>日志星卡</span>
          <button class="icon-button" title="关闭" @click="closeNebulaCard">
            <X :size="14" />
          </button>
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
            @click="focusTag(tag.id)"
          >
            {{ tag.name }}
          </button>
        </div>
        <button class="text-button compact" @click="openLog(nebulaCardLog.log.id)">在侧栏打开</button>
      </div>
    </section>

    <aside class="right-rail">
      <section class="panel log-list-panel">
        <div class="panel-title">
          <span>日志列表</span>
          <small>按时间倒序</small>
        </div>
        <div class="log-list">
          <button
            v-for="log in filteredLogs"
            :key="log.id"
            class="log-item"
            :class="{ active: log.id === selectedLogId }"
            @click="openLog(log.id)"
          >
            <span>{{ log.title }}</span>
            <small>{{ formatDate(log.createdAt) }}</small>
          </button>
        </div>
      </section>

      <section v-if="selectedLog && !editorMode" class="panel detail-panel">
        <div class="panel-title">
          <span>日志详情</span>
          <div class="button-row">
            <button class="icon-button" title="编辑" @click="startEditLog">
              <Edit3 :size="16" />
            </button>
            <button class="icon-button" title="导出 Markdown" @click="exportSelectedLog">
              <Download :size="16" />
            </button>
            <button class="icon-button danger" title="删除" @click="removeSelectedLog">
              <Trash2 :size="16" />
            </button>
          </div>
        </div>
        <h3>{{ selectedLog.title }}</h3>
        <p class="detail-time">{{ formatDate(selectedLog.createdAt) }}</p>
        <div class="chip-list">
          <button
            v-for="tag in selectedLog.tags"
            :key="tag.id"
            class="chip"
            :style="{ borderColor: tag.color }"
            @click="focusTag(tag.id)"
          >
            {{ tag.name }}
          </button>
        </div>
        <p class="log-content">{{ selectedLog.content }}</p>
      </section>

      <LogEditor
        v-if="activeMapId && editorMode"
        :map-id="activeMapId"
        :initial-log="editingLog"
        :draft="draft"
        :existing-tags="graph?.tags ?? []"
        :offline="!isOnline"
        :draft-saved-at="draftSavedAt"
        :draft-restored="draftRestored"
        @save="handleSaveLog"
        @cancel="editorMode = null"
        @draft-change="handleDraftChange"
      />

      <InsightPanel :insight="insights" :advice-loading="adviceLoading" @generate-advice="handleGenerateAdvice" />
    </aside>
  </main>

  <main v-else class="auth-shell">
    <section class="auth-card">
      <p class="muted">正在检查登录状态...</p>
    </section>
  </main>
</template>
