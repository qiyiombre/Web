<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { GraphData, LogEntry } from '../types/domain';

type PickNode =
  | { kind: 'tag'; id: number; x: number; y: number; r: number }
  | { kind: 'log'; id: number; x: number; y: number; r: number };

type LayoutPoint = { x: number; y: number; r: number };

interface LayoutResponse {
  requestId: number;
  tagPositions: Array<{ id: number; x: number; y: number; r: number }>;
  logPositions: Array<{ id: number; x: number; y: number; r: number }>;
}

const props = defineProps<{
  graph: GraphData;
  activeTagIds: Set<number>;
  selectedLogId: number | null;
}>();

const emit = defineEmits<{
  tagToggle: [tagId: number];
  logOpen: [logId: number];
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const transform = reactive({ scale: 1, x: 0, y: 0 });
const pickNodes: PickNode[] = [];
const tagPositions = new Map<number, LayoutPoint>();
const logPositions = new Map<number, LayoutPoint>();
const manualTagPositions = new Map<number, { x: number; y: number }>();
const manualLogPositions = new Map<number, { x: number; y: number }>();
const layoutBusy = ref(false);
let ctx: CanvasRenderingContext2D | null = null;
let frame = 0;
let raf = 0;
let isDragging = false;
let dragMode: 'pan' | 'tag' | 'log' | null = null;
let dragTagId: number | null = null;
let dragLogId: number | null = null;
let dragTagOffset = { x: 0, y: 0 };
let dragLogOffset = { x: 0, y: 0 };
let moved = false;
let lastPointer = { x: 0, y: 0 };
let latestLayoutRequestId = 0;
let pendingFocusTagId: number | null = null;

const layoutWorker = new Worker(new URL('../workers/layoutWorker.ts', import.meta.url), { type: 'module' });
const activeIds = computed(() => [...props.activeTagIds]);

layoutWorker.onmessage = (event: MessageEvent<LayoutResponse>) => {
  const result = event.data;
  if (result.requestId !== latestLayoutRequestId) {
    return;
  }

  tagPositions.clear();
  logPositions.clear();
  for (const point of result.tagPositions) {
    tagPositions.set(point.id, { x: point.x, y: point.y, r: point.r });
  }
  for (const point of result.logPositions) {
    logPositions.set(point.id, { x: point.x, y: point.y, r: point.r });
  }
  layoutBusy.value = false;

  if (pendingFocusTagId !== null) {
    const tagId = pendingFocusTagId;
    pendingFocusTagId = null;
    centerTag(tagId);
  }
  draw();
};

layoutWorker.onerror = (event) => {
  layoutBusy.value = false;
  console.error('Nebula layout worker failed', event.message);
};

onMounted(async () => {
  await nextTick();
  ctx = canvas.value?.getContext('2d') ?? null;
  resize();
  window.addEventListener('resize', resize);
  animate();
  requestLayout();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  cancelAnimationFrame(raf);
  layoutWorker.terminate();
});

watch(
  () => props.graph.map.id,
  () => {
    loadManualPositions();
    requestLayout();
  },
  { immediate: true }
);

watch(
  () => [props.graph.tags, props.graph.logs, props.graph.tagSimilarities],
  () => requestLayout(),
  { deep: true }
);

watch(
  () => [props.activeTagIds, props.selectedLogId],
  () => draw(),
  { deep: true }
);

defineExpose({
  focusTag,
  resetTagLayout
});

function resize() {
  if (!canvas.value) {
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.value.width = Math.floor(rect.width * dpr);
  canvas.value.height = Math.floor(rect.height * dpr);
  canvas.value.style.width = `${rect.width}px`;
  canvas.value.style.height = `${rect.height}px`;
  ctx = canvas.value.getContext('2d');
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (transform.x === 0 && transform.y === 0) {
    transform.x = rect.width / 2;
    transform.y = rect.height / 2;
  }
  draw();
}

function animate() {
  frame += 1;
  draw();
  raf = requestAnimationFrame(animate);
}

function requestLayout() {
  latestLayoutRequestId += 1;
  layoutBusy.value = true;
  layoutWorker.postMessage({
    requestId: latestLayoutRequestId,
    tags: props.graph.tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      count: tag.count
    })),
    logs: props.graph.logs.map((log) => ({
      ...log,
      tags: log.tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color }))
    })),
    similarities: (props.graph.tagSimilarities ?? []).map((item) => ({ ...item })),
    manualTagPositions: [...manualTagPositions.entries()].map(([id, point]) => ({ id, x: point.x, y: point.y })),
    manualLogPositions: [...manualLogPositions.entries()].map(([id, point]) => ({ id, x: point.x, y: point.y }))
  });
}

