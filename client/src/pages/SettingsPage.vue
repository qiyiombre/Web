<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  Cpu,
  FileText,
  Globe,
  Gauge,
  KeyRound,
  Layers,
  Link2,
  LogOut,
  Map as MapIcon,
  Orbit,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Tags,
  UserRound
} from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useGraphStore } from '../stores/graph';
import { useMapsStore } from '../stores/maps';
import { useUiStore } from '../stores/ui';

const auth = useAuthStore();
const graphStore = useGraphStore();
const mapsStore = useMapsStore();
const ui = useUiStore();
const router = useRouter();

const savingPrefs = ref(false);

// Password change state
const pwForm = ref({ current: '', newPw: '', confirm: '' });
const pwError = ref('');
const pwSaving = ref(false);
const pwSuccess = ref(false);

onMounted(async () => {
  await mapsStore.fetchMaps();
  const id = mapsStore.activeMapId ?? mapsStore.maps[0]?.id;
  if (id && (!mapsStore.graph || mapsStore.graph.map.id !== id)) {
    await mapsStore.selectMap(id);
  }
});

const accountStats = computed(() => ({
  maps: mapsStore.maps.length,
  logs: mapsStore.graph?.logs.length ?? 0,
  tags: mapsStore.graph?.tags.length ?? 0
}));

const userInitials = computed(() => {
  const username = auth.currentUser?.username.trim() ?? '';
  if (!username) return '--';
  const words = username.match(/[A-Za-z0-9]+/g);
  if (words && words.length > 1) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return username.replace(/\s+/g, '').slice(0, 2).toUpperCase();
});

const activeMap = computed(() => (
  mapsStore.graph?.map ??
  mapsStore.maps.find(map => map.id === mapsStore.activeMapId) ??
  mapsStore.maps[0] ??
  null
));

const rendererLabel = computed(() => (auth.rendererMode === 'webgpu' ? 'WebGPU' : 'Canvas'));
const layoutLabel = computed(() => (auth.layoutMode === 'domain' ? '领域布局' : '语义布局'));
const timeFilterLabel = computed(() => {
  if (graphStore.timeFilter === 'week') return '近 7 天';
  if (graphStore.timeFilter === 'month') return '近 30 天';
  if (graphStore.timeFilter === 'quarter') return '近 90 天';
  if (graphStore.timeFilter === 'custom') {
    const start = graphStore.customStartDate || '不限';
    const end = graphStore.customEndDate || '不限';
    return `${start} 至 ${end}`;
  }
  return '全部时间';
});
const frequencyLabel = computed(() => {
  if (graphStore.frequencyFilter === 'high') return '高频';
  if (graphStore.frequencyFilter === 'low') return '低频';
  return '全部频率';
});
const sortLabel = computed(() => {
  if (graphStore.sortMode === 'frequency') return '高频优先';
  if (graphStore.sortMode === 'lowFrequency') return '低频优先';
  if (graphStore.sortMode === 'recent') return '最近活跃';
  return '布局顺序';
});

async function savePreferences() {
  savingPrefs.value = true;
  try {
    await auth.savePreferencesNow();
    ui.showNotice('偏好已同步');
  } catch {
    // savePreferencesNow already shows the visible failure notice.
  } finally {
    savingPrefs.value = false;
  }
}

async function handleChangePassword() {
  pwError.value = '';
  if (pwForm.value.newPw !== pwForm.value.confirm) {
    pwError.value = '两次输入的新密码不一致';
    return;
  }
  if (pwForm.value.newPw.length < 6) {
    pwError.value = '新密码至少 6 位';
    return;
  }
  if (pwForm.value.newPw.length > 72) {
    pwError.value = '新密码不能超过 72 位';
    return;
  }
  pwSaving.value = true;
  try {
    await auth.handleChangePassword(pwForm.value.current, pwForm.value.newPw);
    pwForm.value = { current: '', newPw: '', confirm: '' };
    pwSuccess.value = true;
    setTimeout(() => pwSuccess.value = false, 3000);
  } catch (e: any) {
    pwError.value = e.message ?? '密码修改失败';
  } finally {
    pwSaving.value = false;
  }
}

function openManagement(target: 'maps' | 'tags' | 'domains') {
  const id = mapsStore.activeMapId ?? mapsStore.maps[0]?.id;
  if (!id) {
    ui.showNotice('请先创建一个星图');
    return;
  }
  const drawer = target === 'tags' ? 'manage' : target;
  router.push({ path: `/maps/${id}`, query: { drawer } });
}

