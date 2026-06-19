import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  changePassword,
  getCurrentUser,
  login,
  logout,
  register,
  getUserPreferences,
  updateUserPreferences
} from '../services/api';
import type { ThemeMode, UserAccount, UserPreferences } from '../types/domain';
import { isThemeMode } from '../constants/themes';
import { useGraphStore } from './graph';
import { useMapsStore } from './maps';
import { useUiStore } from './ui';

function readRendererMode(): 'canvas' | 'webgpu' {
  return localStorage.getItem('nebula.rendererMode') === 'webgpu' ? 'webgpu' : 'canvas';
}

function readLayoutMode(): 'semantic' | 'domain' {
  return localStorage.getItem('nebula.layoutMode') === 'domain' ? 'domain' : 'semantic';
}

function readThemeMode(): ThemeMode {
  const mode = localStorage.getItem('nebula.themeMode');
  return isThemeMode(mode) ? mode : 'deepSpace';
}

export const useAuthStore = defineStore('auth', () => {
  const currentUser = ref<UserAccount | null>(null);
  const checkingAuth = ref(true);
  const preferencesReady = ref(false);
  const preferenceSyncing = ref(false);
  const preferenceSyncTimer = ref<number | null>(null);

  const rendererMode = ref<'canvas' | 'webgpu'>(readRendererMode());
  const layoutMode = ref<'semantic' | 'domain'>(readLayoutMode());
  const themeMode = ref<ThemeMode>(readThemeMode());

  async function checkAuth() {
    checkingAuth.value = true;
    preferencesReady.value = false;
    try {
      const { user } = await getCurrentUser();
      currentUser.value = user;
      await syncPreferences();
    } catch {
      currentUser.value = null;
      preferencesReady.value = true;
    } finally {
      checkingAuth.value = false;
    }
  }

  async function acceptAuthenticatedUser(user: UserAccount) {
    currentUser.value = user;
    checkingAuth.value = false;
    preferencesReady.value = false;
    await syncPreferences();
  }

  async function handleLogin(username: string, password: string) {
    const { user } = await login(username, password);
    await acceptAuthenticatedUser(user);
  }

  async function handleRegister(username: string, password: string) {
    const { user } = await register(username, password);
    await acceptAuthenticatedUser(user);
  }

  async function handleLogout() {
    const mapsStore = useMapsStore();
    const uiStore = useUiStore();
    try {
      await logout();
    } finally {
      currentUser.value = null;
      preferencesReady.value = false;
      mapsStore.reset();
      uiStore.reset();
      if (preferenceSyncTimer.value) {
        clearTimeout(preferenceSyncTimer.value);
        preferenceSyncTimer.value = null;
      }
    }
  }

  async function handleChangePassword(currentPw: string, newPw: string) {
    await changePassword(currentPw, newPw);
  }

  function setRendererMode(mode: 'canvas' | 'webgpu') {
    rendererMode.value = mode;
    localStorage.setItem('nebula.rendererMode', mode);
    schedulePreferenceSync();
  }

  function setLayoutMode(mode: 'semantic' | 'domain') {
    layoutMode.value = mode;
    localStorage.setItem('nebula.layoutMode', mode);
    schedulePreferenceSync();
  }

  function setThemeMode(mode: ThemeMode) {
    themeMode.value = mode;
    localStorage.setItem('nebula.themeMode', mode);
    schedulePreferenceSync();
  }

  function buildPreferences(): UserPreferences {
    const graphStore = useGraphStore();
    return {
      rendererMode: rendererMode.value,
      layoutMode: layoutMode.value,
      themeMode: themeMode.value,
      timeFilter: graphStore.timeFilter,
      frequencyFilter: graphStore.frequencyFilter,
      highFrequencyMinimum: graphStore.highFrequencyMinimum,
      lowFrequencyMaximum: graphStore.lowFrequencyMaximum,
      insightTopLimit: graphStore.insightTopLimit,
      insightTrendLimit: graphStore.insightTrendLimit,
      insightCooccurrenceLimit: graphStore.insightCooccurrenceLimit,
      nebulaPriorityDisplayLimit: graphStore.nebulaPriorityDisplayLimit,
      nebulaHeatWindowDays: graphStore.nebulaHeatWindowDays,
      nebulaHeatMinimumDelta: graphStore.nebulaHeatMinimumDelta,
      nebulaHeatMediumDelta: graphStore.nebulaHeatMediumDelta,
      nebulaHeatStrongDelta: graphStore.nebulaHeatStrongDelta,
      nebulaHeatFlatOpacity: graphStore.nebulaHeatFlatOpacity,
      nebulaLogDensityMode: graphStore.nebulaLogDensityMode,
      sortMode: graphStore.sortMode,
      customStartDate: graphStore.customStartDate,
      customEndDate: graphStore.customEndDate
    };
  }

  async function syncPreferences() {
    try {
      const { preferences } = await getUserPreferences();
      if (preferences?.rendererMode) {
        rendererMode.value = preferences.rendererMode;
        localStorage.setItem('nebula.rendererMode', preferences.rendererMode);
      }
      if (preferences?.layoutMode) {
        layoutMode.value = preferences.layoutMode;
        localStorage.setItem('nebula.layoutMode', preferences.layoutMode);
      }
      if (preferences?.themeMode) {
        themeMode.value = preferences.themeMode;
        localStorage.setItem('nebula.themeMode', preferences.themeMode);
      }
      const graphStore = useGraphStore();
      if (preferences?.timeFilter) graphStore.setTimeFilter(preferences.timeFilter);
      if (preferences?.frequencyFilter) graphStore.setFrequencyFilter(preferences.frequencyFilter);
      if (typeof preferences?.highFrequencyMinimum === 'number') {
        graphStore.setHighFrequencyMinimum(preferences.highFrequencyMinimum);
      }
      if (typeof preferences?.lowFrequencyMaximum === 'number') {
        graphStore.setLowFrequencyMaximum(preferences.lowFrequencyMaximum);
      }
      if (typeof preferences?.insightTopLimit === 'number') {
        graphStore.setInsightTopLimit(preferences.insightTopLimit);
      }
      if (typeof preferences?.insightTrendLimit === 'number') {
        graphStore.setInsightTrendLimit(preferences.insightTrendLimit);
      }
      if (typeof preferences?.insightCooccurrenceLimit === 'number') {
        graphStore.setInsightCooccurrenceLimit(preferences.insightCooccurrenceLimit);
      }
      if (typeof preferences?.nebulaPriorityDisplayLimit === 'number') {
        graphStore.setNebulaPriorityDisplayLimit(preferences.nebulaPriorityDisplayLimit);
      }
      if (typeof preferences?.nebulaHeatWindowDays === 'number') {
        graphStore.setNebulaHeatWindowDays(preferences.nebulaHeatWindowDays);
      }
      if (typeof preferences?.nebulaHeatMinimumDelta === 'number') {
        graphStore.setNebulaHeatMinimumDelta(preferences.nebulaHeatMinimumDelta);
      }
      if (typeof preferences?.nebulaHeatMediumDelta === 'number') {
        graphStore.setNebulaHeatMediumDelta(preferences.nebulaHeatMediumDelta);
      }
      if (typeof preferences?.nebulaHeatStrongDelta === 'number') {
        graphStore.setNebulaHeatStrongDelta(preferences.nebulaHeatStrongDelta);
      }
      if (typeof preferences?.nebulaHeatFlatOpacity === 'number') {
        graphStore.setNebulaHeatFlatOpacity(preferences.nebulaHeatFlatOpacity);
      }
      if (preferences?.nebulaLogDensityMode) {
        graphStore.setNebulaLogDensityMode(preferences.nebulaLogDensityMode);
      }
      if (preferences?.sortMode) graphStore.setSortMode(preferences.sortMode);
      if (preferences?.customStartDate !== undefined) {
        graphStore.customStartDate = preferences.customStartDate;
        localStorage.setItem('nebula.customStartDate', preferences.customStartDate);
      }
      if (preferences?.customEndDate !== undefined) {
        graphStore.customEndDate = preferences.customEndDate;
        localStorage.setItem('nebula.customEndDate', preferences.customEndDate);
      }
      preferencesReady.value = true;
    } catch {
      // Use local defaults
      preferencesReady.value = true;
    }
  }

  async function savePreferencesNow() {
    if (!currentUser.value) return;
    if (preferenceSyncTimer.value) clearTimeout(preferenceSyncTimer.value);
    preferenceSyncTimer.value = null;
    preferenceSyncing.value = true;
    try {
      await updateUserPreferences(buildPreferences());
    } catch (error) {
      const uiStore = useUiStore();
      uiStore.showNotice('偏好同步失败');
      throw error;
    } finally {
      preferenceSyncing.value = false;
    }
  }

  function schedulePreferenceSync() {
    if (preferenceSyncTimer.value) clearTimeout(preferenceSyncTimer.value);
    preferenceSyncTimer.value = window.setTimeout(() => {
      void savePreferencesNow().catch(() => {
        // The visible notice is handled in savePreferencesNow.
      });
    }, 1200);
  }

  return {
    currentUser,
    checkingAuth,
    preferencesReady,
    preferenceSyncing,
    rendererMode,
    layoutMode,
    themeMode,
    checkAuth,
    acceptAuthenticatedUser,
    handleLogin,
    handleRegister,
    handleLogout,
    handleChangePassword,
    setRendererMode,
    setLayoutMode,
    setThemeMode,
    syncPreferences,
    savePreferencesNow,
    schedulePreferenceSync
  };
});
