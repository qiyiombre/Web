<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronLeft,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Activity,
  CalendarDays,
  FileText,
  Tag,
  RefreshCw
} from 'lucide-vue-next';
import { useMapsStore } from '../stores/maps';
import { useGraphStore } from '../stores/graph';
import MapSwitcher from '../components/MapSwitcher.vue';
import { generateAdvice } from '../services/api';
import type { AdviceResponse } from '../types/domain';

const mapsStore = useMapsStore();
const graphStore = useGraphStore();
const route = useRoute();
const router = useRouter();

const mapId = computed(() => Number(route.params.id));
const adviceLoading = ref(false);
const advice = ref<string[]>([]);
const adviceCached = ref(false);

onMounted(async () => {
  await mapsStore.fetchMaps();
  if (mapId.value && !isNaN(mapId.value)) {
    mapsStore.activeMapId = mapId.value;
    await mapsStore.selectMap(mapId.value);
  }
});

watch(mapId, async (id) => {
  if (id && !isNaN(id)) {
    mapsStore.activeMapId = id;
    await mapsStore.selectMap(id);
  }
});

const insights = computed(() => mapsStore.insights);
const graph = computed(() => mapsStore.graph);
const topTags = computed(() => insights.value?.topTags.slice(0, graphStore.insightTopLimit) ?? []);
const risingTags = computed(() => insights.value?.risingTags.slice(0, graphStore.insightTrendLimit) ?? []);
const fallingTags = computed(() => insights.value?.fallingTags.slice(0, graphStore.insightTrendLimit) ?? []);
const cooccurrenceItems = computed(() => insights.value?.cooccurrence.slice(0, graphStore.insightCooccurrenceLimit) ?? []);
const topTagMax = computed(() => Math.max(1, topTags.value[0]?.count ?? 1));
const totalLogs = computed(() => graph.value?.logs.length ?? 0);
const totalTags = computed(() => graph.value?.tags.length ?? 0);
const taggedLogCount = computed(() => graph.value?.logs.filter(log => log.tags.length > 0).length ?? 0);
const taggedLogRatio = computed(() => (
  totalLogs.value > 0 ? Math.round((taggedLogCount.value / totalLogs.value) * 100) : 0
));
const avgTagsPerLog = computed(() => {
  if (!totalLogs.value) return '0.0';
  const tagUseCount = graph.value?.logs.reduce((sum, log) => sum + log.tags.length, 0) ?? 0;
  return (tagUseCount / totalLogs.value).toFixed(1);
});
const unusedTagCount = computed(() => graph.value?.tags.filter(tag => tag.count === 0).length ?? 0);
const strongestPair = computed(() => insights.value?.cooccurrence[0] ?? null);
const recentLogs = computed(() => (
  [...(graph.value?.logs ?? [])]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    .slice(0, Math.max(3, Math.min(8, graphStore.insightTrendLimit + 1)))
));

const aiSource = computed(() => {
  if (!graph.value?.aiMeta?.tagRelations) return 'none';
  const meta = graph.value.aiMeta.tagRelations;
  if (meta.source === 'deepseek') return 'AI';
  if (meta.source === 'cache') return '缓存';
  return '本地';
});

async function handleGenerateAdvice() {
  if (!mapId.value) return;
  adviceLoading.value = true;
  try {
    const result: AdviceResponse = await generateAdvice(mapId.value);
    advice.value = result.suggestions;
    adviceCached.value = result.cached;
  } catch {
    advice.value = [];
  } finally {
    adviceLoading.value = false;
  }
}

function switchMap(nextId: number) {
  if (!Number.isFinite(nextId) || nextId === mapId.value) return;
  router.push(`/maps/${nextId}/insights`);
}

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  });
}
</script>

