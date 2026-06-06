<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Check, Edit3, Plus, Search, Sparkles, Trash2, X } from 'lucide-vue-next';
import { createTag, searchExistingTags, updateTag } from '../services/api';
import type { TagNode, TagSearchMatch } from '../types/domain';

const props = defineProps<{
  mapId: number;
  tags: TagNode[];
}>();

const emit = defineEmits<{
  changed: [];
  focus: [tagId: number];
  deleteRequest: [tag: TagNode];
}>();

const newName = ref('');
const newColor = ref('#62d6ff');
const editingId = ref<number | null>(null);
const editName = ref('');
const editColor = ref('#62d6ff');
const busy = ref(false);
const error = ref('');
const listRef = ref<HTMLElement | null>(null);
const locatedId = ref<number | null>(null);
const searchTerm = ref('');
const deepSearchEnabled = ref(false);
const deepSearchBusy = ref(false);
const deepSearchError = ref('');
const deepSearchHint = ref('');
const deepSearchMatches = ref<TagSearchMatch[]>([]);
const deepSearchQuery = ref('');
let locatedTimer = 0;
let deepSearchTimer = 0;
let deepSearchRequestId = 0;

const normalizedSearch = computed(() => searchTerm.value.trim().toLowerCase());
const tagSignature = computed(() => props.tags.map((tag) => `${tag.id}:${tag.name}:${tag.count}`).join('|'));
const localFilteredTags = computed(() => {
  if (!normalizedSearch.value) {
    return props.tags;
  }
  return props.tags.filter((tag) => tag.name.toLowerCase().includes(normalizedSearch.value));
});
const deepSearchActive = computed(() => deepSearchEnabled.value && Boolean(normalizedSearch.value));
const deepSearchReady = computed(() => deepSearchQuery.value === normalizedSearch.value);
const filteredTags = computed(() => {
  if (!deepSearchActive.value) {
    return localFilteredTags.value;
  }
  if (!deepSearchReady.value) {
    return localFilteredTags.value;
  }
  const tagsById = new Map(props.tags.map((tag) => [tag.id, tag]));
  return deepSearchMatches.value.map((match) => tagsById.get(match.id)).filter(Boolean) as TagNode[];
});
const countLabel = computed(() => (normalizedSearch.value ? `${filteredTags.value.length}/${props.tags.length}` : String(props.tags.length)));
const searchStatus = computed(() => {
  if (!deepSearchEnabled.value) {
    return '';
  }
  if (!normalizedSearch.value) {
    return 'DeepSeek 模糊搜索已开启';
  }
  if (deepSearchBusy.value) {
    return 'DeepSeek 模糊搜索中...';
  }
  if (deepSearchError.value) {
    return deepSearchError.value;
  }
  if (!deepSearchReady.value) {
    return '';
  }
  return deepSearchHint.value || (deepSearchMatches.value.length > 0 ? 'DeepSeek 模糊搜索已完成' : 'DeepSeek 没有找到相近标签');
});

defineExpose({
  scrollToTag
});

onBeforeUnmount(() => {
  window.clearTimeout(locatedTimer);
  window.clearTimeout(deepSearchTimer);
});

watch(
  () => [normalizedSearch.value, deepSearchEnabled.value, tagSignature.value],
  () => scheduleDeepSearch(),
  { immediate: true }
);

async function addTag() {
  error.value = '';
  const name = newName.value.trim();
  if (!name) {
    error.value = '请输入标签名称。';
    return;
  }
  busy.value = true;
  try {
    await createTag({ mapId: props.mapId, name, color: newColor.value });
    newName.value = '';
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '新增标签失败';
  } finally {
    busy.value = false;
  }
}

function startEdit(tag: TagNode) {
  editingId.value = tag.id;
  editName.value = tag.name;
  editColor.value = tag.color;
  error.value = '';
}

function cancelEdit() {
  editingId.value = null;
  editName.value = '';
  editColor.value = '#62d6ff';
}

async function saveEdit(tag: TagNode) {
  error.value = '';
  const name = editName.value.trim();
  if (!name) {
    error.value = '标签名称不能为空。';
    return;
  }
  busy.value = true;
  try {
    await updateTag(tag.id, { name, color: editColor.value });
    cancelEdit();
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '修改标签失败';
  } finally {
    busy.value = false;
  }
}

function removeTag(tag: TagNode) {
  error.value = '';
  emit('deleteRequest', tag);
}

function toggleDeepSearch() {
  deepSearchEnabled.value = !deepSearchEnabled.value;
  if (!deepSearchEnabled.value) {
    window.clearTimeout(deepSearchTimer);
    deepSearchBusy.value = false;
    deepSearchError.value = '';
    deepSearchHint.value = '';
    deepSearchMatches.value = [];
    deepSearchQuery.value = '';
    return;
  }
  scheduleDeepSearch(0);
}

