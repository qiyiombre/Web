<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Check, Save, Plus, Sparkles, WifiOff, X } from 'lucide-vue-next';
import { suggestTags } from '../services/api';
import type { AiMeta, DraftLog, LogEntry, TagNode, TagSuggestion, TagSuggestionResponse } from '../types/domain';

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
let suggestionRequestId = 0;

const isEditing = computed(() => Boolean(props.initialLog));
const canSave = computed(() => title.value.trim() && content.value.trim() && selectedTags.value.length > 0);

watch(
  () => [props.mapId, props.initialLog?.id ?? null],
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
}

async function requestSuggestions(trigger: 'auto' | 'manual' = 'manual') {
  error.value = '';
  if (!content.value.trim()) {
    error.value = '先写一点日志内容，系统才能推荐标签。';
    return;
  }
  const requestId = ++suggestionRequestId;
  loadingSuggestions.value = true;
  suggestionHint.value = trigger === 'auto' ? '正在分析日志内容并推荐标签...' : '正在推荐标签...';
  try {
    const result = normalizeSuggestionResponse(await suggestTags(props.mapId, `${title.value}\n${content.value}`));
    if (requestId !== suggestionRequestId) {
      return;
    }
    suggestions.value = (result.suggestions ?? []).filter((item) => item?.name);
    if (suggestions.value.length === 0) {
      suggestionHint.value = `${result.aiMeta.message}；暂时没有新的候选标签，可以手动添加。`;
      return;
    }
    suggestionHint.value = result.aiMeta.message;
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
  tagInput.value = '';
}

function toggleSuggestedTag(name: string) {
  const clean = name.trim();
  if (!clean) {
    return;
  }
  if (selectedTags.value.includes(clean)) {
    removeTag(clean);
    return;
  }
  addTag(clean);
}

function normalizeSuggestionResponse(result: TagSuggestionResponse | TagSuggestion[] | undefined | null): TagSuggestionResponse {
  if (!result) {
    return {
      suggestions: [],
      aiMeta: fallbackAiMeta('推荐标签接口没有返回有效数据，可以先手动添加标签')
    };
  }
  if (Array.isArray(result)) {
    return {
      suggestions: result,
      aiMeta: fallbackAiMeta('旧版后端未返回来源状态，标签推荐结果已正常加载')
    };
  }
  return {
    suggestions: result.suggestions ?? [],
    aiMeta: result.aiMeta ?? fallbackAiMeta('标签推荐已完成，但后端未返回来源状态')
  };
}

function fallbackAiMeta(message: string): AiMeta {
  return {
    feature: 'tagSuggestions',
    source: 'local',
    attempted: false,
    message
  };
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
  <section class="panel editor-panel log-editor-panel">
    <div class="panel-title log-editor-title">
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
      <button
        v-for="item in suggestions"
        :key="item.name"
        class="suggestion-item"
        :class="{ selected: selectedTags.includes(item.name) }"
        @click="toggleSuggestedTag(item.name)"
      >
        <span class="suggestion-name">
          {{ item.name }}
          <small class="suggestion-source">{{ selectedTags.includes(item.name) ? '已选' : item.existing ? '已有' : '新增' }}</small>
          <small class="suggestion-source">{{ item.source === 'deepseek' ? 'DeepSeek' : '本地' }}</small>
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