<template>
  <div class="insights-page stardust-page stardust-page--quiet">
    <header class="page-header">
      <div class="header-left">
        <button class="icon-button" title="返回星图" @click="router.push(`/maps/${mapId}`)">
          <ChevronLeft :size="18" />
        </button>
        <h2>{{ mapsStore.graph?.map.name ?? '洞察' }} — 洞察</h2>
        <MapSwitcher :maps="mapsStore.maps" :model-value="mapId" @change="switchMap" />
      </div>
      <div class="header-right">
        <span class="source-badge" :class="aiSource">{{ aiSource }} 分析</span>
      </div>
    </header>

    <div v-if="!insights" class="page-loading">
      <p>加载分析数据中...</p>
    </div>

    <div v-else class="insights-content">
      <section class="insight-summary-grid">
        <div class="summary-card">
          <span>日志</span>
          <strong>{{ graph?.logs.length ?? 0 }}</strong>
          <small>当前星图</small>
        </div>
        <div class="summary-card">
          <span>标签</span>
          <strong>{{ totalTags }}</strong>
          <small>去重标签</small>
        </div>
        <div class="summary-card">
          <span>共现</span>
          <strong>{{ insights.cooccurrence.length }}</strong>
          <small>标签关系</small>
        </div>
        <div class="summary-card">
          <span>展示</span>
          <strong>{{ graphStore.insightTopLimit }}</strong>
          <small>高频标签条数</small>
        </div>
      </section>

      <!-- Data quality -->
      <section class="insight-section quality-section">
        <div class="section-icon" style="background: rgba(140,240,180,0.1); color: #8cf0b4;">
          <Tag :size="20" />
        </div>
        <div class="section-body">
          <h3>数据覆盖质量</h3>
          <div class="quality-grid">
            <div class="quality-main">
              <div class="quality-head">
                <span>已打标签日志</span>
                <strong>{{ taggedLogRatio }}%</strong>
              </div>
              <div class="quality-meter">
                <span :style="{ width: `${taggedLogRatio}%` }" />
              </div>
              <small>{{ taggedLogCount }} / {{ totalLogs }} 篇日志已经连接到标签</small>
            </div>
            <div class="quality-stat">
              <span>平均标签</span>
              <strong>{{ avgTagsPerLog }}</strong>
              <small>每篇日志</small>
            </div>
            <div class="quality-stat">
              <span>未使用标签</span>
              <strong>{{ unusedTagCount }}</strong>
              <small>可考虑合并或删除</small>
            </div>
            <div class="quality-stat">
              <span>最强关系</span>
              <strong>{{ strongestPair ? strongestPair.count : 0 }}</strong>
              <small v-if="strongestPair">{{ strongestPair.tagA }} / {{ strongestPair.tagB }}</small>
              <small v-else>暂无共现</small>
            </div>
          </div>
        </div>
      </section>

      <!-- Recent activity -->
      <section class="insight-section recent-section">
        <div class="section-icon" style="background: rgba(98,214,255,0.1); color: #62d6ff;">
          <CalendarDays :size="20" />
        </div>
        <div class="section-body">
          <h3>最近日志活动</h3>
          <div v-if="recentLogs.length" class="recent-log-list">
            <article v-for="log in recentLogs" :key="log.id" class="recent-log-item">
              <div class="recent-log-date">
                <FileText :size="14" />
                {{ formatShortDate(log.updatedAt || log.createdAt) }}
              </div>
              <div class="recent-log-copy">
                <strong>{{ log.title || '无标题' }}</strong>
                <span>{{ log.tags.length }} 个标签</span>
              </div>
            </article>
          </div>
          <p v-else class="muted">暂无最近日志</p>
        </div>
      </section>

      <!-- Top tags -->
      <section class="insight-section">
        <div class="section-icon" style="background: rgba(98,214,255,0.1); color: #62d6ff;">
          <Activity :size="20" />
        </div>
        <div class="section-body">
          <h3>高频标签</h3>
          <div class="tag-bars">
            <div
              v-for="tag in topTags"
              :key="tag.id"
              class="tag-bar-item"
            >
              <span class="bar-label">{{ tag.name }}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :style="{
                    width: `${(tag.count / topTagMax) * 100}%`,
                    backgroundColor: tag.color
                  }"
                />
              </div>
              <span class="bar-count">{{ tag.count }}</span>
            </div>
          </div>
          <p v-if="insights.topTags.length === 0" class="muted">暂无数据</p>
        </div>
      </section>

      <!-- Rising / Falling tags -->
      <div class="insight-grid">
        <section class="insight-section">
          <div class="section-icon" style="background: rgba(140,240,180,0.1); color: #8cf0b4;">
            <TrendingUp :size="20" />
          </div>
          <div class="section-body">
            <h3>上升标签</h3>
            <div v-if="insights.risingTags.length">
              <div v-for="tag in risingTags" :key="tag.id" class="trend-item">
                <span class="tag-dot" :style="{ backgroundColor: tag.color }" />
                <span>{{ tag.name }}</span>
                <span class="trend-up">+{{ tag.delta }}</span>
              </div>
            </div>
            <p v-else class="muted">暂无上升趋势</p>
          </div>
        </section>

        <section class="insight-section">
          <div class="section-icon" style="background: rgba(255,143,163,0.1); color: #ff8fa3;">
            <TrendingDown :size="20" />
          </div>
          <div class="section-body">
            <h3>下降标签</h3>
            <div v-if="insights.fallingTags.length">
              <div v-for="tag in fallingTags" :key="tag.id" class="trend-item">
                <span class="tag-dot" :style="{ backgroundColor: tag.color }" />
                <span>{{ tag.name }}</span>
                <span class="trend-down">{{ tag.delta }}</span>
              </div>
            </div>
            <p v-else class="muted">暂无下降趋势</p>
          </div>
        </section>
      </div>

      <!-- Co-occurrence -->
      <section class="insight-section">
        <div class="section-icon" style="background: rgba(185,156,255,0.1); color: #b99cff;">
          <Activity :size="20" />
        </div>
        <div class="section-body">
          <h3>标签共现</h3>
          <div class="cooccur-grid">
            <div
              v-for="pair in cooccurrenceItems"
              :key="`${pair.tagA}-${pair.tagB}`"
              class="cooccur-item"
            >
              <span class="co-tag">{{ pair.tagA }}</span>
              <span class="co-count">{{ pair.count }}</span>
              <span class="co-tag">{{ pair.tagB }}</span>
            </div>
          </div>
          <p v-if="insights.cooccurrence.length === 0" class="muted">暂无共现数据</p>
        </div>
      </section>

      <!-- AI Advice -->
      <section class="insight-section">
        <div class="section-icon" style="background: rgba(247,215,116,0.1); color: #f7d774;">
          <Sparkles :size="20" />
        </div>
        <div class="section-body">
          <h3>AI 建议</h3>
          <div v-if="advice.length > 0" class="advice-list">
            <p v-for="(s, i) in advice" :key="i" class="advice-item">
              <Sparkles :size="14" />
              {{ s }}
            </p>
          </div>
          <div v-else-if="insights.suggestions.length > 0" class="advice-list">
            <p v-for="(s, i) in insights.suggestions" :key="i" class="advice-item">
              {{ s }}
            </p>
          </div>
          <p v-else class="muted">暂无 AI 建议</p>
          <button class="generate-btn" :disabled="adviceLoading" @click="handleGenerateAdvice">
            <RefreshCw :size="14" :class="{ spinning: adviceLoading }" />
            {{ adviceLoading ? '生成中...' : advice.length ? '重新生成' : '生成 AI 建议' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.insights-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.page-header {
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
  gap: 8px;
}

.source-badge {
  font-size: 11px;
  padding: 4px 12px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(238, 246, 255, 0.4);
}

.source-badge.AI {
  background: rgba(185, 156, 255, 0.15);
  color: #b99cff;
}

.source-badge.缓存 {
  background: rgba(98, 214, 255, 0.1);
  color: #62d6ff;
}

.page-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(238, 246, 255, 0.3);
}

.insights-content {
  flex: 1;
  overflow-y: auto;
  width: 100%;
  max-width: 1120px;
  box-sizing: border-box;
  margin: 0 auto;
  padding: 22px 28px 44px;
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.9fr);
  align-content: start;
  gap: 16px;
}

