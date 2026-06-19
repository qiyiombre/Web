<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  Cpu,
  FileText,
  Flame,
  Globe,
  Gauge,
  KeyRound,
  Layers,
  Link2,
  LogOut,
  Map as MapIcon,
  Orbit,
  Palette,
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
import { THEME_OPTIONS } from '../constants/themes';

type SettingsSection = 'overview' | 'appearance' | 'nebula' | 'insights' | 'security';

const auth = useAuthStore();
const graphStore = useGraphStore();
const mapsStore = useMapsStore();
const ui = useUiStore();
const router = useRouter();

const savingPrefs = ref(false);
const activeSection = ref<SettingsSection>('overview');
const settingsSections: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: 'overview', label: '概览', description: '账号、当前星图和快捷入口' },
  { id: 'appearance', label: '外观', description: '主题、渲染和布局' },
  { id: 'nebula', label: '星云与筛选', description: '筛选、排序、密集显示' },
  { id: 'insights', label: '洞察展示', description: '分析模块数量和口径' },
  { id: 'security', label: '账号安全', description: '密码和登录状态' }
];

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
const themeLabel = computed(() => THEME_OPTIONS.find(theme => theme.id === auth.themeMode)?.label ?? '深空蓝');
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
  auth.setThemeMode('deepSpace');
  graphStore.setTimeFilter('all');
  graphStore.setFrequencyFilter('all');
  graphStore.setHighFrequencyMinimum(2);
  graphStore.setLowFrequencyMaximum(1);
  graphStore.setInsightTopLimit(8);
  graphStore.setInsightTrendLimit(5);
  graphStore.setInsightCooccurrenceLimit(8);
  graphStore.setNebulaPriorityDisplayLimit(8);
  graphStore.setNebulaHeatWindowDays(7);
  graphStore.setNebulaHeatMinimumDelta(1);
  graphStore.setNebulaHeatMediumDelta(2);
  graphStore.setNebulaHeatStrongDelta(4);
  graphStore.setNebulaHeatFlatOpacity(28);
  graphStore.setNebulaLogDensityMode('auto');
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
      <aside class="settings-sidebar">
        <button
          v-for="section in settingsSections"
          :key="section.id"
          type="button"
          class="settings-section-tab"
          :class="{ active: activeSection === section.id }"
          @click="activeSection = section.id"
        >
          <strong>{{ section.label }}</strong>
          <span>{{ section.description }}</span>
        </button>
      </aside>

      <main class="settings-main">
        <section v-show="activeSection === 'appearance'" class="setting-card main-card theme-card">
          <div class="card-head">
            <Palette :size="18" />
            <h3>外观主题</h3>
          </div>
          <div class="card-body">
            <div class="theme-choice-grid">
              <button
                v-for="theme in THEME_OPTIONS"
                :key="theme.id"
                type="button"
                class="theme-choice"
                :class="[`theme-choice--${theme.id}`, { active: auth.themeMode === theme.id }]"
                @click="auth.setThemeMode(theme.id)"
              >
                <span class="theme-swatch">
                  <i v-for="color in theme.swatches" :key="color" :style="{ color, background: color }" />
                </span>
                <strong>{{ theme.label }}</strong>
                <small>{{ theme.description }}</small>
              </button>
            </div>
          </div>
        </section>
  <!-- Renderer preferences -->
        <section v-show="activeSection === 'appearance'" class="setting-card main-card renderer-card">
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
        <section v-show="activeSection === 'appearance'" class="setting-card main-card layout-card">
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
        <section v-show="activeSection === 'nebula'" class="setting-card main-card preferences-card">
          <div class="card-head">
            <SlidersHorizontal :size="18" />
            <h3>筛选与排序</h3>
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
          </div>
        </section>

        <section v-show="activeSection === 'nebula'" class="setting-card main-card density-heat-card">
          <div class="card-head">
            <Flame :size="18" />
            <h3>日志密集与热力</h3>
          </div>
          <div class="card-body">
            <div class="setting-row stacked">
              <div>
                <strong><SlidersHorizontal :size="14" /> 日志密集显示</strong>
                <small>控制大数据量星图中日志节点是自动聚合，还是始终显示单条日志。</small>
              </div>
              <div class="segmented-control">
                <button
                  :class="{ active: graphStore.nebulaLogDensityMode === 'auto' }"
                  @click="graphStore.setNebulaLogDensityMode('auto')"
                >
                  自动聚合
                </button>
                <button
                  :class="{ active: graphStore.nebulaLogDensityMode === 'single' }"
                  @click="graphStore.setNebulaLogDensityMode('single')"
                >
                  始终单条
                </button>
              </div>
              <p class="setting-hint">自动聚合只影响星云视觉层；日志列表、洞察统计、删除和编辑仍然按真实日志处理。</p>
            </div>
            <div class="setting-row stacked">
              <div>
                <strong><Flame :size="14" /> WebGPU 热力参数</strong>
                <small>控制热力按钮的标签升温/降温判断，只影响 WebGPU 星云图</small>
              </div>
              <div class="insight-limit-grid">
                <label class="threshold-field">
                  <span>对比窗口</span>
                  <input
                    v-model.number="graphStore.nebulaHeatWindowDays"
                    type="number"
                    min="1"
                    max="90"
                    @change="graphStore.setNebulaHeatWindowDays(graphStore.nebulaHeatWindowDays)"
                  />
                  <span>天</span>
                </label>
                <label class="threshold-field">
                  <span>最小变化</span>
                  <input
                    v-model.number="graphStore.nebulaHeatMinimumDelta"
                    type="number"
                    min="1"
                    max="99"
                    @change="graphStore.setNebulaHeatMinimumDelta(graphStore.nebulaHeatMinimumDelta)"
                  />
                  <span>次</span>
                </label>
                <label class="threshold-field">
                  <span>中等变化</span>
                  <input
                    v-model.number="graphStore.nebulaHeatMediumDelta"
                    type="number"
                    :min="graphStore.nebulaHeatMinimumDelta"
                    max="99"
                    @change="graphStore.setNebulaHeatMediumDelta(graphStore.nebulaHeatMediumDelta)"
                  />
                  <span>次</span>
                </label>
                <label class="threshold-field">
                  <span>强烈变化</span>
                  <input
                    v-model.number="graphStore.nebulaHeatStrongDelta"
                    type="number"
                    :min="graphStore.nebulaHeatMediumDelta"
                    max="99"
                    @change="graphStore.setNebulaHeatStrongDelta(graphStore.nebulaHeatStrongDelta)"
                  />
                  <span>次</span>
                </label>
                <label class="threshold-field">
                  <span>无变化透明度</span>
                  <input
                    v-model.number="graphStore.nebulaHeatFlatOpacity"
                    type="number"
                    min="5"
                    max="80"
                    @change="graphStore.setNebulaHeatFlatOpacity(graphStore.nebulaHeatFlatOpacity)"
                  />
                  <span>%</span>
                </label>
              </div>
              <p class="setting-hint">
                例如窗口为 7 天时，会比较最近 7 天和上一个 7 天；差值小于“最小变化”会视为无变化。
              </p>
            </div>
          </div>
        </section>

        <section v-show="activeSection === 'insights'" class="setting-card main-card insight-display-card">
          <div class="card-head">
            <Sparkles :size="18" />
            <h3>洞察展示数量</h3>
          </div>
          <div class="card-body">
            <div class="setting-row stacked">
              <div>
                <strong><Sparkles :size="14" /> 洞察展示数量</strong>
                <small>控制洞察页默认展示多少条分析结果</small>
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
                <label class="threshold-field">
                  <span>星云排行</span>
                  <input
                    v-model.number="graphStore.nebulaPriorityDisplayLimit"
                    type="number"
                    min="0"
                    max="30"
                    @change="graphStore.setNebulaPriorityDisplayLimit(graphStore.nebulaPriorityDisplayLimit)"
                  />
                  <span>个</span>
                </label>
              </div>
              <p class="setting-hint">星云排行控制高频优先、低频优先、最近活跃模式里显示多少个排名标记；设为 0 可以隐藏排行。</p>
            </div>
          </div>
        </section>

  <!-- Password -->
        <section v-show="activeSection === 'security'" class="setting-card main-card password-card">
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
        <section v-show="activeSection === 'overview'" class="setting-card side-card account-card">
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
        <section v-show="activeSection === 'overview'" class="setting-card side-card current-map-card">
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
        <section v-show="activeSection === 'overview'" class="setting-card side-card manage-card">
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
        <section v-show="activeSection === 'overview'" class="setting-card side-card preference-overview-card">
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
                <small>主题</small>
                <strong>{{ themeLabel }}</strong>
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
        <section v-show="activeSection === 'overview'" class="setting-card side-card sync-card">
          <div class="card-head">
            <Save :size="18" />
            <h3>偏好同步</h3>
          </div>
          <div class="card-body">
            <p class="muted">渲染和布局偏好会在切换时自动同步到云端。</p>
            <button class="secondary-button sync-button" :class="{ loading: savingPrefs }" :disabled="savingPrefs" @click="savePreferences">
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
  background: color-mix(in srgb, var(--panel-bg-strong) 92%, transparent);
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
  max-width: 1240px;
  box-sizing: border-box;
  margin: 0 auto;
  padding: 24px 28px 60px;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
}