function openCurrentMap() {
  const id = activeMap.value?.id;
  if (!id) {
    ui.showNotice('请先创建一个星图');
    return;
  }
  router.push(`/maps/${id}`);
}

function openCurrentLogs() {
  const id = activeMap.value?.id;
  if (!id) {
    ui.showNotice('请先创建一个星图');
    return;
  }
  router.push(`/maps/${id}/logs`);
}

function resetDisplayPreferences() {
  auth.setRendererMode('canvas');
  auth.setLayoutMode('semantic');
  graphStore.setTimeFilter('all');
  graphStore.setFrequencyFilter('all');
  graphStore.setHighFrequencyMinimum(2);
  graphStore.setLowFrequencyMaximum(1);
  graphStore.setInsightTopLimit(8);
  graphStore.setInsightTrendLimit(5);
  graphStore.setInsightCooccurrenceLimit(8);
  graphStore.setSortMode('layout');
  graphStore.customStartDate = '';
  graphStore.customEndDate = '';
  graphStore.persistToLocalStorage();
  auth.schedulePreferenceSync();
  ui.showNotice('显示偏好已重置');
}

async function handleLogout() {
  await auth.handleLogout();
  router.push('/');
}

</script>

<template>
  <div class="settings-page stardust-page stardust-page--quiet">
    <header class="page-header">
      <div class="header-left">
        <button class="icon-button" title="返回首页" @click="router.push('/')">
          <ChevronLeft :size="18" />
        </button>
        <h2>设置</h2>
      </div>
    </header>

    <div class="settings-content">
      <main class="settings-main">
  <!-- Renderer preferences -->
        <section class="setting-card main-card renderer-card">
          <div class="card-head">
            <Cpu :size="18" />
            <h3>渲染引擎</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div>
                <strong>Canvas</strong>
                <small>兼容性好，所有设备可用</small>
              </div>
              <button
                class="toggle-btn"
                :class="{ active: auth.rendererMode === 'canvas' }"
                @click="auth.setRendererMode('canvas')"
              >
                {{ auth.rendererMode === 'canvas' ? '✓ 当前' : '切换' }}
              </button>
            </div>
            <div class="setting-row">
              <div>
                <strong>WebGPU</strong>
                <small>高性能 GPU 渲染，需现代浏览器</small>
              </div>
              <button
                class="toggle-btn"
                :class="{ active: auth.rendererMode === 'webgpu' }"
                @click="auth.setRendererMode('webgpu')"
              >
                {{ auth.rendererMode === 'webgpu' ? '✓ 当前' : '切换' }}
              </button>
            </div>
          </div>
        </section>

  <!-- Layout preferences -->
        <section class="setting-card main-card layout-card">
          <div class="card-head">
            <Globe :size="18" />
            <h3>星云布局</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div>
                <strong><Link2 :size="14" /> 语义布局</strong>
                <small>AI 分析标签语义相似度自动排布</small>
              </div>
              <button
                class="toggle-btn"
                :class="{ active: auth.layoutMode === 'semantic' }"
                @click="auth.setLayoutMode('semantic')"
              >
                {{ auth.layoutMode === 'semantic' ? '✓ 当前' : '切换' }}
              </button>
            </div>
            <div class="setting-row">
              <div>
                <strong><Layers :size="14" /> 领域布局</strong>
                <small>按领域大类分组排列标签</small>
              </div>
              <button
                class="toggle-btn"
                :class="{ active: auth.layoutMode === 'domain' }"
                @click="auth.setLayoutMode('domain')"
              >
                {{ auth.layoutMode === 'domain' ? '✓ 当前' : '切换' }}
              </button>
            </div>
          </div>
        </section>

  <!-- Filter preferences -->
        <section class="setting-card main-card preferences-card">
          <div class="card-head">
            <SlidersHorizontal :size="18" />
            <h3>显示偏好</h3>
          </div>
          <div class="card-body">
            <div class="setting-row stacked">
              <div>
                <strong><CalendarDays :size="14" /> 时间范围</strong>
                <small>控制星云图和日志列表显示哪些时间段的数据</small>
              </div>
              <div class="segmented-control">
                <button :class="{ active: graphStore.timeFilter === 'all' }" @click="graphStore.setTimeFilter('all')">全部</button>
                <button :class="{ active: graphStore.timeFilter === 'week' }" @click="graphStore.setTimeFilter('week')">7天</button>
                <button :class="{ active: graphStore.timeFilter === 'month' }" @click="graphStore.setTimeFilter('month')">30天</button>
                <button :class="{ active: graphStore.timeFilter === 'quarter' }" @click="graphStore.setTimeFilter('quarter')">90天</button>
                <button :class="{ active: graphStore.timeFilter === 'custom' }" @click="graphStore.setTimeFilter('custom')">自定义</button>
              </div>
              <div v-if="graphStore.timeFilter === 'custom'" class="date-input-row">
                <input v-model="graphStore.customStartDate" type="date" @change="graphStore.persistToLocalStorage()" />
                <span>至</span>
                <input v-model="graphStore.customEndDate" type="date" @change="graphStore.persistToLocalStorage()" />
              </div>
            </div>
            <div class="setting-row stacked">
              <div>
                <strong><Gauge :size="14" /> 使用频率</strong>
                <small>按当前时间范围内的标签使用次数过滤</small>
              </div>
              <div class="segmented-control">
                <button :class="{ active: graphStore.frequencyFilter === 'all' }" @click="graphStore.setFrequencyFilter('all')">全部频率</button>
                <button :class="{ active: graphStore.frequencyFilter === 'high' }" @click="graphStore.setFrequencyFilter('high')">高频</button>
                <button :class="{ active: graphStore.frequencyFilter === 'low' }" @click="graphStore.setFrequencyFilter('low')">低频</button>
              </div>
              <div class="threshold-grid">
                <label class="threshold-field">
                  <span>高频至少</span>
                  <input
                    v-model.number="graphStore.highFrequencyMinimum"
                    type="number"
                    min="2"
                    max="99"
                    @change="graphStore.setHighFrequencyMinimum(graphStore.highFrequencyMinimum)"
                  />
                  <span>篇日志</span>
                </label>
                <label class="threshold-field">
                  <span>低频至多</span>
                  <input
                    v-model.number="graphStore.lowFrequencyMaximum"
                    type="number"
                    min="1"
                    :max="Math.max(1, graphStore.highFrequencyMinimum - 1)"
                    @change="graphStore.setLowFrequencyMaximum(graphStore.lowFrequencyMaximum)"
                  />
                  <span>篇日志</span>
                </label>
              </div>
              <p class="setting-hint">频率只统计当前星图和当前时间范围；同一篇日志里的同一标签只算 1 次。</p>
            </div>
            <div class="setting-row stacked">
              <div>
                <strong><Layers :size="14" /> 排序方式</strong>
                <small>控制标签在星云图里的优先展示顺序</small>
              </div>
              <div class="segmented-control wrap">
                <button :class="{ active: graphStore.sortMode === 'layout' }" @click="graphStore.setSortMode('layout')">布局</button>
                <button :class="{ active: graphStore.sortMode === 'frequency' }" @click="graphStore.setSortMode('frequency')">高频优先</button>
                <button :class="{ active: graphStore.sortMode === 'lowFrequency' }" @click="graphStore.setSortMode('lowFrequency')">低频优先</button>
                <button :class="{ active: graphStore.sortMode === 'recent' }" @click="graphStore.setSortMode('recent')">最近活跃</button>
              </div>
            </div>
            <div class="setting-row stacked">
              <div>
                <strong><Sparkles :size="14" /> 洞察展示数量</strong>
                <small>控制洞察页和星图抽屉里默认展示多少条分析结果</small>
              </div>
              <div class="insight-limit-grid">
                <label class="threshold-field">
                  <span>高频标签</span>
                  <input
                    v-model.number="graphStore.insightTopLimit"
                    type="number"
                    min="3"
                    max="20"
                    @change="graphStore.setInsightTopLimit(graphStore.insightTopLimit)"
                  />
                  <span>条</span>
                </label>
                <label class="threshold-field">
                  <span>趋势标签</span>
                  <input
                    v-model.number="graphStore.insightTrendLimit"
                    type="number"
                    min="3"
                    max="20"
                    @change="graphStore.setInsightTrendLimit(graphStore.insightTrendLimit)"
                  />
                  <span>条</span>
                </label>
                <label class="threshold-field">
                  <span>共现关系</span>
                  <input
                    v-model.number="graphStore.insightCooccurrenceLimit"
                    type="number"
                    min="3"
                    max="20"
                    @change="graphStore.setInsightCooccurrenceLimit(graphStore.insightCooccurrenceLimit)"
                  />
                  <span>条</span>
                </label>
              </div>
            </div>
          </div>
        </section>

  <!-- Password -->
        <section class="setting-card main-card password-card">
          <div class="card-head">
            <KeyRound :size="18" />
            <h3>修改密码</h3>
          </div>
          <div class="card-body">
            <form class="pw-form" @submit.prevent="handleChangePassword">
              <input
                v-model="pwForm.current"
                type="password"
                placeholder="当前密码"
                autocomplete="current-password"
              />
              <input
                v-model="pwForm.newPw"
                type="password"
                placeholder="新密码"
                autocomplete="new-password"
              />
              <input
                v-model="pwForm.confirm"
                type="password"
                placeholder="确认新密码"
                autocomplete="new-password"
              />
              <p v-if="pwError" class="form-error">{{ pwError }}</p>
              <p v-if="pwSuccess" class="form-success">✓ 密码已修改</p>
              <button class="primary-button" :disabled="pwSaving">
                {{ pwSaving ? '保存中...' : '保存密码' }}
              </button>
            </form>
          </div>
        </section>
      </main>

      <aside class="settings-side">
  <!-- Account section -->
        <section class="setting-card side-card account-card">
          <div class="card-head">
            <UserRound :size="18" />
            <h3>账户</h3>
          </div>
          <div v-if="auth.currentUser" class="card-body">
          <div class="account-info">
            <div class="avatar-big">
              {{ userInitials }}
            </div>
              <div>
                <strong>{{ auth.currentUser.username }}</strong>
                <small>注册于 {{ new Date(auth.currentUser.createdAt).toLocaleDateString('zh-CN') }}</small>
              </div>
            </div>
            <div class="account-stat-grid">
              <div class="mini-stat">
                <MapIcon :size="15" />
                <span>{{ accountStats.maps }}</span>
                <small>星图</small>
              </div>
              <div class="mini-stat">
                <FileText :size="15" />
                <span>{{ accountStats.logs }}</span>
                <small>日志</small>
              </div>
              <div class="mini-stat">
                <Tags :size="15" />
                <span>{{ accountStats.tags }}</span>
                <small>标签</small>
              </div>
            </div>
            <button class="danger-outline wide" @click="handleLogout">
              <LogOut :size="15" />
              退出登录
            </button>
          </div>
        </section>

  <!-- Current map overview -->
        <section class="setting-card side-card current-map-card">
          <div class="card-head">
            <Orbit :size="18" />
            <h3>当前星图</h3>
          </div>
          <div class="card-body">
            <div v-if="activeMap" class="current-map-overview">
              <div class="map-orbit-mark">
                <Orbit :size="24" />
              </div>
              <div class="map-overview-copy">
                <strong>{{ activeMap.name }}</strong>
                <small>{{ activeMap.description || '暂无描述' }}</small>
              </div>
            </div>
            <div v-else class="current-map-empty">
              <strong>还没有星图</strong>
              <small>创建星图后，这里会显示当前工作区概览。</small>
            </div>
            <div class="quick-stat-row">
              <span><FileText :size="14" />{{ accountStats.logs }} 日志</span>
              <span><Tags :size="14" />{{ accountStats.tags }} 标签</span>
            </div>
            <div class="side-action-row">
              <button class="secondary-button" type="button" @click="openCurrentMap">
                <MapIcon :size="15" />
                进入星图
              </button>
              <button class="secondary-button" type="button" @click="openCurrentLogs">
                <FileText :size="15" />
                写日志
              </button>
            </div>
          </div>
        </section>

  <!-- Quick management -->
        <section class="setting-card side-card manage-card">
          <div class="card-head">
            <ArrowRight :size="18" />
            <h3>快捷管理</h3>
          </div>
          <div class="card-body">
            <div class="manage-grid">
              <button class="manage-entry" @click="openManagement('maps')">
                <MapIcon :size="17" />
                <span>星图</span>
              </button>
              <button class="manage-entry" @click="openManagement('tags')">
                <Tags :size="17" />
                <span>标签管理</span>
              </button>
              <button class="manage-entry" @click="openManagement('domains')">
                <Layers :size="17" />
                <span>领域大类</span>
              </button>
            </div>
          </div>
        </section>

  <!-- Preference overview -->
        <section class="setting-card side-card preference-overview-card">
          <div class="card-head">
            <Sparkles :size="18" />
            <h3>偏好预览</h3>
          </div>
          <div class="card-body">
            <div class="preference-token-grid">
              <div class="preference-token">
                <small>渲染</small>
                <strong>{{ rendererLabel }}</strong>
              </div>
              <div class="preference-token">
                <small>布局</small>
                <strong>{{ layoutLabel }}</strong>
              </div>
              <div class="preference-token wide">
                <small>时间</small>
                <strong>{{ timeFilterLabel }}</strong>
              </div>
              <div class="preference-token">
                <small>频率</small>
                <strong>{{ frequencyLabel }}</strong>
              </div>
              <div class="preference-token">
                <small>排序</small>
                <strong>{{ sortLabel }}</strong>
              </div>
            </div>
            <button class="secondary-button wide-button" type="button" @click="resetDisplayPreferences">
              <RotateCcw :size="15" />
              重置显示偏好
            </button>
          </div>
        </section>

  <!-- Sync -->
        <section class="setting-card side-card sync-card">
          <div class="card-head">
            <Save :size="18" />
            <h3>偏好同步</h3>
          </div>
          <div class="card-body">
            <p class="muted">渲染和布局偏好会在切换时自动同步到云端。</p>
            <button class="secondary-button" :disabled="savingPrefs" @click="savePreferences">
              <Save :size="15" />
              {{ savingPrefs ? '同步中...' : '立即同步' }}
            </button>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.settings-page > * {
  position: relative;
  z-index: 1;
}

