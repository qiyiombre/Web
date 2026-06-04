<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Check, Save, Plus, Sparkles, WifiOff, X } from 'lucide-vue-next';
import { suggestTags } from '../services/api';
import type { DraftLog, LogEntry, TagNode, TagSuggestion } from '../types/domain';

const props = defineProps<{
  mapId: number;
  initialLog: LogEntry | null;
  draft?: DraftLog;
  existingTags: TagNode[];
  offline: boolean;
  draftSavedAt: string;
  draftRestored: boolean;
}>();

const emit = defineEmits<{
  save: [payload: DraftLog];
  cancel: [];
  draftChange: [payload: DraftLog];
}>();

const title = ref('');
const content = ref('');
const selectedTags = ref<string[]>([]);
const tagInput = ref('');
const suggestions = ref<TagSuggestion[]>([]);
const loadingSuggestions = ref(false);
const suggestionHint = ref('');
const error = ref('');
let suggestionTimer = 0;
let suggestionRequestId = 0;

const isEditing = computed(() => Boolean(props.initialLog));
const canSave = computed(() => title.value.trim() && content.value.trim() && selectedTags.value.length > 0);

watch(
  () => [props.initialLog?.id, props.draft],
  () => resetForm(),
  { immediate: true }
);

watch([title, content, selectedTags], () => {
  if (!isEditing.value) {
    emit('draftChange', {
      title: title.value,
      content: content.value,
      tagNames: selectedTags.value
    });
  }
});

watch([title, content], () => {
  if (isEditing.value) {
    return;
  }
  scheduleAutoSuggestions();
});

onBeforeUnmount(() => {
  window.clearTimeout(suggestionTimer);
});

function resetForm() {
  if (props.initialLog) {
    title.value = props.initialLog.title;
    content.value = props.initialLog.content;
    selectedTags.value = props.initialLog.tags.map((tag) => tag.name);
    suggestions.value = [];
    suggestionHint.value = '';
    return;
  }

  title.value = props.draft?.title ?? '';
  content.value = props.draft?.content ?? '';
  selectedTags.value = props.draft?.tagNames ?? [];
  suggestions.value = [];
  suggestionHint.value = '';
  scheduleAutoSuggestions();
}

function scheduleAutoSuggestions() {
  window.clearTimeout(suggestionTimer);
  const text = `${title.value}\n${content.value}`.trim();
  if (text.length < 12) {
    suggestions.value = [];
    suggestionHint.value = text.length > 0 ? '再写一点内容后会自动推荐标签。' : '';
    return;
  }
  suggestionHint.value = '内容停顿后会自动分析候选标签。';
  suggestionTimer = window.setTimeout(() => {
    void requestSuggestions('auto');
  }, 900);
}

async function requestSuggestions(trigger: 'auto' | 'manual' = 'manual') {
  error.value = '';
  if (!content.value.trim()) {
    error.value = '先写一点日志内容，系统才能推荐标签。';
    return;
  }
  window.clearTimeout(suggestionTimer);
  const requestId = ++suggestionRequestId;
  loadingSuggestions.value = true;
  suggestionHint.value = trigger === 'auto' ? '正在分析日志内容并推荐标签...' : '正在重新推荐标签...';
  try {
    const result = await suggestTags(props.mapId, `${title.value}\n${content.value}`);
    if (requestId !== suggestionRequestId) {
      return;
    }
    suggestions.value = result.filter((item) => !selectedTags.value.includes(item.name));
    if (suggestions.value.length === 0) {
      suggestionHint.value = '暂时没有新的候选标签，可以手动添加。';
      return;
    }
    suggestionHint.value = '已根据日志内容生成候选标签。';
  } catch (err) {
    if (requestId !== suggestionRequestId) {
      return;
    }
    error.value = err instanceof Error ? err.message : '推荐失败';
    suggestionHint.value = '推荐失败，可以先手动添加标签。';
  } finally {
    if (requestId === suggestionRequestId) {
      loadingSuggestions.value = false;
    }
  }
}

