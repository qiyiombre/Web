<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { useGraphStore } from './stores/graph';
import { useUiStore } from './stores/ui';
import AuthPanel from './components/AuthPanel.vue';
import AssistantPanel from './components/AssistantPanel.vue';
import NavBar from './components/layout/NavBar.vue';
import type { UserAccount } from './types/domain';

const auth = useAuthStore();
const graphStore = useGraphStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

const showGlobalConfirm = computed(() => Boolean(ui.nebulaConfirm) && route.name !== 'map');

watch(
  () => [
    graphStore.timeFilter,
    graphStore.frequencyFilter,
    graphStore.highFrequencyMinimum,
    graphStore.lowFrequencyMaximum,
    graphStore.insightTopLimit,
    graphStore.insightTrendLimit,
    graphStore.insightCooccurrenceLimit,
    graphStore.sortMode,
    graphStore.customStartDate,
    graphStore.customEndDate
  ],
  () => {
    graphStore.persistToLocalStorage();
    if (auth.currentUser && auth.preferencesReady) {
      auth.schedulePreferenceSync();
    }
  }
);

onMounted(async () => {
  graphStore.initFromLocalStorage();
  ui.setupNetworkListeners();
  await auth.checkAuth();
});

async function handleAuthenticated(user: UserAccount) {
  await auth.acceptAuthenticatedUser(user);
  router.push('/');
}

async function confirmGlobalAction() {
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
</script>

<template>
  <AuthPanel v-if="!auth.checkingAuth && !auth.currentUser" @authenticated="handleAuthenticated" />

  <div v-else-if="auth.currentUser" class="app-root">
    <NavBar />
    <div v-if="ui.notice" class="global-notice success">{{ ui.notice }}</div>
    <div v-if="!ui.isOnline" class="global-notice warning">当前离线：可以继续写新日志，草稿会自动保存到 IndexedDB。</div>
    <div v-if="showGlobalConfirm && ui.nebulaConfirm" class="global-confirm-backdrop" @click.self="ui.closeConfirm">
      <section class="global-confirm-card" role="dialog" aria-modal="true">
        <p class="global-confirm-title">{{ ui.nebulaConfirm.title }}</p>
        <p class="global-confirm-message">{{ ui.nebulaConfirm.message }}</p>
        <div class="global-confirm-actions">
          <button class="secondary-button" type="button" :disabled="ui.nebulaConfirm.pending" @click="ui.closeConfirm">
            取消
          </button>
          <button class="danger-confirm" type="button" :disabled="ui.nebulaConfirm.pending" @click="confirmGlobalAction">
            {{ ui.nebulaConfirm.pending ? '处理中...' : ui.nebulaConfirm.confirmLabel }}
          </button>
        </div>
      </section>
    </div>
    <main class="app-main">
      <router-view />
    </main>
    <AssistantPanel />
  </div>

  <div v-else class="app-splash">
    <div class="splash-logo">
      <div class="splash-ring" />
    </div>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 100vh;
  overflow: hidden;
  background: #08111f;
}

.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.app-splash {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: #08111f;
}

.splash-ring {
  width: 36px;
  height: 36px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: #62d6ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.global-notice {
  position: fixed;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 300;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 13px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  animation: fadeInNotice 0.25s ease;
  pointer-events: none;
}

.global-notice.success {
  background: rgba(140, 240, 180, 0.15);
  color: #8cf0b4;
  border: 1px solid rgba(140, 240, 180, 0.3);
}

.global-notice.warning {
  background: rgba(247, 215, 116, 0.15);
  color: #f7d774;
  border: 1px solid rgba(247, 215, 116, 0.3);
}

.global-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 350;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(2, 8, 18, 0.58);
  backdrop-filter: blur(8px);
}

.global-confirm-card {
  width: min(420px, 100%);
  border-radius: 12px;
  padding: 20px;
  background: rgba(16, 29, 48, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 20px 64px rgba(0, 0, 0, 0.45);
}

.global-confirm-title {
  margin: 0 0 8px;
  color: #eef6ff;
  font-size: 16px;
  font-weight: 700;
}

.global-confirm-message {
  margin: 0;
  color: rgba(238, 246, 255, 0.62);
  font-size: 13px;
  line-height: 1.65;
}

.global-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.secondary-button,
.danger-confirm {
  min-width: 76px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 13px;
  cursor: pointer;
}

.secondary-button {
  background: rgba(255, 255, 255, 0.05);
  color: #eef6ff;
}

.danger-confirm {
  background: rgba(255, 143, 163, 0.16);
  border-color: rgba(255, 143, 163, 0.3);
  color: #ff9caf;
}

.secondary-button:disabled,
.danger-confirm:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@keyframes fadeInNotice {
  from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
</style>