.page-header {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: rgba(10, 20, 36, 0.9);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  position: sticky;
  top: 0;
  z-index: 10;
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

.settings-content {
  width: 100%;
  max-width: 1180px;
  box-sizing: border-box;
  margin: 0 auto;
  padding: 24px 28px 60px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  align-items: start;
  gap: 16px;
}

.settings-main,
.settings-side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
}

/* Cards */
.setting-card {
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  overflow: hidden;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  color: rgba(238, 246, 255, 0.7);
}

.card-head h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.card-body {
  padding: 16px 18px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  gap: 16px;
}

.setting-row.stacked {
  align-items: flex-start;
  flex-direction: column;
  gap: 10px;
}

.setting-row + .setting-row {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.setting-row strong {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  margin-bottom: 2px;
}

.setting-row small {
  font-size: 12px;
  color: rgba(238, 246, 255, 0.35);
}

.toggle-btn {
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(238, 246, 255, 0.5);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}

.toggle-btn.active {
  background: rgba(98, 214, 255, 0.15);
  border-color: rgba(98, 214, 255, 0.3);
  color: #62d6ff;
}

.toggle-btn:hover:not(.active) {
  background: rgba(255, 255, 255, 0.08);
}

/* Account */
.account-info {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}

.avatar-big {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background:
    linear-gradient(135deg, rgba(98, 214, 255, 0.22), rgba(185, 156, 255, 0.14)),
    rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(98, 214, 255, 0.24);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #62d6ff;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0;
  flex-shrink: 0;
}

.account-info strong {
  display: block;
  font-size: 16px;
  margin-bottom: 4px;
}

.account-info small {
  font-size: 12px;
  color: rgba(238, 246, 255, 0.35);
}

.account-stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}