function scheduleDeepSearch(delay = 360) {
  window.clearTimeout(deepSearchTimer);
  if (!deepSearchEnabled.value || !normalizedSearch.value) {
    deepSearchBusy.value = false;
    deepSearchError.value = '';
    deepSearchHint.value = '';
    deepSearchMatches.value = [];
    deepSearchQuery.value = '';
    return;
  }
  deepSearchTimer = window.setTimeout(() => {
    void runDeepSearch();
  }, delay);
}

async function runDeepSearch() {
  const query = normalizedSearch.value;
  if (!query) {
    return;
  }
  const requestId = ++deepSearchRequestId;
  deepSearchBusy.value = true;
  deepSearchError.value = '';
  try {
    const result = await searchExistingTags(props.mapId, query);
    if (requestId !== deepSearchRequestId || query !== normalizedSearch.value) {
      return;
    }
    deepSearchMatches.value = result.matches ?? [];
    deepSearchQuery.value = query;
    deepSearchHint.value = result.aiMeta?.message ?? 'DeepSeek 模糊搜索已完成';
  } catch (err) {
    if (requestId !== deepSearchRequestId) {
      return;
    }
    deepSearchMatches.value = [];
    deepSearchQuery.value = '';
    deepSearchHint.value = '';
    deepSearchError.value = err instanceof Error ? err.message : 'DeepSeek 模糊搜索失败';
  } finally {
    if (requestId === deepSearchRequestId) {
      deepSearchBusy.value = false;
    }
  }
}

async function scrollToTag(tagId: number) {
  if (normalizedSearch.value && !filteredTags.value.some((tag) => tag.id === tagId)) {
    searchTerm.value = '';
  }
  await nextTick();
  const target = listRef.value?.querySelector<HTMLElement>(`[data-tag-id="${tagId}"]`);
  if (!target) {
    return;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  locatedId.value = tagId;
  window.clearTimeout(locatedTimer);
  locatedTimer = window.setTimeout(() => {
    if (locatedId.value === tagId) {
      locatedId.value = null;
    }
  }, 1400);
}
</script>

<template>
  <section class="panel tag-manager-panel">
    <div class="panel-title">
      <span>标签管理</span>
      <small>{{ countLabel }}</small>
    </div>

    <div class="tag-create-row">
      <input v-model="newColor" class="color-input" type="color" title="标签颜色" />
      <input v-model="newName" placeholder="新标签名称" @keydown.enter.prevent="addTag" />
      <button class="icon-button" title="新增标签" :disabled="busy" @click="addTag">
        <Plus :size="16" />
      </button>
    </div>

    <div class="tag-search-row">
      <Search :size="15" />
      <button
        class="icon-button deep-search-toggle"
        :class="{ active: deepSearchEnabled }"
        title="DeepSeek 模糊搜索"
        @click="toggleDeepSearch"
      >
        <Sparkles :size="14" />
      </button>
      <input v-model="searchTerm" type="search" placeholder="搜索标签" @keydown.escape.prevent="searchTerm = ''" />
      <button v-if="searchTerm" class="icon-button" title="清空搜索" @click="searchTerm = ''">
        <X :size="14" />
      </button>
    </div>

    <p v-if="searchStatus" class="tag-search-status" :class="{ error: deepSearchError }">{{ searchStatus }}</p>

    <div ref="listRef" class="tag-manage-list">
      <div v-for="tag in filteredTags" :key="tag.id" class="tag-manage-item" :class="{ located: locatedId === tag.id }" :data-tag-id="tag.id">
        <template v-if="editingId === tag.id">
          <input v-model="editColor" class="color-input" type="color" title="标签颜色" />
          <input v-model="editName" class="tag-edit-input" @keydown.enter.prevent="saveEdit(tag)" />
          <button class="icon-button" title="保存" :disabled="busy" @click="saveEdit(tag)">
            <Check :size="15" />
          </button>
          <button class="icon-button" title="取消" @click="cancelEdit">
            <X :size="15" />
          </button>
        </template>
        <template v-else>
          <button class="tag-name-button" @click="emit('focus', tag.id)">
            <span class="tag-dot" :style="{ backgroundColor: tag.color }"></span>
            <span>{{ tag.name }}</span>
            <small>{{ tag.count }}</small>
          </button>
          <button class="icon-button" title="修改标签" @click="startEdit(tag)">
            <Edit3 :size="15" />
          </button>
          <button class="icon-button danger" title="删除标签" :disabled="busy" @click="removeTag(tag)">
            <Trash2 :size="15" />
          </button>
        </template>
      </div>
      <p v-if="normalizedSearch && filteredTags.length === 0" class="empty-inline">没有找到这个标签</p>
    </div>

    <p v-if="error" class="form-error">{{ error }}</p>
  </section>
</template>
