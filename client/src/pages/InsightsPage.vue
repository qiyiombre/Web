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
import type { AdviceResponse, InsightRangePayload, InsightTimeFilter, LogEntry, TagNode } from '../types/domain';

type InsightPeriod = { start: number | null; end: number | null };
type TrendRow = TagNode & { current: number; previous: number; delta: number };
type CooccurrenceRow = { tagA: string; tagB: string; count: number };
type ActivityBucket = { key: string; label: string; count: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const insightTimeOptions: Array<{ value: InsightTimeFilter; label: string }> = [
  { value: 'week', label: '7天' },
  { value: 'month', label: '30天' },
  { value: 'quarter', label: '90天' },
  { value: 'custom', label: '自定义' }
];

const mapsStore = useMapsStore();
const graphStore = useGraphStore();
const route = useRoute();
const router = useRouter();

const mapId = computed(() => Number(route.params.id));
const adviceLoading = ref(false);
const advice = ref<string[]>([]);
const adviceCached = ref(false);
const adviceRangeAtGeneration = ref('');
const trendTimeFilter = ref<InsightTimeFilter>('week');
const trendCustomStartDate = ref('');
const trendCustomEndDate = ref('');
const activityTimeFilter = ref<InsightTimeFilter>('week');
const activityCustomStartDate = ref('');
const activityCustomEndDate = ref('');
const cooccurrenceTimeFilter = ref<InsightTimeFilter>('month');
const cooccurrenceCustomStartDate = ref('');
const cooccurrenceCustomEndDate = ref('');
const adviceTimeFilter = ref<InsightTimeFilter>('month');
const adviceCustomStartDate = ref('');
const adviceCustomEndDate = ref('');

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

watch([adviceTimeFilter, adviceCustomStartDate, adviceCustomEndDate], () => {
  advice.value = [];
  adviceCached.value = false;
  adviceRangeAtGeneration.value = '';
});

const insights = computed(() => mapsStore.insights);
const graph = computed(() => mapsStore.graph);
const topTags = computed(() => insights.value?.topTags.slice(0, graphStore.insightTopLimit) ?? []);
const trendLogs = computed(() =>
  currentAndPreviousLogs(
    graph.value?.logs ?? [],
    trendTimeFilter.value,
    trendCustomStartDate.value,
    trendCustomEndDate.value
  )
);
const trendRows = computed(() => buildTrendRows(graph.value?.tags ?? [], trendLogs.value.current, trendLogs.value.previous));
const risingTags = computed(() =>
  trendRows.value
    .filter((tag) => tag.delta > 0)
    .sort((a, b) => b.delta - a.delta || b.current - a.current || a.name.localeCompare(b.name))
    .slice(0, graphStore.insightTrendLimit)
);
const fallingTags = computed(() =>
  trendRows.value
    .filter((tag) => tag.previous > 0 && tag.delta < 0)
    .sort((a, b) => a.delta - b.delta || b.previous - a.previous || a.name.localeCompare(b.name))
    .slice(0, graphStore.insightTrendLimit)
);
const cooccurrenceRangeLogs = computed(() =>
  filterLogsByRange(
    graph.value?.logs ?? [],
    cooccurrenceTimeFilter.value,
    cooccurrenceCustomStartDate.value,
    cooccurrenceCustomEndDate.value
  )
);
const cooccurrenceItems = computed(() =>
  buildCooccurrenceItems(cooccurrenceRangeLogs.value).slice(0, graphStore.insightCooccurrenceLimit)
);
const topTagMax = computed(() => Math.max(1, topTags.value[0]?.count ?? 1));
const totalLogs = computed(() => graph.value?.logs.length ?? 0);
const totalTags = computed(() => graph.value?.tags.length ?? 0);
const tagUseCount = computed(() => graph.value?.logs.reduce((sum, log) => sum + log.tags.length, 0) ?? 0);
const tagDensityRatio = computed(() => {
  const target = Math.max(1, totalLogs.value * 3);
  return Math.min(100, Math.round((tagUseCount.value / target) * 100));
});
const avgTagsPerLog = computed(() => {
  if (!totalLogs.value) return '0.0';
  return (tagUseCount.value / totalLogs.value).toFixed(1);
});
const unusedTagCount = computed(() => graph.value?.tags.filter(tag => tag.count === 0).length ?? 0);
const strongestPair = computed(() => insights.value?.cooccurrence[0] ?? null);
const recentLogs = computed(() => (
  [...(graph.value?.logs ?? [])]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    .slice(0, Math.max(3, Math.min(8, graphStore.insightTrendLimit + 1)))
));
const recentActivityDays = computed(() =>
  buildActivityBuckets(
    graph.value?.logs ?? [],
    activityTimeFilter.value,
    activityCustomStartDate.value,
    activityCustomEndDate.value
  )
);
const maxRecentActivity = computed(() => Math.max(1, ...recentActivityDays.value.map(day => day.count)));
const activeRecentDayCount = computed(() => recentActivityDays.value.filter(day => day.count > 0).length);
const mostActiveRecentDay = computed(() => (
  recentActivityDays.value.reduce((best, day) => (day.count > best.count ? day : best), recentActivityDays.value[0] ?? { label: '-', count: 0 })
));
const latestActivityLabel = computed(() => {
  const latest = recentLogs.value[0];
  if (!latest) return '暂无';
  const days = daysSince(latest.createdAt);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
});
const cooccurrenceMax = computed(() => Math.max(1, cooccurrenceItems.value[0]?.count ?? 1));
const cooccurrenceStrengths = computed(() => (
  cooccurrenceItems.value.slice(0, 5).map(pair => ({
    ...pair,
    percent: Math.max(8, Math.round((pair.count / cooccurrenceMax.value) * 100))
  }))
));
const trendRangeLabel = computed(() => rangeLabel(trendTimeFilter.value, trendCustomStartDate.value, trendCustomEndDate.value));
const activityRangeLabel = computed(() => rangeLabel(activityTimeFilter.value, activityCustomStartDate.value, activityCustomEndDate.value));
const cooccurrenceRangeLabel = computed(() => rangeLabel(cooccurrenceTimeFilter.value, cooccurrenceCustomStartDate.value, cooccurrenceCustomEndDate.value));
const adviceRangeLabel = computed(() => rangeLabel(adviceTimeFilter.value, adviceCustomStartDate.value, adviceCustomEndDate.value));

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
    const range = insightRangePayload(adviceTimeFilter.value, adviceCustomStartDate.value, adviceCustomEndDate.value);
    const result: AdviceResponse = await generateAdvice(mapId.value, range);
    advice.value = result.suggestions;
    adviceCached.value = result.cached;
    adviceRangeAtGeneration.value = rangeLabel(range.timeFilter, range.customStartDate ?? '', range.customEndDate ?? '');
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

function openRecentLog(logId: number) {
  if (!mapId.value) return;
  router.push({
    path: `/maps/${mapId.value}/logs`,
    query: { selected: String(logId) }
  });
}

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  });
}

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function daysSince(iso: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(iso);
  target.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((today.getTime() - target.getTime()) / 86400000));
}