.mini-stat {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas:
    "icon value"
    "icon label";
  align-items: center;
  column-gap: 8px;
  padding: 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
  color: rgba(238, 246, 255, 0.5);
}

.mini-stat svg {
  grid-area: icon;
  color: #62d6ff;
}

.mini-stat span {
  grid-area: value;
  color: #eef6ff;
  font-size: 16px;
  font-weight: 700;
}

.mini-stat small {
  grid-area: label;
  font-size: 11px;
  color: rgba(238, 246, 255, 0.36);
}

.current-map-overview {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.map-orbit-mark {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #62d6ff;
  background:
    radial-gradient(circle at 50% 50%, rgba(98, 214, 255, 0.26), rgba(98, 214, 255, 0.06) 62%),
    rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(98, 214, 255, 0.18);
}

.map-overview-copy {
  min-width: 0;
}

.map-overview-copy strong,
.current-map-empty strong {
  display: block;
  color: #eef6ff;
  font-size: 15px;
  margin-bottom: 4px;
}

.map-overview-copy small,
.current-map-empty small {
  display: block;
  color: rgba(238, 246, 255, 0.38);
  font-size: 12px;
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
}

.current-map-empty {
  padding: 10px 0 12px;
}

.quick-stat-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.quick-stat-row span {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 10px;
  border-radius: 9px;
  color: rgba(238, 246, 255, 0.62);
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
}

.quick-stat-row svg {
  color: #62d6ff;
}

.side-action-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.side-action-row .secondary-button {
  justify-content: center;
  padding-inline: 10px;
}

.preference-token-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.preference-token {
  min-width: 0;
  padding: 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.preference-token.wide {
  grid-column: 1 / -1;
}

.preference-token small {
  display: block;
  color: rgba(238, 246, 255, 0.38);
  font-size: 11px;
  margin-bottom: 4px;
}

.preference-token strong {
  display: block;
  color: #eef6ff;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.segmented-control {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  width: 100%;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
}

.segmented-control.wrap {
  flex-wrap: wrap;
  overflow: visible;
  border: none;
  gap: 6px;
  background: transparent;
}

.segmented-control button {
  min-height: 34px;
  padding: 7px 12px;
  border: none;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  background: transparent;
  color: rgba(238, 246, 255, 0.55);
  font-size: 12px;
  cursor: pointer;
  flex: 1;
  white-space: nowrap;
}

.segmented-control.wrap button {
  flex: 0 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.035);
}

.segmented-control button:last-child {
  border-right: none;
}

.segmented-control button.active {
  background: rgba(98, 214, 255, 0.16);
  color: #62d6ff;
}

.date-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: rgba(238, 246, 255, 0.45);
  font-size: 12px;
}