.settings-sidebar {
  position: sticky;
  top: 76px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--panel-border);
  border-radius: 14px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--panel-bg-strong) 82%, transparent), color-mix(in srgb, var(--panel-bg) 74%, transparent));
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.16);
}

.settings-section-tab {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 11px 12px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text-muted);
  text-align: left;
  cursor: pointer;
  transition:
    background 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease,
    transform 0.16s ease;
}

.settings-section-tab strong {
  font-size: 13px;
  color: color-mix(in srgb, var(--text-strong) 86%, transparent);
}

.settings-section-tab span {
  font-size: 11px;
  line-height: 1.4;
}

.settings-section-tab:hover {
  transform: translateX(1px);
  background: var(--control-bg);
  border-color: var(--control-border);
}

.settings-section-tab.active {
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
  border-color: color-mix(in srgb, var(--accent-primary) 34%, var(--control-border));
  color: var(--text-strong);
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent-primary) 76%, transparent);
}

.settings-main,
.settings-side {
  grid-column: 2;
  grid-row: 1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 16px;
  min-width: 0;
}

.setting-card {
  min-width: 0;
}

.theme-card,
.preferences-card,
.density-heat-card,
.insight-display-card,
.password-card {
  grid-column: 1 / -1;
}

.account-card,
.current-map-card,
.manage-card {
  align-self: stretch;
}