function insightRangePayload(
  timeFilter: InsightTimeFilter,
  customStartDate: string,
  customEndDate: string
): InsightRangePayload {
  return {
    timeFilter,
    customStartDate: normalizeDateInput(customStartDate),
    customEndDate: normalizeDateInput(customEndDate)
  };
}

function normalizeDateInput(value: string) {
  const clean = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(clean) ? clean : '';
}

function rangeLabel(timeFilter: InsightTimeFilter, customStartDate = '', customEndDate = '') {
  if (timeFilter === 'week') return '7天';
  if (timeFilter === 'month') return '30天';
  if (timeFilter === 'quarter') return '90天';
  const start = normalizeDateInput(customStartDate);
  const end = normalizeDateInput(customEndDate);
  if (start && end) return `${start} 至 ${end}`;
  if (start) return `${start} 起`;
  if (end) return `${end} 前`;
  return '全部时间';
}

function buildCurrentPeriod(timeFilter: InsightTimeFilter, customStartDate = '', customEndDate = ''): InsightPeriod {
  const now = Date.now();
  if (timeFilter === 'custom') {
    const start = dateBoundary(customStartDate);
    const end = dateBoundary(customEndDate, true);
    if (start === null && end === null) return { start: null, end: null };
    return { start, end };
  }
  const duration = timeFilter === 'week' ? 7 * DAY_MS : timeFilter === 'quarter' ? 90 * DAY_MS : 30 * DAY_MS;
  return { start: now - duration, end: now };
}