.date-input-row input {
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #eef6ff;
  font-size: 12px;
}

.threshold-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.insight-limit-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.threshold-field {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  color: rgba(238, 246, 255, 0.55);
  font-size: 12px;
}

.threshold-field input {
  width: 54px;
  min-width: 0;
  padding: 5px 7px;
  border-radius: 7px;
  border: 1px solid rgba(98, 214, 255, 0.2);
  background: rgba(8, 17, 31, 0.68);
  color: #eef6ff;
  font-weight: 700;
  text-align: center;
  outline: none;
}

.setting-hint {
  margin: 0;
  color: rgba(238, 246, 255, 0.35);
  font-size: 12px;
  line-height: 1.55;
}

.manage-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.manage-entry {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-height: 42px;
  padding: 0 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #eef6ff;
  font-size: 13px;
  cursor: pointer;
}

.manage-entry:hover {
  background: rgba(98, 214, 255, 0.1);
  border-color: rgba(98, 214, 255, 0.22);
  color: #62d6ff;
}

/* Password */
.pw-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 320px;
}

.pw-form input {
  padding: 9px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #eef6ff;
  font-size: 13px;
  outline: none;
}

.pw-form input:focus {
  border-color: rgba(98, 214, 255, 0.3);
}

.form-error {
  color: #ff8fa3;
  font-size: 12px;
  margin: 0;
}

