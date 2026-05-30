<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { Check, Edit3, Plus, Search, Trash2, X } from 'lucide-vue-next';
import { createTag, deleteTag, updateTag } from '../services/api';
import type { TagNode } from '../types/domain';

const props = defineProps<{
  mapId: number;
  tags: TagNode[];
}>();

const emit = defineEmits<{
  changed: [];
  focus: [tagId: number];
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
let locatedTimer = 0;

const normalizedSearch = computed(() => searchTerm.value.trim().toLowerCase());
const filteredTags = computed(() => {
  if (!normalizedSearch.value) {
    return props.tags;
  }
  return props.tags.filter((tag) => tag.name.toLowerCase().includes(normalizedSearch.value));
});
const countLabel = computed(() => (normalizedSearch.value ? `${filteredTags.value.length}/${props.tags.length}` : String(props.tags.length)));

defineExpose({
  scrollToTag
});

onBeforeUnmount(() => {
  window.clearTimeout(locatedTimer);
});

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

async function removeTag(tag: TagNode) {
  const ok = window.confirm(`确认删除「${tag.name}」吗？已关联多篇日志的标签可能无法删除。`);
  if (!ok) {
    return;
  }
  error.value = '';
  busy.value = true;
  try {
    await deleteTag(tag.id);
    if (editingId.value === tag.id) {
      cancelEdit();
    }
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除标签失败';
  } finally {
    busy.value = false;
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
      <input v-model="searchTerm" type="search" placeholder="搜索标签" @keydown.escape.prevent="searchTerm = ''" />
      <button v-if="searchTerm" class="icon-button" title="清空搜索" @click="searchTerm = ''">
        <X :size="14" />
      </button>
    </div>

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