function addTag(name: string) {
  const clean = name.trim();
  if (!clean || selectedTags.value.includes(clean)) {
    return;
  }
  selectedTags.value = [...selectedTags.value, clean];
  suggestions.value = suggestions.value.filter((item) => item.name !== clean);
  tagInput.value = '';
}

function addManualTags() {
  tagInput.value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach(addTag);
}

function removeTag(name: string) {
  selectedTags.value = selectedTags.value.filter((tag) => tag !== name);
}

function save() {
  if (!canSave.value) {
    error.value = '标题、内容和至少一个标签都要填写。';
    return;
  }
  emit('save', {
    title: title.value.trim(),
    content: content.value.trim(),
    tagNames: selectedTags.value
  });
}
</script>

<template>
  <section class="panel editor-panel">
    <div class="panel-title">
      <span>{{ isEditing ? '编辑日志' : '新建日志' }}</span>
      <button class="icon-button" title="关闭编辑器" @click="emit('cancel')">
        <X :size="16" />
      </button>
    </div>

    <div v-if="!isEditing" class="draft-status" :class="{ offline }">
      <WifiOff v-if="offline" :size="15" />
      <Save v-else :size="15" />
      <span v-if="offline">当前离线，可以继续写，草稿会自动保存到 IndexedDB。</span>
      <span v-else-if="draftRestored">已恢复上次未保存草稿，联网后点击保存会写入后端。</span>
      <span v-else>{{ draftSavedAt ? `草稿已自动保存 ${draftSavedAt}` : '草稿会自动保存，刷新页面后仍可恢复。' }}</span>
    </div>

    <label class="field">
      <span>标题</span>
      <input v-model="title" placeholder="例如：Web 项目今天有进展" />
    </label>

    <label class="field">
      <span>内容</span>
      <textarea v-model="content" placeholder="写下今天发生的事情、状态或想法"></textarea>
    </label>

    <div class="editor-row">
      <button class="secondary-button" :disabled="loadingSuggestions" @click="requestSuggestions('manual')">
        <Sparkles :size="16" />
        {{ loadingSuggestions ? '分析中' : '推荐标签' }}
      </button>
      <span v-if="suggestionHint" class="suggestion-hint">{{ suggestionHint }}</span>
    </div>

    <div v-if="suggestions.length" class="suggestion-box">
      <button v-for="item in suggestions" :key="item.name" class="suggestion-item" @click="addTag(item.name)">
        <span class="suggestion-name">
          {{ item.name }}
          <small class="suggestion-source">{{ item.existing ? '已有' : '新增' }}</small>
        </span>
        <small>{{ item.reason }}</small>
      </button>
    </div>

    <div class="field">
      <span>已选标签</span>
      <div class="chip-list">
        <button v-for="tag in selectedTags" :key="tag" class="chip active" @click="removeTag(tag)">
          {{ tag }}
          <X :size="13" />
        </button>
      </div>
    </div>

    <div class="field">
      <span>常用标签</span>
      <div class="chip-list compact-tags">
        <button v-for="tag in existingTags" :key="tag.id" class="chip" :style="{ borderColor: tag.color }" @click="addTag(tag.name)">
          {{ tag.name }}
        </button>
      </div>
    </div>

    <label class="field">
      <span>手动添加</span>
      <div class="input-with-button">
        <input v-model="tagInput" placeholder="用空格或逗号分隔" @keydown.enter.prevent="addManualTags" />
        <button class="icon-button" title="添加标签" @click="addManualTags">
          <Plus :size="16" />
        </button>
      </div>
    </label>

    <p v-if="error" class="form-error">{{ error }}</p>

    <button class="primary-button wide" :disabled="!canSave" @click="save">
      <Check :size="17" />
      保存日志
    </button>
  </section>
</template>