function buildPreviousPeriod(period: InsightPeriod): InsightPeriod {
  if (period.start === null || period.end === null || period.end <= period.start) {
    return { start: null, end: null };
  }
  const duration = period.end - period.start;
  return { start: period.start - duration, end: period.start };
}

function currentAndPreviousLogs(
  logs: LogEntry[],
  timeFilter: InsightTimeFilter,
  customStartDate = '',
  customEndDate = ''
) {
  const current = buildCurrentPeriod(timeFilter, customStartDate, customEndDate);
  const previous = buildPreviousPeriod(current);
  return {
    current: logs.filter((log) => matchesPeriod(log, current)),
    previous: logs.filter((log) => matchesPeriod(log, previous))
  };
}

function filterLogsByRange(logs: LogEntry[], timeFilter: InsightTimeFilter, customStartDate = '', customEndDate = '') {
  const period = buildCurrentPeriod(timeFilter, customStartDate, customEndDate);
  return logs.filter((log) => matchesPeriod(log, period));
}

function matchesPeriod(log: LogEntry, period: InsightPeriod) {
  if (period.start === null && period.end === null) return true;
  const time = new Date(log.createdAt).getTime();
  if (!Number.isFinite(time)) return true;
  if (period.start !== null && time < period.start) return false;
  if (period.end !== null && time > period.end) return false;
  return true;
}

