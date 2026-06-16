import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  deleteLog,
  deleteTag,
  restoreLog,
  restoreTag,
  updateTag
} from '../services/api';
import { useGraphStore } from './graph';
import { useMapsStore } from './maps';
import type { LogEntry, TagNode, DraftLog } from '../types/domain';

export type RightPanel = 'logs' | 'editor' | 'insight';
export type LeftPanel = 'maps' | 'active' | 'related' | 'manage' | 'domains';

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

type PasswordForm = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export const useUiStore = defineStore('ui', () => {
  const leftPanel = ref<LeftPanel | null>(null);
  const rightPanel = ref<RightPanel | null>(null);
  const editorMode = ref<'new' | 'edit' | null>('new');
  const editingLog = ref<LogEntry | null>(null);
  const notice = ref('');
  const isOnline = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
  const draftSavedAt = ref('');
  const draftRestored = ref(false);
  const nebulaConfirm = ref<NebulaConfirm | null>(null);
  const nebulaTagMenu = ref<NebulaTagMenu | null>(null);
  const tagEditName = ref('');
  const tagEditColor = ref('#62d6ff');
  const tagEditSaving = ref(false);
  const deleteUndoStack = ref<DeleteHistoryAction[]>([]);
  const deleteRedoStack = ref<DeleteHistoryAction[]>([]);
  const userMenuOpen = ref(false);
  const passwordFormOpen = ref(false);
  const passwordForm = ref<PasswordForm>({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const passwordSaving = ref(false);
  const passwordError = ref('');
  const adviceLoading = ref(false);

  // Network monitoring
  function setupNetworkListeners() {
    const goOnline = () => { isOnline.value = true; };
    const goOffline = () => { isOnline.value = false; };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
  }

  function toggleLeftPanel(panel: LeftPanel) {
    leftPanel.value = leftPanel.value === panel ? null : panel;
  }

  function toggleRightPanel(panel: RightPanel) {
    rightPanel.value = rightPanel.value === panel ? null : panel;
  }

  function openRightPanel(panel: RightPanel) {
    rightPanel.value = panel;
  }

  function closeRightPanel() {
    rightPanel.value = null;
  }

  function startNewLog() {
    editorMode.value = 'new';
    editingLog.value = null;
    rightPanel.value = 'editor';
  }

  function startEditLog(log: LogEntry) {
    editorMode.value = 'edit';
    editingLog.value = log;
    rightPanel.value = 'editor';
  }

  function closeEditor() {
    editorMode.value = null;
    editingLog.value = null;
  }

  function showNotice(msg: string) {
    notice.value = msg;
    setTimeout(() => {
      if (notice.value === msg) notice.value = '';
    }, 3000);
  }

  function setDraftState(state: { savedAt?: string; restored?: boolean }) {
    if (state.savedAt !== undefined) draftSavedAt.value = state.savedAt;
    if (state.restored !== undefined) draftRestored.value = state.restored;
  }

  // Confirm dialog
  function showConfirm(title: string, message: string, confirmLabel: string, onConfirm: () => Promise<void>) {
    nebulaConfirm.value = { title, message, confirmLabel, pending: false, onConfirm };
  }

  function closeConfirm() {
    nebulaConfirm.value = null;
  }

  // Tag context menu
  function openTagMenu(tagId: number, x: number, y: number, width: number, height: number) {
    const menuWidth = 236;
    const menuHeight = 172;
    nebulaTagMenu.value = {
      tagId,
      x: Math.min(Math.max(14, x + 14), Math.max(14, width - menuWidth - 14)),
      y: Math.min(Math.max(14, y + 10), Math.max(14, height - menuHeight - 14)),
      width,
      height,
      mode: 'menu'
    };
  }

  function startTagEdit(tagId: number, currentName: string, currentColor: string) {
    tagEditName.value = currentName;
    tagEditColor.value = currentColor;
    if (nebulaTagMenu.value) {
      nebulaTagMenu.value = { ...nebulaTagMenu.value, mode: 'edit' };
    }
  }

  async function saveContextTagEdit() {
    if (tagEditSaving.value) return;
    const graphStore = useGraphStore();
    const tag = graphStore.nebulaTagMenuTag;
    const nextName = tagEditName.value.trim();
    if (!tag || !nextName) return;
    tagEditSaving.value = true;
    try {
      await updateTag(tag.id, { name: nextName, color: tagEditColor.value });
      const mapsStore = useMapsStore();
      await mapsStore.refreshData();
      closeTagMenu();
      showNotice('标签已更新');
    } catch {
      // error handled silently
    } finally {
      tagEditSaving.value = false;
    }
  }

  function deleteContextTag() {
    const graphStore = useGraphStore();
    const tag = graphStore.nebulaTagMenuTag;
    if (!tag) return;
    closeTagMenu();
    graphStore.requestDeleteTag(tag);
  }

  function closeTagMenu() {
    if (tagEditSaving.value) return;
    nebulaTagMenu.value = null;
    tagEditName.value = '';
    tagEditColor.value = '#62d6ff';
  }

  // User menu
  function toggleUserMenu() {
    userMenuOpen.value = !userMenuOpen.value;
    if (userMenuOpen.value) {
      passwordFormOpen.value = false;
      passwordError.value = '';
    }
  }

  function closeUserMenu() {
    userMenuOpen.value = false;
    passwordFormOpen.value = false;
  }

  function togglePasswordForm() {
    passwordFormOpen.value = !passwordFormOpen.value;
    if (!passwordFormOpen.value) {
      passwordForm.value = { currentPassword: '', newPassword: '', confirmPassword: '' };
      passwordError.value = '';
    }
  }

  // --- Delete history undo/redo ---
  function pushDeleteHistory(action: DeleteHistoryAction) {
    deleteUndoStack.value = [...deleteUndoStack.value, action];
    deleteRedoStack.value = [];
  }

  function clearDeleteHistory() {
    deleteUndoStack.value = [];
    deleteRedoStack.value = [];
  }

  async function restoreDeletedAction(action: DeleteHistoryAction): Promise<DeleteHistoryAction> {
    if (action.kind === 'log') {
      const restored = await restoreLog(action.log);
      return { kind: 'log', log: { ...restored, tags: restored.tags.map((t: any) => ({ ...t })) } };
    }
    const restored = await restoreTag({
      id: action.tag.id,
      mapId: action.mapId,
      name: action.tag.name,
      color: action.tag.color,
      logIds: action.logIds
    });
    return { ...action, tag: { ...restored } };
  }

  async function deleteRestoredAction(action: DeleteHistoryAction) {
    const graphStore = useGraphStore();
    if (action.kind === 'log') {
      await deleteLog(action.log.id);
      if (graphStore.selectedLogId === action.log.id) {
        graphStore.selectedLogId = null;
      }
      return;
    }
    await deleteTag(action.tag.id);
    graphStore.activeTagIds = new Set([...graphStore.activeTagIds].filter(id => id !== action.tag.id));
  }

  async function undoDeleteAction(): Promise<boolean> {
    const action = deleteUndoStack.value.at(-1);
    if (!action) return false;
    try {
      const restoredAction = await restoreDeletedAction(action);
      deleteUndoStack.value = deleteUndoStack.value.slice(0, -1);
      deleteRedoStack.value = [...deleteRedoStack.value, restoredAction];
      const mapsStore = useMapsStore();
      await mapsStore.refreshData();
      const label = action.kind === 'log' ? action.log.title : action.tag.name;
      showNotice(`已撤销删除：${label}`);
    } catch {
      return false;
    }
    return true;
  }

  async function redoDeleteAction(): Promise<boolean> {
    const action = deleteRedoStack.value.at(-1);
    if (!action) return false;
    try {
      await deleteRestoredAction(action);
      deleteRedoStack.value = deleteRedoStack.value.slice(0, -1);
      deleteUndoStack.value = [...deleteUndoStack.value, action];
      const mapsStore = useMapsStore();
      await mapsStore.refreshData();
      const label = action.kind === 'log' ? action.log.title : action.tag.name;
      showNotice(`已重做删除：${label}`);
    } catch {
      return false;
    }
    return true;
  }

  function reset() {
    leftPanel.value = null;
    rightPanel.value = null;
    editorMode.value = null;
    editingLog.value = null;
    notice.value = '';
    nebulaConfirm.value = null;
    nebulaTagMenu.value = null;
    deleteUndoStack.value = [];
    deleteRedoStack.value = [];
    userMenuOpen.value = false;
    passwordFormOpen.value = false;
  }

  return {
    leftPanel,
    rightPanel,
    editorMode,
    editingLog,
    notice,
    isOnline,
    draftSavedAt,
    draftRestored,
    nebulaConfirm,
    nebulaTagMenu,
    tagEditName,
    tagEditColor,
    tagEditSaving,
    deleteUndoStack,
    deleteRedoStack,
    userMenuOpen,
    passwordFormOpen,
    passwordForm,
    passwordSaving,
    passwordError,
    adviceLoading,
    setupNetworkListeners,
    toggleLeftPanel,
    toggleRightPanel,
    openRightPanel,
    closeRightPanel,
    startNewLog,
    startEditLog,
    closeEditor,
    showNotice,
    setDraftState,
    showConfirm,
    closeConfirm,
    openTagMenu,
    startTagEdit,
    saveContextTagEdit,
    deleteContextTag,
    closeTagMenu,
    toggleUserMenu,
    closeUserMenu,
    togglePasswordForm,
    pushDeleteHistory,
    clearDeleteHistory,
    undoDeleteAction,
    redoDeleteAction,
    reset
  };
});