function draw() {
  if (!ctx || !canvas.value) {
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawBackground(rect.width, rect.height);
  pickNodes.length = 0;

  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.scale, transform.scale);

  drawEdges();
  drawLogs();
  drawTags();

  ctx.restore();
  drawHud(rect.width, rect.height);
}

function drawBackground(width: number, height: number) {
  if (!ctx) {
    return;
  }
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#08111f');
  gradient.addColorStop(0.48, '#101927');
  gradient.addColorStop(1, '#061318');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 120; i += 1) {
    const x = (seeded(i + 11) * width + frame * 0.02 * (i % 3)) % width;
    const y = seeded(i + 97) * height;
    const alpha = 0.22 + seeded(i + 177) * 0.35;
    ctx.fillStyle = `rgba(210, 235, 255, ${alpha})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

function drawEdges() {
  if (!ctx) {
    return;
  }
  for (const edge of props.graph.edges) {
    const tag = tagPositions.get(edge.tagId);
    const log = logPositions.get(edge.logId);
    const logEntry = props.graph.logs.find((item) => item.id === edge.logId);
    if (!tag || !log || !logEntry) {
      continue;
    }
    const selected = props.selectedLogId === edge.logId;
    const highlighted = selected || isLogHighlighted(logEntry);
    ctx.beginPath();
    ctx.moveTo(tag.x, tag.y);
    ctx.lineTo(log.x, log.y);
    ctx.strokeStyle = highlighted ? 'rgba(130, 218, 255, 0.42)' : 'rgba(136, 156, 178, 0.12)';
    ctx.lineWidth = highlighted ? 1.5 / transform.scale : 0.7 / transform.scale;
    ctx.stroke();
  }
}

function drawTags() {
  if (!ctx) {
    return;
  }
  for (const tag of props.graph.tags) {
    const point = tagPositions.get(tag.id);
    if (!point) {
      continue;
    }
    const active = props.activeTagIds.has(tag.id);
    const related = activeIds.value.length === 0 || active || props.graph.logs.some((log) => isLogHighlighted(log) && log.tags.some((item) => item.id === tag.id));
    const glow = active ? 18 : related ? 9 : 3;
    ctx.save();
    ctx.shadowColor = tag.color;
    ctx.shadowBlur = glow;
    ctx.beginPath();
    ctx.fillStyle = active ? tag.color : `${tag.color}dd`;
    ctx.arc(point.x, point.y, point.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = active ? 3 / transform.scale : 1.4 / transform.scale;
    ctx.strokeStyle = active ? '#ffffff' : 'rgba(255, 255, 255, 0.55)';
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = active ? '#ffffff' : 'rgba(232, 243, 255, 0.86)';
    ctx.font = `${Math.max(12, 14 / transform.scale)}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(tag.name, point.x, point.y + point.r + 18 / transform.scale);
    pickNodes.push({ kind: 'tag', id: tag.id, x: point.x, y: point.y, r: point.r + 8 });
  }
}