function dateBoundary(value: string, endOfDay = false) {
  const clean = normalizeDateInput(value);
  if (!clean) return null;
  const time = new Date(`${clean}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime();
  return Number.isNaN(time) ? null : time;
}

function buildTrendRows(tags: TagNode[], currentLogs: LogEntry[], previousLogs: LogEntry[]): TrendRow[] {
  const currentUsage = buildUsageByTag(currentLogs);
  const previousUsage = buildUsageByTag(previousLogs);
  return tags.map((tag) => {
    const current = currentUsage.get(tag.id) ?? 0;
    const previous = previousUsage.get(tag.id) ?? 0;
    return {
      ...tag,
      current,
      previous,
      delta: current - previous
    };
  });
}

function buildUsageByTag(logs: LogEntry[]) {
  const usage = new Map<number, number>();
  for (const log of logs) {
    const seen = new Set<number>();
    for (const tag of log.tags) {
      if (seen.has(tag.id)) continue;
      seen.add(tag.id);
      usage.set(tag.id, (usage.get(tag.id) ?? 0) + 1);
    }
  }
  return usage;
}

function buildCooccurrenceItems(logs: LogEntry[]): CooccurrenceRow[] {
  const pairs = new Map<string, CooccurrenceRow>();
  for (const log of logs) {
    const tags = [...log.tags].sort((a, b) => a.id - b.id);
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const key = `${tags[i].id}:${tags[j].id}`;
        const item = pairs.get(key) ?? { tagA: tags[i].name, tagB: tags[j].name, count: 0 };
        item.count += 1;
        pairs.set(key, item);
      }
    }
  }
  return [...pairs.values()].sort((a, b) => b.count - a.count || a.tagA.localeCompare(b.tagA));
}

function buildActivityBuckets(
  logs: LogEntry[],
  timeFilter: InsightTimeFilter,
  customStartDate = '',
  customEndDate = ''
): ActivityBucket[] {
  const period = buildCurrentPeriod(timeFilter, customStartDate, customEndDate);
  const filtered = logs.filter((log) => matchesPeriod(log, period));
  const now = new Date();
  const today = startOfDay(now);
  const start =
    period.start !== null
      ? startOfDay(new Date(period.start))
      : filtered.length
        ? startOfDay(new Date(Math.min(...filtered.map((log) => new Date(log.createdAt).getTime()))))
        : new Date(today.getTime() - 6 * DAY_MS);
  const end = period.end !== null ? startOfDay(new Date(period.end)) : today;
  const dayCount = Math.max(1, Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1);
  const bucketCount = timeFilter === 'week' ? Math.min(7, dayCount) : Math.min(12, dayCount);
  const bucketSize = Math.max(1, Math.ceil(dayCount / bucketCount));
  const buckets: ActivityBucket[] = [];

  for (let index = 0; index < bucketCount; index += 1) {
    const bucketStart = new Date(start.getTime() + index * bucketSize * DAY_MS);
    const bucketEnd = new Date(Math.min(end.getTime(), bucketStart.getTime() + (bucketSize - 1) * DAY_MS));
    const count = filtered.filter((log) => {
      const time = startOfDay(new Date(log.createdAt)).getTime();
      return time >= bucketStart.getTime() && time <= bucketEnd.getTime();
    }).length;
    buckets.push({
      key: `${toDateKey(bucketStart)}-${toDateKey(bucketEnd)}`,
      label: bucketSize === 1 ? formatBucketDate(bucketStart) : `${formatBucketDate(bucketStart)}-${formatBucketDate(bucketEnd)}`,
      count
    });
  }
  return buckets;
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function formatBucketDate(date: Date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
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
                <span>标签使用密度</span>
                <strong>{{ tagUseCount }}</strong>
              </div>
              <div class="quality-meter">
                <span :style="{ width: `${tagDensityRatio}%` }" />
              </div>
              <small>当前星图共有 {{ tagUseCount }} 次标签使用，平均每篇 {{ avgTagsPerLog }} 个</small>
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
            <div class="activity-panel">
              <div class="activity-panel-head">
                <div>
                  <span>写入节奏</span>
                  <strong>{{ activeRecentDayCount }}/{{ recentActivityDays.length }} 段</strong>
                </div>
                <div class="insight-time-control" aria-label="写入节奏时间范围">
                  <button
                    v-for="option in insightTimeOptions"
                    :key="`activity-${option.value}`"
                    type="button"
                    :class="{ active: activityTimeFilter === option.value }"
                    @click="activityTimeFilter = option.value"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>
              <div v-if="activityTimeFilter === 'custom'" class="insight-custom-range">
                <input v-model="activityCustomStartDate" type="date" aria-label="写入节奏开始日期" />
                <span>至</span>
                <input v-model="activityCustomEndDate" type="date" aria-label="写入节奏结束日期" />
              </div>
              <div class="activity-bars" aria-label="日志写入节奏">
                <div v-for="day in recentActivityDays" :key="day.key" class="activity-day">
                  <i>
                    <span :style="{ height: `${Math.max(8, (day.count / maxRecentActivity) * 100)}%` }" />
                  </i>
                  <small>{{ day.label }}</small>
                  <em>{{ day.count }}</em>
                </div>
              </div>
              <div class="activity-summary">
                <span>范围：{{ activityRangeLabel }} · 最近记录：{{ latestActivityLabel }}</span>
                <span>峰值：{{ mostActiveRecentDay.label }} · {{ mostActiveRecentDay.count }} 篇</span>
              </div>
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
            <button
              v-for="log in recentLogs"
              :key="log.id"
              type="button"
              class="recent-log-item"
              @click="openRecentLog(log.id)"
            >
              <div class="recent-log-date">
                <FileText :size="14" />
                {{ formatShortDate(log.updatedAt || log.createdAt) }}
              </div>
              <div class="recent-log-copy">
                <strong>{{ log.title || '无标题' }}</strong>
                <span>{{ log.tags.length }} 个标签</span>
              </div>
            </button>
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
            <div class="section-title-row">
              <h3>上升标签</h3>
              <div class="insight-time-control" aria-label="趋势时间范围">
                <button
                  v-for="option in insightTimeOptions"
                  :key="`trend-up-${option.value}`"
                  type="button"
                  :class="{ active: trendTimeFilter === option.value }"
                  @click="trendTimeFilter = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <div v-if="trendTimeFilter === 'custom'" class="insight-custom-range">
              <input v-model="trendCustomStartDate" type="date" aria-label="趋势开始日期" />
              <span>至</span>
              <input v-model="trendCustomEndDate" type="date" aria-label="趋势结束日期" />
            </div>
            <small class="section-range-hint">当前范围 vs 上一个等长范围：{{ trendRangeLabel }}</small>
            <div v-if="risingTags.length">
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
            <div class="section-title-row">
              <h3>下降标签</h3>
              <div class="insight-time-control" aria-label="趋势时间范围">
                <button
                  v-for="option in insightTimeOptions"
                  :key="`trend-down-${option.value}`"
                  type="button"
                  :class="{ active: trendTimeFilter === option.value }"
                  @click="trendTimeFilter = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <div v-if="trendTimeFilter === 'custom'" class="insight-custom-range">
              <input v-model="trendCustomStartDate" type="date" aria-label="趋势开始日期" />
              <span>至</span>
              <input v-model="trendCustomEndDate" type="date" aria-label="趋势结束日期" />
            </div>
            <small class="section-range-hint">当前范围 vs 上一个等长范围：{{ trendRangeLabel }}</small>
            <div v-if="fallingTags.length">
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
          <div class="section-title-row">
            <h3>标签共现</h3>
            <div class="insight-time-control" aria-label="共现时间范围">
              <button
                v-for="option in insightTimeOptions"
                :key="`cooccur-${option.value}`"
                type="button"
                :class="{ active: cooccurrenceTimeFilter === option.value }"
                @click="cooccurrenceTimeFilter = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
          <div v-if="cooccurrenceTimeFilter === 'custom'" class="insight-custom-range">
            <input v-model="cooccurrenceCustomStartDate" type="date" aria-label="共现开始日期" />
            <span>至</span>
            <input v-model="cooccurrenceCustomEndDate" type="date" aria-label="共现结束日期" />
          </div>
          <small class="section-range-hint">只统计 {{ cooccurrenceRangeLabel }} 内同篇日志的标签组合</small>
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
          <div v-if="cooccurrenceStrengths.length" class="cooccur-strength-list">
            <div
              v-for="pair in cooccurrenceStrengths"
              :key="`${pair.tagA}-${pair.tagB}-strength`"
              class="cooccur-strength-row"
            >
              <div class="cooccur-strength-copy">
                <span>{{ pair.tagA }} / {{ pair.tagB }}</span>
                <small>{{ pair.count }} 次共现</small>
              </div>
              <div class="cooccur-strength-track">
                <span :style="{ width: `${pair.percent}%` }" />
              </div>
            </div>
          </div>
          <p v-if="cooccurrenceItems.length === 0" class="muted">暂无共现数据</p>
        </div>
      </section>

      <!-- AI Advice -->
      <section class="insight-section">
        <div class="section-icon" style="background: rgba(247,215,116,0.1); color: #f7d774;">
          <Sparkles :size="20" />
        </div>
        <div class="section-body">
          <div class="section-title-row">
            <h3>AI 建议</h3>
            <div class="insight-time-control" aria-label="AI 建议时间范围">
              <button
                v-for="option in insightTimeOptions"
                :key="`advice-${option.value}`"
                type="button"
                :class="{ active: adviceTimeFilter === option.value }"
                @click="adviceTimeFilter = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
          <div v-if="adviceTimeFilter === 'custom'" class="insight-custom-range">
            <input v-model="adviceCustomStartDate" type="date" aria-label="AI 建议开始日期" />
            <span>至</span>
            <input v-model="adviceCustomEndDate" type="date" aria-label="AI 建议结束日期" />
          </div>
          <small class="section-range-hint">
            当前建议范围：{{ adviceRangeLabel }}
            <span v-if="advice.length && adviceRangeAtGeneration"> · 已生成：{{ adviceRangeAtGeneration }}</span>
            <span v-if="adviceCached"> · 缓存</span>
          </small>
          <div v-if="advice.length > 0" class="advice-list">
            <p v-for="(s, i) in advice" :key="i" class="advice-item">
              <Sparkles :size="14" />
              {{ s }}
            </p>
          </div>
          <p v-else class="muted">点击生成后，会基于当前范围的统计和最近日志摘要生成建议。</p>
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

.activity-panel {
  grid-column: 1 / -1;
  min-width: 0;
  padding: 12px 13px;
  border-radius: 12px;
  border: 1px solid rgba(98, 214, 255, 0.09);
  background:
    radial-gradient(circle at 12% 24%, rgba(98, 214, 255, 0.11), transparent 36%),
    rgba(255, 255, 255, 0.028);
}

.activity-panel-head,
.activity-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.activity-panel-head > div:first-child {
  display: grid;
  gap: 3px;
}

.activity-panel-head span,
.activity-summary span {
  color: rgba(238, 246, 255, 0.42);
  font-size: 12px;
}

.activity-panel-head strong {
  color: #eef6ff;
  font-size: 15px;
}

.activity-bars {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(34px, 1fr));
  gap: 8px;
  align-items: end;
  margin: 12px 0 9px;
}

.activity-day {
  display: grid;
  grid-template-rows: 58px auto auto;
  justify-items: center;
  gap: 4px;
  min-width: 0;
}

.activity-day i {
  display: flex;
  align-items: end;
  width: 100%;
  max-width: 26px;
  height: 58px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.055);
}

.activity-day i span {
  display: block;
  width: 100%;
  border-radius: inherit;
  background: linear-gradient(180deg, #8cf0b4, #62d6ff);
  box-shadow: 0 0 12px rgba(98, 214, 255, 0.2);
}

.activity-day small,
.activity-day em {
  overflow: hidden;
  max-width: 100%;
  color: rgba(238, 246, 255, 0.38);
  font-size: 10px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-day em {
  color: rgba(238, 246, 255, 0.58);
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
  width: 100%;
  padding: 9px 10px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.055);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s, transform 0.16s;
}

.recent-log-item:hover,
.recent-log-item:focus-visible {
  border-color: rgba(98, 214, 255, 0.28);
  background: rgba(98, 214, 255, 0.07);
  transform: translateX(2px);
}

.recent-log-item:focus-visible {
  outline: 2px solid rgba(98, 214, 255, 0.26);
  outline-offset: 2px;
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
  gap: 10px;
  padding: 16px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  min-width: 0;
}

.section-icon {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.section-icon svg {
  width: 16px;
  height: 16px;
}

.section-body {
  flex: 1;
  min-width: 0;
}

.section-body h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 3px 0 14px;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.section-title-row h3 {
  margin: 0;
}

.insight-time-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.insight-time-control button {
  border: 0;
  border-radius: 999px;
  padding: 4px 8px;
  color: rgba(238, 246, 255, 0.58);
  background: transparent;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.16s, color 0.16s, box-shadow 0.16s;
}

.insight-time-control button:hover,
.insight-time-control button:focus-visible {
  color: #eef6ff;
  background: rgba(98, 214, 255, 0.12);
}

.insight-time-control button.active {
  color: #061421;
  background: #62d6ff;
  box-shadow: 0 0 14px rgba(98, 214, 255, 0.22);
}

.insight-custom-range {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  color: rgba(238, 246, 255, 0.42);
  font-size: 12px;
}

.insight-custom-range input {
  min-width: 0;
  width: 132px;
  height: 30px;
  padding: 0 8px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: rgba(2, 9, 18, 0.48);
  color: #eef6ff;
}

.section-range-hint {
  display: block;
  margin: -2px 0 10px;
  color: rgba(238, 246, 255, 0.42);
  font-size: 11px;
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

.cooccur-strength-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.cooccur-strength-row {
  display: grid;
  grid-template-columns: minmax(112px, 0.62fr) minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}

.cooccur-strength-copy {
  min-width: 0;
}

.cooccur-strength-copy span,
.cooccur-strength-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cooccur-strength-copy span {
  color: #eef6ff;
  font-size: 12px;
  font-weight: 600;
}

.cooccur-strength-copy small {
  margin-top: 2px;
  color: rgba(238, 246, 255, 0.35);
  font-size: 11px;
}

.cooccur-strength-track {
  height: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
}

.cooccur-strength-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #b99cff, #62d6ff);
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