.settings-main .setting-card:nth-child(2) {
  animation-delay: 55ms;
}

.settings-main .setting-card:nth-child(3) {
  animation-delay: 110ms;
}

.settings-main .setting-card:nth-child(4) {
  animation-delay: 165ms;
}

.settings-side .setting-card:nth-child(1) {
  animation-delay: 80ms;
}

.settings-side .setting-card:nth-child(2) {
  animation-delay: 135ms;
}

.settings-side .setting-card:nth-child(3) {
  animation-delay: 190ms;
}

.settings-side .setting-card:nth-child(4) {
  animation-delay: 245ms;
}

.settings-side .setting-card:nth-child(5) {
  animation-delay: 300ms;
}

/* Cards */
.setting-card {
  border-radius: 14px;
  background: color-mix(in srgb, var(--panel-bg) 76%, rgba(255, 255, 255, 0.02));
  border: 1px solid var(--panel-border);
  overflow: hidden;
  animation: settingsCardIn 0.42s ease both;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    background 0.18s ease,
    box-shadow 0.18s ease;
}

.setting-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-primary) 28%, rgba(255, 255, 255, 0.1));
  background: rgba(255, 255, 255, 0.026);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.16);
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

.theme-choice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
}

.theme-choice {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 5px 12px;
  min-height: 92px;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.075);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.018)),
    rgba(6, 13, 22, 0.48);
  color: #edf7ff;
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    background 0.16s ease;
}

.theme-choice:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-primary) 36%, rgba(255, 255, 255, 0.12));
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
}

.theme-choice.active {
  border-color: color-mix(in srgb, var(--accent-primary) 68%, rgba(255, 255, 255, 0.14));
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 14%, transparent), rgba(255, 255, 255, 0.035)),
    rgba(6, 13, 22, 0.54);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent-primary) 18%, transparent),
    0 16px 34px rgba(0, 0, 0, 0.22);
}