.form-success {
  color: #8cf0b4;
  font-size: 12px;
  margin: 0;
}

/* Buttons */
.primary-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 20px;
  border-radius: 8px;
  background: #62d6ff;
  color: #08111f;
  font-weight: 600;
  font-size: 13px;
  border: none;
  cursor: pointer;
}

.primary-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.secondary-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: #eef6ff;
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 13px;
  cursor: pointer;
}

.secondary-button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
}

.wide-button {
  width: 100%;
  justify-content: center;
}

.danger-outline {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  background: transparent;
  color: #ff8fa3;
  border: 1px solid rgba(255, 143, 163, 0.3);
  font-size: 13px;
  cursor: pointer;
}

.danger-outline:hover {
  background: rgba(255, 143, 163, 0.08);
}

.muted {
  color: rgba(238, 246, 255, 0.35);
  font-size: 13px;
  margin: 0 0 12px;
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
  color: rgba(238, 246, 255, 0.5);
  cursor: pointer;
}

.icon-button:hover { color: #eef6ff; background: rgba(255, 255, 255, 0.06); }

@media (prefers-reduced-motion: reduce) {
  .settings-page {
    animation: none;
  }
}

@media (max-width: 980px) {
  .settings-content {
    grid-template-columns: 1fr;
    padding: 20px 16px 48px;
  }

  .manage-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .manage-entry {
    justify-content: center;
  }
}

@media (max-width: 620px) {
  .account-stat-grid,
  .manage-grid,
  .threshold-grid,
  .insight-limit-grid {
    grid-template-columns: 1fr;
  }

  .segmented-control {
    flex-wrap: wrap;
    overflow: visible;
    border: none;
    gap: 6px;
    background: transparent;
  }

  .segmented-control button {
    flex: 1 1 calc(50% - 6px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
  }
}
</style>