function drawLogs() {
  if (!ctx) {
    return;
  }
  for (const log of props.graph.logs) {
    const point = logPositions.get(log.id);
    if (!point) {
      continue;
    }
    const highlighted = isLogHighlighted(log);
    const selected = props.selectedLogId === log.id;
    ctx.save();
    ctx.shadowColor = selected ? '#ffffff' : highlighted ? '#9ee7ff' : 'transparent';
    ctx.shadowBlur = selected ? 16 : highlighted ? 9 : 0;
    ctx.beginPath();
    ctx.fillStyle = selected ? '#ffffff' : highlighted ? '#9ee7ff' : 'rgba(151, 165, 182, 0.38)';
    ctx.arc(point.x, point.y, selected ? 8 : point.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = selected ? 2 / transform.scale : 1 / transform.scale;
    ctx.strokeStyle = selected ? '#55d6ff' : 'rgba(255,255,255,0.28)';
    ctx.stroke();
    ctx.restore();
    pickNodes.push({ kind: 'log', id: log.id, x: point.x, y: point.y, r: 10 });
  }
}

function drawHud(width: number, height: number) {
  const context = ctx;
  if (!context) {
    return;
  }
  const cleanHint =
    width > 700
      ? 'Web Worker 布局 · 滚轮缩放 · 拖拽空白平移 · 拖拽恒星/行星移动 · 点击查看'
      : 'Worker 布局 · 拖拽/缩放 · 点击查看';
  const cleanScaleText = `缩放 ${(transform.scale * 100).toFixed(0)}%`;

  context.fillStyle = 'rgba(255,255,255,0.68)';
  context.font = '12px "Microsoft YaHei", sans-serif';
  context.textAlign = 'left';
  context.fillText(layoutBusy.value ? '图谱关系正在由 Web Worker 计算...' : cleanHint, 18, height - 18, Math.max(160, width - 150));
  context.textAlign = 'right';
  context.fillText(cleanScaleText, width - 18, height - 18);
  return;
  /*
  const hint =
    width > 700
      ? 'Web Worker 布局 · 滚轮缩放 · 拖拽空白平移 · 拖拽恒星移动标签 · 点击行星查看'
      : 'Worker 布局 · 拖拽/缩放 · 点击查看';
  const scaleText = `缩放 ${(transform.scale * 100).toFixed(0)}%`;

  context.fillStyle = 'rgba(255,255,255,0.68)';
  context.font = '12px "Microsoft YaHei", sans-serif';
  context.textAlign = 'left';
  context.fillText(layoutBusy.value ? '图谱关系正在由 Web Worker 计算...' : hint, 18, height - 18, Math.max(160, width - 150));
  context.textAlign = 'right';
  context.fillText(scaleText, width - 18, height - 18);
  */
}

function isLogHighlighted(log: LogEntry) {
  if (props.activeTagIds.size === 0) {
    return false;
  }
  return [...props.activeTagIds].every((id) => log.tags.some((tag) => tag.id === id));
}

function onPointerDown(event: PointerEvent) {
  isDragging = true;
  dragMode = 'pan';
  dragTagId = null;
  dragLogId = null;
  moved = false;
  lastPointer = { x: event.clientX, y: event.clientY };
  const picked = pickNodeAt(event.offsetX, event.offsetY);
  if (picked?.kind === 'tag') {
    const point = screenToWorld(event.offsetX, event.offsetY);
    dragMode = 'tag';
    dragTagId = picked.id;
    dragTagOffset = {
      x: picked.x - point.x,
      y: picked.y - point.y
    };
  } else if (picked?.kind === 'log') {
    const point = screenToWorld(event.offsetX, event.offsetY);
    dragMode = 'log';
    dragLogId = picked.id;
    dragLogOffset = {
      x: picked.x - point.x,
      y: picked.y - point.y
    };
  }
  canvas.value?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (!isDragging) {
    return;
  }
  const dx = event.clientX - lastPointer.x;
  const dy = event.clientY - lastPointer.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) {
    moved = true;
  }
  if (dragMode === 'tag' && dragTagId !== null) {
    const point = screenToWorld(event.offsetX, event.offsetY);
    const next = {
      x: point.x + dragTagOffset.x,
      y: point.y + dragTagOffset.y
    };
    manualTagPositions.set(dragTagId, next);
    const current = tagPositions.get(dragTagId);
    if (current) {
      current.x = next.x;
      current.y = next.y;
    }
  } else if (dragMode === 'log' && dragLogId !== null) {
    const point = screenToWorld(event.offsetX, event.offsetY);
    const next = {
      x: point.x + dragLogOffset.x,
      y: point.y + dragLogOffset.y
    };
    manualLogPositions.set(dragLogId, next);
    const current = logPositions.get(dragLogId);
    if (current) {
      current.x = next.x;
      current.y = next.y;
    }
  } else {
    transform.x += dx;
    transform.y += dy;
  }
  lastPointer = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent) {
  canvas.value?.releasePointerCapture(event.pointerId);
  isDragging = false;
  const mode = dragMode;
  const tagId = dragTagId;
  const logId = dragLogId;
  dragMode = null;
  dragTagId = null;
  dragLogId = null;
  if (mode === 'tag' && tagId !== null) {
    if (moved) {
      saveManualPositions();
      requestLayout();
      return;
    }
    emit('tagToggle', tagId);
    return;
  }
  if (mode === 'log' && logId !== null) {
    if (moved) {
      saveManualPositions();
      requestLayout();
      return;
    }
    emit('logOpen', logId);
    return;
  }
  if (moved) {
    return;
  }
  const picked = pickNodeAt(event.offsetX, event.offsetY);
  if (!picked) {
    return;
  }
  if (picked.kind === 'tag') {
    emit('tagToggle', picked.id);
  } else {
    emit('logOpen', picked.id);
  }
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  const zoom = event.deltaY < 0 ? 1.08 : 0.92;
  const before = screenToWorld(event.offsetX, event.offsetY);
  transform.scale = Math.min(2.4, Math.max(0.45, transform.scale * zoom));
  const after = worldToScreen(before.x, before.y);
  transform.x += event.offsetX - after.x;
  transform.y += event.offsetY - after.y;
}