.theme-choice strong {
  align-self: end;
  font-size: 14px;
}

.theme-choice small {
  grid-column: 2;
  align-self: start;
  color: rgba(214, 228, 242, 0.68);
  line-height: 1.5;
}

.theme-swatch {
  grid-row: span 2;
  display: grid;
  grid-template-columns: repeat(3, 18px);
  align-items: end;
  gap: 3px;
  width: 70px;
  height: 50px;
  padding: 9px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.theme-swatch i {
  display: block;
  border-radius: 999px;
  box-shadow: 0 0 12px currentColor;
}

.theme-swatch i:nth-child(1) {
  height: 30px;
}

.theme-swatch i:nth-child(2) {
  height: 22px;
}

.theme-swatch i:nth-child(3) {
  height: 14px;
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
  transition:
    transform 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease,
    box-shadow 0.15s ease;
  white-space: nowrap;
  flex-shrink: 0;
}

.toggle-btn.active {
  background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent-primary) 34%, rgba(255, 255, 255, 0.08));
  color: var(--accent-primary);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent-primary) 10%, transparent),
    0 0 18px color-mix(in srgb, var(--accent-primary) 10%, transparent);
  animation: settingsActivePulse 1.8s ease-in-out infinite;
}

.toggle-btn:hover:not(.active) {
  transform: translateY(-1px);
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
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--accent-primary) 22%, transparent),
      color-mix(in srgb, var(--accent-secondary) 14%, transparent)
    ),
    rgba(255, 255, 255, 0.04);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 26%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
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
  transition:
    transform 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;
}

.mini-stat:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-primary) 17%, transparent);
  background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
}

.mini-stat svg {
  grid-area: icon;
  color: var(--accent-primary);
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
  color: var(--accent-primary);
  background:
    radial-gradient(
      circle at 50% 50%,
      color-mix(in srgb, var(--accent-primary) 26%, transparent),
      color-mix(in srgb, var(--accent-primary) 6%, transparent) 62%
    ),
    rgba(255, 255, 255, 0.035);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent);
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
  transition:
    transform 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;
}

.quick-stat-row span:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-primary) 15%, transparent);
  background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
}

.quick-stat-row svg {
  color: var(--accent-primary);
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
  transition:
    transform 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;
}

.preference-token:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-primary) 15%, transparent);
  background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
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
  transition:
    transform 0.14s ease,
    background 0.14s ease,
    color 0.14s ease,
    border-color 0.14s ease,
    box-shadow 0.14s ease;
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
  background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
  color: var(--accent-primary);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 10%, transparent);
}

.segmented-control button:hover:not(.active) {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(238, 246, 255, 0.78);
}

.segmented-control.wrap button:hover:not(.active) {
  transform: translateY(-1px);
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
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    box-shadow 0.16s ease;
}

.date-input-row input:focus {
  border-color: color-mix(in srgb, var(--accent-primary) 34%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 8%, transparent);
  outline: none;
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
  transition:
    border-color 0.16s ease,
    background 0.16s ease;
}

.threshold-field:focus-within {
  border-color: color-mix(in srgb, var(--accent-primary) 23%, transparent);
  background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
}

.threshold-field input {
  width: 54px;
  min-width: 0;
  padding: 5px 7px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent);
  background: rgba(8, 17, 31, 0.68);
  color: #eef6ff;
  font-weight: 700;
  text-align: center;
  outline: none;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.threshold-field input:focus {
  border-color: color-mix(in srgb, var(--accent-primary) 44%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 8%, transparent);
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
  transition:
    transform 0.16s ease,
    background 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease,
    box-shadow 0.16s ease;
}

.manage-entry:hover {
  transform: translateX(2px);
  background: color-mix(in srgb, var(--accent-primary) 11%, transparent);
  border-color: color-mix(in srgb, var(--accent-primary) 24%, transparent);
  color: var(--accent-primary);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.14);
}

/* Password */
.pw-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 320px;
}

.password-card .pw-form {
  max-width: none;
}