.insight-summary-grid {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.summary-card {
  padding: 15px 16px;
  border-radius: 13px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background:
    linear-gradient(135deg, rgba(140, 240, 180, 0.065), rgba(185, 156, 255, 0.04)),
    rgba(255, 255, 255, 0.028);
}

.summary-card span,
.summary-card small {
  display: block;
  color: rgba(238, 246, 255, 0.42);
  font-size: 12px;
}

.summary-card strong {
  display: block;
  margin: 6px 0 3px;
  color: #eef6ff;
  font-size: 24px;
}

.quality-section,
.recent-section {
  align-self: stretch;
}

.quality-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.quality-main {
  grid-column: 1 / -1;
}

.quality-main,
.quality-stat {
  min-width: 0;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.quality-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.quality-head span,
.quality-stat span,
.quality-main small,
.quality-stat small {
  color: rgba(238, 246, 255, 0.42);
  font-size: 12px;
}

.quality-head strong,
.quality-stat strong {
  display: block;
  color: #eef6ff;
  font-size: 20px;
}

.quality-meter {
  height: 9px;
  margin-bottom: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
}

.quality-meter span {
  display: block;
  height: 100%;
  min-width: 4px;
  border-radius: inherit;
  background: linear-gradient(90deg, #62d6ff, #8cf0b4);
}

.quality-stat strong {
  margin: 6px 0 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quality-stat small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-log-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.recent-log-item {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding: 9px 10px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.055);
}

.recent-log-date {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: rgba(98, 214, 255, 0.82);
  font-size: 12px;
}

.recent-log-copy {
  min-width: 0;
}

.recent-log-copy strong,
.recent-log-copy span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-log-copy strong {
  color: #eef6ff;
  font-size: 13px;
  margin-bottom: 2px;
}

.recent-log-copy span {
  color: rgba(238, 246, 255, 0.38);
  font-size: 12px;
}

/* Sections */
.insight-section {
  display: flex;
  gap: 16px;
  padding: 20px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  min-width: 0;
}

.section-icon {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.section-body {
  flex: 1;
}

.section-body h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 14px;
}

/* Tag bars */
.tag-bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tag-bar-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bar-label {
  font-size: 13px;
  width: 80px;
  text-align: right;
  flex-shrink: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bar-track {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease;
}

.bar-count {
  font-size: 12px;
  color: rgba(238, 246, 255, 0.4);
  width: 28px;
  text-align: left;
}

/* Insight grid */
.insight-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

.insight-grid .insight-section {
  min-height: 0;
}

/* Trend items */
.trend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.tag-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.trend-up {
  margin-left: auto;
  color: #8cf0b4;
  font-weight: 600;
  font-size: 12px;
}

.trend-down {
  margin-left: auto;
  color: #ff8fa3;
  font-weight: 600;
  font-size: 12px;
}

/* Co-occurrence */
.cooccur-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cooccur-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 12px;
}

.co-tag {
  color: #eef6ff;
}

.co-count {
  color: rgba(238, 246, 255, 0.35);
  font-size: 11px;
}

/* Advice */
.advice-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.advice-item {
  margin: 0;
  font-size: 13px;
  color: rgba(238, 246, 255, 0.6);
  line-height: 1.5;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.advice-item svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: #f7d774;
}

.generate-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 16px;
  border-radius: 8px;
  background: rgba(247, 215, 116, 0.1);
  color: #f7d774;
  border: 1px solid rgba(247, 215, 116, 0.2);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.generate-btn:hover:not(:disabled) {
  background: rgba(247, 215, 116, 0.2);
}

.generate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.muted {
  color: rgba(238, 246, 255, 0.3);
  font-size: 13px;
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
  transition: all 0.15s;
}

.icon-button:hover { color: #eef6ff; background: rgba(255, 255, 255, 0.06); }

@media (max-width: 700px) {
  .insights-content {
    grid-template-columns: 1fr;
    padding: 18px 16px 36px;
  }

  .insight-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .quality-grid {
    grid-template-columns: 1fr;
  }

  .insight-grid {
    grid-template-columns: 1fr;
  }

  .recent-log-item {
    grid-template-columns: 1fr;
  }
}
</style>
