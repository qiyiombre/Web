<script setup lang="ts">
import { computed } from 'vue';
import { BarChart3, Lightbulb, Sparkles, TrendingDown, TrendingUp } from 'lucide-vue-next';
import { useGraphStore } from '../stores/graph';
import type { Insight } from '../types/domain';

const props = defineProps<{
  insight: Insight | null;
  adviceLoading: boolean;
}>();

const emit = defineEmits<{
  generateAdvice: [];
}>();

const graphStore = useGraphStore();
const topTags = computed(() => props.insight?.topTags.slice(0, graphStore.insightTopLimit) ?? []);
const risingTags = computed(() => props.insight?.risingTags.slice(0, graphStore.insightTrendLimit) ?? []);
const fallingTags = computed(() => props.insight?.fallingTags.slice(0, graphStore.insightTrendLimit) ?? []);
const cooccurrenceItems = computed(() => props.insight?.cooccurrence.slice(0, graphStore.insightCooccurrenceLimit) ?? []);
</script>

<template>
  <section class="panel insight-panel">
    <div class="panel-title">
      <span>洞察分析</span>
      <BarChart3 :size="17" />
    </div>

    <template v-if="insight">
      <div class="mini-section">
        <h4><TrendingUp :size="15" /> 高频标签</h4>
        <div class="tag-meter-list">
          <div v-for="tag in topTags" :key="tag.id" class="tag-meter">
            <span class="tag-dot" :style="{ backgroundColor: tag.color }"></span>
            <span>{{ tag.name }}</span>
            <strong>{{ tag.count }}</strong>
          </div>
        </div>
      </div>

      <div class="mini-grid">
        <div>
          <h4><TrendingUp :size="15" /> 上升</h4>
          <p v-if="!insight.risingTags.length" class="muted">暂无明显上升。</p>
          <p v-for="tag in risingTags" :key="tag.id" class="trend-line">
            {{ tag.name }} <strong>+{{ tag.delta }}</strong>
          </p>
        </div>
        <div>
          <h4><TrendingDown :size="15" /> 下降</h4>
          <p v-if="!insight.fallingTags.length" class="muted">暂无明显下降。</p>
          <p v-for="tag in fallingTags" :key="tag.id" class="trend-line">
            {{ tag.name }} <strong>{{ tag.delta }}</strong>
          </p>
        </div>
      </div>

      <div class="mini-section">
        <h4>常见共现</h4>
        <p v-if="!insight.cooccurrence.length" class="muted">日志积累后会出现标签关联。</p>
        <div v-for="pair in cooccurrenceItems" :key="`${pair.tagA}-${pair.tagB}`" class="pair-row">
          <span>{{ pair.tagA }}</span>
          <i></i>
          <span>{{ pair.tagB }}</span>
          <strong>{{ pair.count }}</strong>
        </div>
      </div>

      <div class="mini-section">
        <div class="advice-heading">
          <h4><Lightbulb :size="15" /> AI 建议</h4>
          <button class="secondary-button compact-action" :disabled="adviceLoading" @click="emit('generateAdvice')">
            <Sparkles :size="14" />
            {{ adviceLoading ? '生成中' : '生成建议' }}
          </button>
        </div>
        <p v-if="!insight.suggestions.length" class="muted">默认不调用大模型，点击后才生成并缓存建议。</p>
        <p v-if="insight.adviceMeta?.message" class="muted">{{ insight.adviceMeta.message }}</p>
        <p v-for="text in insight.suggestions" :key="text" class="advice">{{ text }}</p>
      </div>
    </template>

    <p v-else class="muted">正在生成洞察...</p>
  </section>
</template>