.pw-form input {
  padding: 9px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #eef6ff;
  font-size: 13px;
  outline: none;
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    box-shadow 0.16s ease;
}

.pw-form input:focus {
  border-color: color-mix(in srgb, var(--accent-primary) 32%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 8%, transparent);
}

.form-error {
  color: var(--danger);
  font-size: 12px;
  margin: 0;
}

.form-success {
  color: var(--success);
  font-size: 12px;
  margin: 0;
  animation: settingsStatusIn 0.22s ease both;
}

/* Buttons */
.primary-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 20px;
  border-radius: 8px;
  background: var(--accent-primary);
  color: #08111f;
  font-weight: 600;
  font-size: 13px;
  border: none;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease,
    filter 0.15s ease;
}

.primary-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--accent-primary) 24%, transparent);
  filter: brightness(1.04);
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
  transition:
    transform 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.secondary-button:hover:not(:disabled) {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.08);
  border-color: color-mix(in srgb, var(--accent-primary) 26%, rgba(255, 255, 255, 0.12));
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
}

.sync-button {
  position: relative;
  overflow: hidden;
}

.sync-button.loading::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 0%, color-mix(in srgb, var(--accent-primary) 18%, transparent) 45%, transparent 72%);
  transform: translateX(-120%);
  animation: settingsScan 1s linear infinite;
  pointer-events: none;
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
  color: var(--danger);
  border: 1px solid color-mix(in srgb, var(--danger) 34%, transparent);
  font-size: 13px;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.danger-outline:hover {
  transform: translateY(-1px);
  background: color-mix(in srgb, var(--danger) 9%, transparent);
  border-color: color-mix(in srgb, var(--danger) 46%, transparent);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--danger) 9%, transparent);
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

.icon-button {
  transition:
    transform 0.15s ease,
    color 0.15s ease,
    background 0.15s ease;
}

.icon-button:hover {
  transform: translateY(-1px);
  color: #eef6ff;
  background: rgba(255, 255, 255, 0.06);
}

@keyframes settingsCardIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes settingsActivePulse {
  0%,
  100% {
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--accent-primary) 10%, transparent),
      0 0 18px color-mix(in srgb, var(--accent-primary) 10%, transparent);
  }
  50% {
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--accent-primary) 18%, transparent),
      0 0 24px color-mix(in srgb, var(--accent-primary) 16%, transparent);
  }
}

@keyframes settingsScan {
  to {
    transform: translateX(120%);
  }
}

@keyframes settingsStatusIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-page {
    animation: none;
  }

  .setting-card,
  .toggle-btn.active,
  .form-success,
  .sync-button.loading::after {
    animation: none;
  }

  .setting-card,
  .toggle-btn,
  .theme-choice,
  .segmented-control button,
  .mini-stat,
  .quick-stat-row span,
  .preference-token,
  .manage-entry,
  .primary-button,
  .secondary-button,
  .danger-outline,
  .icon-button,
  .date-input-row input,
  .threshold-field,
  .threshold-field input,
  .pw-form input {
    transition: none;
  }
}

@media (max-width: 980px) {
  .settings-content {
    grid-template-columns: 1fr;
    padding: 20px 16px 48px;
  }

  .settings-sidebar {
    position: sticky;
    top: 52px;
    z-index: 8;
    grid-column: 1 / -1;
    flex-direction: row;
    overflow-x: auto;
    padding: 8px;
    scrollbar-width: thin;
  }

  .settings-section-tab {
    min-width: 132px;
    flex: 0 0 auto;
  }

  .settings-main,
  .settings-side {
    grid-column: 1 / -1;
    grid-template-columns: 1fr;
  }

  .renderer-card,
  .theme-card,
  .layout-card,
  .preferences-card,
  .density-heat-card,
  .insight-display-card,
  .password-card,
  .account-card,
  .current-map-card,
  .manage-card,
  .preference-overview-card,
  .sync-card {
    grid-column: 1 / -1;
  }

  .manage-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .theme-choice-grid {
    grid-template-columns: 1fr;
  }

  .manage-entry {
    justify-content: center;
  }
}

@media (max-width: 620px) {
  .account-stat-grid,
  .manage-grid,
  .theme-choice-grid,
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
