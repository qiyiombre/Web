<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Check, Edit3, Layers, Plus, Trash2, X } from 'lucide-vue-next';
import { createDomainCategory, deleteDomainCategory, listDomainCategories, updateDomainCategory } from '../services/api';
import type { DomainCategory } from '../types/domain';

const props = defineProps<{
  mapId: number;
  domainCategories: DomainCategory[];
}>();

const emit = defineEmits<{
  changed: [];
  focus: [category: DomainCategory];
}>();

const categoryName = ref('');
const categoryColor = ref('#62d6ff');
const categoryKeywords = ref('');
const editingCategoryId = ref<number | null>(null);
const editCategoryName = ref('');
const editCategoryColor = ref('#62d6ff');
const editCategoryKeywords = ref('');
const categoryBusy = ref(false);
const categoryError = ref('');
const loaded = ref(false);
const localCategories = ref<DomainCategory[]>([]);

const categories = computed(() => (loaded.value ? localCategories.value : props.domainCategories));
const categoryCountLabel = computed(() => String(categories.value.length));

watch(
  () => props.mapId,
  () => {
    loaded.value = false;
    localCategories.value = [];
    void loadCategories();
  },
  { immediate: true }
);

watch(
  () => props.domainCategories,
  (next) => {
    if (!loaded.value) {
      localCategories.value = next;
    }
  }
);

async function loadCategories() {
  categoryError.value = '';
  try {
    localCategories.value = await listDomainCategories(props.mapId);
    loaded.value = true;
  } catch (err) {
    categoryError.value = err instanceof Error ? err.message : '读取领域大类失败，可能需要重启服务器';
  }
}

async function addCategory() {
  categoryError.value = '';
  const name = categoryName.value.trim();
  if (!name) {
    categoryError.value = '请输入领域大类名称。';
    return;
  }
  categoryBusy.value = true;
  try {
    await createDomainCategory(props.mapId, {
      name,
      color: categoryColor.value,
      keywords: parseKeywords(categoryKeywords.value)
    });
    categoryName.value = '';
    categoryKeywords.value = '';
    await loadCategories();
    emit('changed');
  } catch (err) {
    categoryError.value = err instanceof Error ? err.message : '新增领域大类失败';
  } finally {
    categoryBusy.value = false;
  }
}

function startCategoryEdit(category: DomainCategory) {
  editingCategoryId.value = category.id;
  editCategoryName.value = category.name;
  editCategoryColor.value = category.color;
  editCategoryKeywords.value = category.keywords.join(' ');
  categoryError.value = '';
}

function cancelCategoryEdit() {
  editingCategoryId.value = null;
  editCategoryName.value = '';
  editCategoryColor.value = '#62d6ff';
  editCategoryKeywords.value = '';
}

async function saveCategoryEdit(category: DomainCategory) {
  categoryError.value = '';
  const name = editCategoryName.value.trim();
  if (!name) {
    categoryError.value = '领域大类名称不能为空。';
    return;
  }
  categoryBusy.value = true;
  try {
    await updateDomainCategory(category.id, {
      name,
      color: editCategoryColor.value,
      keywords: parseKeywords(editCategoryKeywords.value)
    });
    cancelCategoryEdit();
    await loadCategories();
    emit('changed');
  } catch (err) {
    categoryError.value = err instanceof Error ? err.message : '修改领域大类失败';
  } finally {
    categoryBusy.value = false;
  }
}

async function removeCategory(category: DomainCategory) {
  categoryError.value = '';
  categoryBusy.value = true;
  try {
    await deleteDomainCategory(category.id);
    if (editingCategoryId.value === category.id) {
      cancelCategoryEdit();
    }
    await loadCategories();
    emit('changed');
  } catch (err) {
    categoryError.value = err instanceof Error ? err.message : '删除领域大类失败';
  } finally {
    categoryBusy.value = false;
  }
}

function parseKeywords(value: string) {
  return [...new Set(value.split(/[\s,，、]+/u).map((item) => item.trim()).filter(Boolean))];
}
</script>

<template>
  <section class="panel domain-manager-panel">
    <div class="panel-title">
      <span>
        <Layers :size="16" />
        领域大类
      </span>
      <small>{{ categoryCountLabel }}</small>
    </div>

    <div class="domain-create-row">
      <input v-model="categoryColor" class="color-input" type="color" title="大类颜色" />
      <input v-model="categoryName" placeholder="大类名称" @keydown.enter.prevent="addCategory" />
      <button class="icon-button" title="新增大类" :disabled="categoryBusy" @click="addCategory">
        <Plus :size="16" />
      </button>
    </div>
    <input
      v-model="categoryKeywords"
      class="domain-keyword-input"
      placeholder="关键词，用空格或逗号分隔"
      @keydown.enter.prevent="addCategory"
    />

    <div class="domain-category-list">
      <div v-for="category in categories" :key="category.id" class="domain-category-item">
        <template v-if="editingCategoryId === category.id">
          <input v-model="editCategoryColor" class="color-input" type="color" title="大类颜色" />
          <input v-model="editCategoryName" class="domain-name-input" @keydown.enter.prevent="saveCategoryEdit(category)" />
          <input
            v-model="editCategoryKeywords"
            class="domain-keyword-input inline"
            placeholder="关键词"
            @keydown.enter.prevent="saveCategoryEdit(category)"
          />
          <button class="icon-button" title="保存" :disabled="categoryBusy" @click="saveCategoryEdit(category)">
            <Check :size="15" />
          </button>
          <button class="icon-button" title="取消" @click="cancelCategoryEdit">
            <X :size="15" />
          </button>
        </template>
        <template v-else>
          <button
            class="domain-category-card domain-category-focus"
            type="button"
            :title="`定位到${category.name}`"
            @click="emit('focus', category)"
          >
            <span class="tag-dot" :style="{ backgroundColor: category.color }"></span>
            <strong>{{ category.name }}</strong>
            <small>{{ category.keywords.length ? category.keywords.join(' / ') : '无关键词' }}</small>
          </button>
          <button class="icon-button" title="修改大类" @click="startCategoryEdit(category)">
            <Edit3 :size="15" />
          </button>
          <button class="icon-button danger" title="删除大类" :disabled="categoryBusy" @click="removeCategory(category)">
            <Trash2 :size="15" />
          </button>
        </template>
      </div>
      <p v-if="categories.length === 0" class="empty-inline">暂无固定大类，DeepSeek 仍可临时分组。</p>
    </div>

    <p v-if="categoryError" class="form-error">{{ categoryError }}</p>
  </section>
</template>