function focusTag(tagId: number) {
  if (!canvas.value) {
    pendingFocusTagId = tagId;
    return;
  }
  if (!tagPositions.has(tagId)) {
    pendingFocusTagId = tagId;
    requestLayout();
    return;
  }
  centerTag(tagId);
}

function centerTag(tagId: number) {
  if (!canvas.value) {
    return;
  }
  const point = tagPositions.get(tagId);
  if (!point) {
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  transform.scale = Math.max(transform.scale, 1.08);
  transform.x = rect.width / 2 - point.x * transform.scale;
  transform.y = rect.height / 2 - point.y * transform.scale;
}

function pickNodeAt(screenX: number, screenY: number) {
  const point = screenToWorld(screenX, screenY);
  return [...pickNodes].reverse().find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= node.r);
}

function tagPositionStorageKey() {
  return `nebula.tagPositions.${props.graph.map.id}`;
}

function logPositionStorageKey() {
  return `nebula.logPositions.${props.graph.map.id}`;
}

function loadManualPositions() {
  manualTagPositions.clear();
  manualLogPositions.clear();
  loadManualPointMap(tagPositionStorageKey(), new Set(props.graph.tags.map((tag) => tag.id)), manualTagPositions);
  loadManualPointMap(logPositionStorageKey(), new Set(props.graph.logs.map((log) => log.id)), manualLogPositions);
}

function loadManualPointMap(
  key: string,
  validIds: Set<number>,
  target: Map<number, { x: number; y: number }>
) {
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return;
  }
  try {
    const saved = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    for (const [id, point] of Object.entries(saved)) {
      const nodeId = Number(id);
      if (validIds.has(nodeId) && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        target.set(nodeId, { x: point.x, y: point.y });
      }
    }
  } catch {
    window.localStorage.removeItem(key);
  }
}

function saveManualPositions() {
  saveManualPointMap(tagPositionStorageKey(), new Set(props.graph.tags.map((tag) => tag.id)), manualTagPositions);
  saveManualPointMap(logPositionStorageKey(), new Set(props.graph.logs.map((log) => log.id)), manualLogPositions);
}

function saveManualPointMap(
  key: string,
  validIds: Set<number>,
  source: Map<number, { x: number; y: number }>
) {
  const saved = Object.fromEntries([...source.entries()].filter(([id]) => validIds.has(id)));
  window.localStorage.setItem(key, JSON.stringify(saved));
}

function resetTagLayout() {
  manualTagPositions.clear();
  manualLogPositions.clear();
  window.localStorage.removeItem(tagPositionStorageKey());
  window.localStorage.removeItem(logPositionStorageKey());
  requestLayout();
}

function worldToScreen(x: number, y: number) {
  return {
    x: x * transform.scale + transform.x,
    y: y * transform.scale + transform.y
  };
}

function screenToWorld(x: number, y: number) {
  return {
    x: (x - transform.x) / transform.scale,
    y: (y - transform.y) / transform.scale
  };
}

function seeded(input: number) {
  const x = Math.sin(input * 999.91) * 10000;
  return x - Math.floor(x);
}
</script>

<template>
  <div class="canvas-wrap">
    <canvas
      ref="canvas"
      class="nebula-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @wheel="onWheel"
    ></canvas>
  </div>
</template>
