<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Check, ChevronDown, Map as MapIcon } from 'lucide-vue-next';
import type { NebulaMap } from '../types/domain';

const props = defineProps<{
  maps: NebulaMap[];
  modelValue: number;
}>();

const emit = defineEmits<{
  change: [mapId: number];
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const activeMap = computed(() => props.maps.find(map => map.id === props.modelValue) ?? null);

function selectMap(mapId: number) {
  open.value = false;
  if (mapId !== props.modelValue) {
    emit('change', mapId);
  }
}

function closeFromOutside(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) {
    open.value = false;
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('click', closeFromOutside);
  document.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', closeFromOutside);
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div v-if="maps.length > 1" ref="root" class="map-switcher">
    <button class="map-switcher-trigger" type="button" @click.stop="open = !open">
      <MapIcon :size="14" />
      <span>{{ activeMap?.name ?? '切换星图' }}</span>
      <ChevronDown :size="14" :class="{ open }" />
    </button>
    <div v-if="open" class="map-switcher-menu" role="menu">
      <button
        v-for="map in maps"
        :key="map.id"
        class="map-switcher-item"
        :class="{ active: map.id === modelValue }"
        type="button"
        role="menuitem"
        @click="selectMap(map.id)"
      >
        <span>{{ map.name }}</span>
        <Check v-if="map.id === modelValue" :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.map-switcher {
  position: relative;
  min-width: 180px;
}

.map-switcher-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid rgba(98, 214, 255, 0.2);
  background:
    linear-gradient(135deg, rgba(98, 214, 255, 0.1), rgba(185, 156, 255, 0.06)),
    rgba(255, 255, 255, 0.045);
  color: #eef6ff;
  font-size: 13px;
  cursor: pointer;
}

.map-switcher-trigger span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.map-switcher-trigger svg {
  flex-shrink: 0;
  color: #8ddfff;
}

.map-switcher-trigger .open {
  transform: rotate(180deg);
}

.map-switcher-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 80;
  width: min(280px, 72vw);
  max-height: 280px;
  overflow-y: auto;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid rgba(98, 214, 255, 0.18);
  background: rgba(13, 24, 39, 0.98);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(14px);
}

.map-switcher-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 34px;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: rgba(238, 246, 255, 0.68);
  font-size: 13px;
  cursor: pointer;
}

.map-switcher-item span {
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.map-switcher-item:hover,
.map-switcher-item.active {
  background: rgba(98, 214, 255, 0.11);
  color: #eef6ff;
}

.map-switcher-item svg {
  flex-shrink: 0;
  color: #8cf0b4;
}
</style>
