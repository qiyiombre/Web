import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import {
  createMap,
  deleteMap,
  getGraph,
  getInsights,
  listMaps,
  saveDraft,
  loadDraft,
  clearDraft,
  updateMap
} from '../services/api';
import { useUiStore } from './ui';
import type {
  DraftLog,
  GraphData,
  Insight,
  NebulaMap,
  TagNode,
  LogEntry
} from '../types/domain';

export const useMapsStore = defineStore('maps', () => {
  const maps = ref<NebulaMap[]>([]);
  const activeMapId = ref<number | null>(null);
  const graph = ref<GraphData | null>(null);
  const insights = ref<Insight | null>(null);
  const loading = ref(false);
  const error = ref('');
  const layoutDirty = ref(false);
  const renamingMapId = ref<number | null>(null);
  const renameLocation = ref<'list' | 'title'>('title');
  const renameDraft = ref('');
  const renameSaving = ref(false);
  const nebulaRenderKey = ref(0);
  const draft = ref<DraftLog | undefined>();

  const hasNoMaps = computed(() => maps.value.length === 0 && !loading.value);

  const visibleGraph = computed<GraphData | null>(() => {
    // Time/frequency filtering is handled by the graph store
    return graph.value;
  });

  async function fetchMaps() {
    loading.value = true;
    error.value = '';
    try {
      maps.value = await listMaps();
    } catch (e: any) {
      error.value = e.message ?? '加载星图失败';
    } finally {
      loading.value = false;
    }
  }

  async function selectMap(id: number) {
    activeMapId.value = id;
    localStorage.setItem('nebula.lastActiveMapId', String(id));
    layoutDirty.value = false;
    error.value = '';
    loading.value = true;
    try {
      const [g, ins] = await Promise.all([getGraph(id), getInsights(id).catch(() => null)]);
      graph.value = g;
      insights.value = ins;
      await loadCurrentDraft();
    } catch (e: any) {
      error.value = e.message ?? '加载星图数据失败';
      graph.value = null;
      insights.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function addMap(name: string = '未命名星图', description: string = '') {
    const map = await createMap(name, description);
    maps.value.push(map);
    return map;
  }

  async function renameMap(id: number, name: string, description?: string) {
    const updated = await updateMap(id, { name, description });
    const idx = maps.value.findIndex(m => m.id === id);
    if (idx >= 0) maps.value[idx] = { ...maps.value[idx], ...updated };
    if (graph.value && graph.value.map.id === id) {
      graph.value = { ...graph.value, map: { ...graph.value.map, ...updated } };
    }
  }

  async function removeMap(id: number) {
    await deleteMap(id);
    maps.value = maps.value.filter(m => m.id !== id);
    if (activeMapId.value === id) {
      activeMapId.value = null;
      graph.value = null;
      insights.value = null;
    }
  }

  function startRenameMap(id: number, location: 'list' | 'title') {
    const map = maps.value.find(m => m.id === id);
    if (!map) return;
    renamingMapId.value = id;
    renameLocation.value = location;
    renameDraft.value = map.name;
  }

  function cancelRenameMap() {
    renamingMapId.value = null;
    renameDraft.value = '';
  }

  async function saveRenameMap(id: number) {
    const name = renameDraft.value.trim();
    if (!name) return;
    renameSaving.value = true;
    try {
      await renameMap(id, name);
      renamingMapId.value = null;
      renameDraft.value = '';
    } catch (e: any) {
      // error handled upstream
    } finally {
      renameSaving.value = false;
    }
  }

  async function refreshData() {
    if (activeMapId.value) {
      await selectMap(activeMapId.value);
    }
  }

  function refreshNebulaView() {
    nebulaRenderKey.value++;
  }

  function handleLayoutDirty(dirty: boolean) {
    layoutDirty.value = dirty;
  }

  // --- Draft management ---
  async function loadCurrentDraft() {
    if (!activeMapId.value) { draft.value = undefined; return; }
    try {
      draft.value = await loadDraft(activeMapId.value);
      const uiStore = useUiStore();
      const hasContent = Boolean(
        (draft.value?.title ?? '').trim() ||
        (draft.value?.content ?? '').trim() ||
        (draft.value?.tagNames?.length ?? 0) > 0
      );
      uiStore.setDraftState({ savedAt: hasContent ? '刚刚' : '', restored: hasContent });
    } catch {
      draft.value = undefined;
    }
  }

  async function saveCurrentDraft(payload: DraftLog) {
    if (!activeMapId.value) return;
    try {
      await saveDraft(activeMapId.value, payload);
      draft.value = payload;
      const uiStore = useUiStore();
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      uiStore.setDraftState({ savedAt: time, restored: false });
    } catch { /* silent */ }
  }

  async function clearCurrentDraft() {
    if (!activeMapId.value) return;
    try { await clearDraft(activeMapId.value); } catch { /* silent */ }
    draft.value = undefined;
    const uiStore = useUiStore();
    uiStore.setDraftState({ savedAt: '', restored: false });
  }

  function reset() {
    maps.value = [];
    activeMapId.value = null;
    graph.value = null;
    insights.value = null;
    loading.value = false;
    error.value = '';
    layoutDirty.value = false;
  }

  return {
    maps,
    activeMapId,
    graph,
    insights,
    loading,
    error,
    layoutDirty,
    renamingMapId,
    renameLocation,
    renameDraft,
    renameSaving,
    nebulaRenderKey,
    draft,
    hasNoMaps,
    visibleGraph,
    fetchMaps,
    selectMap,
    addMap,
    renameMap,
    removeMap,
    startRenameMap,
    cancelRenameMap,
    saveRenameMap,
    refreshData,
    refreshNebulaView,
    handleLayoutDirty,
    loadCurrentDraft,
    saveCurrentDraft,
    clearCurrentDraft,
    reset
  };
});
