<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { GraphData, LayoutMode, LogEntry, TagNode } from '../types/domain';

type PickNode =
  | { kind: 'tag'; id: number; x: number; y: number; r: number }
  | { kind: 'log'; id: number; x: number; y: number; r: number };

type LayoutPoint = { x: number; y: number; r: number };
type LayoutSnapshot = {
  tags: Array<[number, { x: number; y: number }]>;
  logs: Array<[number, { x: number; y: number }]>;
};

interface LayoutResponse {
  requestId: number;
  tagPositions: Array<{ id: number; x: number; y: number; r: number }>;
  logPositions: Array<{ id: number; x: number; y: number; r: number }>;
}

type DrawState = {
  logsById: Map<number, LogEntry>;
  tagsById: Map<number, TagNode>;
  selectedLogId: number | null;
  activeRelationMode: boolean;
  highlightedLogIds: Set<number>;
  visibleLogIds: Set<number>;
  visibleTagIds: Set<number>;
  selectedLogTagIds: Set<number>;
  relatedTagIds: Set<number>;
};

const props = defineProps<{
  graph: GraphData;
  layoutMode: LayoutMode;
  activeTagIds: Set<number>;
  selectedLogId: number | null;
}>();

const emit = defineEmits<{
  tagToggle: [tagId: number];
  tagContext: [payload: { tagId: number; x: number; y: number; width: number; height: number }];
  logOpen: [logId: number];
  logInspect: [payload: { logId: number; x: number; y: number; width: number; height: number }];
  layoutDirty: [dirty: boolean];
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const transform = reactive({ scale: 1, x: 0, y: 0 });
const nebulaCursor = reactive({ x: 0, y: 0, visible: false, angle: -0.2 });
const pickNodes: PickNode[] = [];
const tagPositions = new Map<number, LayoutPoint>();
const logPositions = new Map<number, LayoutPoint>();
const manualTagPositions = new Map<number, { x: number; y: number }>();
const manualLogPositions = new Map<number, { x: number; y: number }>();
const layoutBusy = ref(false);
let ctx: CanvasRenderingContext2D | null = null;
let frame = 0;
let raf = 0;
let cursorRaf = 0;
let pendingCursor: { x: number; y: number } | null = null;
let lastDrawAt = 0;
let isDragging = false;
let dragMode: 'pan' | 'tag' | 'log' | null = null;
let dragTagId: number | null = null;
let dragLogId: number | null = null;
let dragTagOffset = { x: 0, y: 0 };
let dragLogOffset = { x: 0, y: 0 };
let moved = false;
let lastPointer = { x: 0, y: 0 };
let dragButton = 0;
let latestLayoutRequestId = 0;
let pendingFocusTagId: number | null = null;
let dragSnapshot: LayoutSnapshot | null = null;
let lastPanInteractionAt = 0;
const layoutHistory: LayoutSnapshot[] = [];
const redoHistory: LayoutSnapshot[] = [];

const layoutWorker = new Worker(new URL('../workers/layoutWorker.ts', import.meta.url), { type: 'module' });
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
  cancelAnimationFrame(cursorRaf);
  layoutWorker.terminate();
});

watch(
  () => [props.graph.map.id, props.layoutMode],
  () => {
    loadManualPositions();
    requestLayout();
  },
  { immediate: true }
);

watch(
  () => [props.graph.tags, props.graph.logs, props.graph.tagSimilarities, props.graph.tagGroups, props.layoutMode],
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
  focusLog,
  resetTagLayout,
  refreshLayout,
  saveLayout,
  undoLayout,
  redoLayout
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

function animate(timestamp = 0) {
  const targetFrameMs = hasActiveRelationMode() && !isDragging ? 33 : 16;
  if (lastDrawAt === 0 || timestamp - lastDrawAt >= targetFrameMs) {
    frame += 1;
    draw();
    lastDrawAt = timestamp;
  }
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
    tagGroups: (props.graph.tagGroups ?? []).map((group) => ({ ...group, tagIds: [...group.tagIds] })),
    layoutMode: props.layoutMode,
    manualTagPositions: [...manualTagPositions.entries()].map(([id, point]) => ({ id, x: point.x, y: point.y })),
    manualLogPositions: [...manualLogPositions.entries()].map(([id, point]) => ({ id, x: point.x, y: point.y }))
  });
}

function draw() {
  if (!ctx || !canvas.value) {
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const state = buildDrawState();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawBackground(rect.width, rect.height);
  pickNodes.length = 0;

  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.scale, transform.scale);

  drawRelationFlows(state);
  drawLogs(state);
  drawTags(state);

  ctx.restore();
  drawHud(rect.width, rect.height);
}

function buildDrawState(): DrawState {
  const logsById = new Map(props.graph.logs.map((log) => [log.id, log]));
  const tagsById = new Map(props.graph.tags.map((tag) => [tag.id, tag]));
  const selectedLog = props.selectedLogId === null ? null : logsById.get(props.selectedLogId) ?? null;
  const selectedLogTagIds = new Set(selectedLog?.tags.map((tag) => tag.id) ?? []);
  const activeIds = [...props.activeTagIds];
  const highlightedLogIds = new Set<number>();
  const visibleLogIds = new Set<number>();
  const visibleTagIds = new Set<number>();
  const relatedTagIds = new Set<number>();
  const activeRelationMode = activeIds.length > 0 || props.selectedLogId !== null;

  for (const log of props.graph.logs) {
    const tagIds = new Set(log.tags.map((tag) => tag.id));
    if (activeIds.length > 0 && activeIds.every((id) => tagIds.has(id))) {
      highlightedLogIds.add(log.id);
    }
  }

  if (!activeRelationMode) {
    for (const log of props.graph.logs) {
      visibleLogIds.add(log.id);
    }
    for (const tag of props.graph.tags) {
      visibleTagIds.add(tag.id);
      relatedTagIds.add(tag.id);
    }
    return {
      logsById,
      tagsById,
      selectedLogId: props.selectedLogId,
      activeRelationMode,
      highlightedLogIds,
      visibleLogIds,
      visibleTagIds,
      selectedLogTagIds,
      relatedTagIds
    };
  }

  for (const tagId of activeIds) {
    visibleTagIds.add(tagId);
    relatedTagIds.add(tagId);
  }

  for (const log of props.graph.logs) {
    if (!highlightedLogIds.has(log.id)) {
      continue;
    }
    visibleLogIds.add(log.id);
    for (const tag of log.tags) {
      visibleTagIds.add(tag.id);
      relatedTagIds.add(tag.id);
    }
  }

  if (selectedLog) {
    visibleLogIds.add(selectedLog.id);
    for (const tag of selectedLog.tags) {
      visibleTagIds.add(tag.id);
      relatedTagIds.add(tag.id);
    }
  }

  return {
    logsById,
    tagsById,
    selectedLogId: props.selectedLogId,
    activeRelationMode,
    highlightedLogIds,
    visibleLogIds,
    visibleTagIds,
    selectedLogTagIds,
    relatedTagIds
  };
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

function drawRelationFlows(state: DrawState) {
  if (!ctx) {
    return;
  }
  if (!state.activeRelationMode) {
    return;
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const edge of props.graph.edges) {
    const tag = tagPositions.get(edge.tagId);
    const log = logPositions.get(edge.logId);
    const logEntry = state.logsById.get(edge.logId);
    const tagEntry = state.tagsById.get(edge.tagId);
    if (!tag || !log || !logEntry || !tagEntry) {
      continue;
    }
    const relation = relationFlowState(edge.tagId, logEntry, state);
    if (!relation.visible) {
      continue;
    }
    const dx = log.x - tag.x;
    const dy = log.y - tag.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const bend = (seeded(edge.tagId * 13 + edge.logId) - 0.5) * 72;
    const control = {
      x: (tag.x + log.x) / 2 + (-dy / length) * bend,
      y: (tag.y + log.y) / 2 + (dx / length) * bend
    };
    const phase = seeded(edge.tagId * 31 + edge.logId);
    const alpha = relation.selected ? 0.18 : 0.12;

    ctx.beginPath();
    ctx.moveTo(tag.x, tag.y);
    ctx.quadraticCurveTo(control.x, control.y, log.x, log.y);
    ctx.strokeStyle = hexToRgba(tagEntry.color, alpha);
    ctx.lineWidth = (relation.selected ? 7 : 4.5) / transform.scale;
    ctx.shadowColor = tagEntry.color;
    ctx.shadowBlur = (relation.selected ? 9 : 4) / transform.scale;
    ctx.stroke();

    const particleCount = relation.selected ? 4 : 2;
    for (let index = 0; index < particleCount; index += 1) {
      const t = (frame * 0.018 + phase + index / particleCount) % 1;
      const point = quadraticPoint(tag, control, log, t);
      const pulse = 0.65 + Math.sin((t + phase) * Math.PI * 2) * 0.25;
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(tagEntry.color, (relation.selected ? 0.72 : 0.48) * pulse);
      ctx.shadowBlur = 3 / transform.scale;
      ctx.arc(point.x, point.y, (1.7 + pulse * 1.4) / transform.scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawTags(state: DrawState) {
  if (!ctx) {
    return;
  }
  for (const tag of props.graph.tags) {
    const point = tagPositions.get(tag.id);
    if (!point) {
      continue;
    }
    if (!state.visibleTagIds.has(tag.id)) {
      continue;
    }
    const active = props.activeTagIds.has(tag.id);
    const relatedToSelected = state.selectedLogTagIds.has(tag.id);
    const related = !state.activeRelationMode || active || relatedToSelected || state.relatedTagIds.has(tag.id);
    const glow = active || relatedToSelected ? 16 : related ? 7 : 0;
    ctx.save();
    ctx.shadowColor = tag.color;
    ctx.shadowBlur = glow;
    ctx.beginPath();
    ctx.fillStyle = active || relatedToSelected ? tag.color : related ? `${tag.color}dd` : `${tag.color}55`;
    const visualRadius = point.r * (active || relatedToSelected ? 1.12 : 1);
    ctx.arc(point.x, point.y, visualRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = active || relatedToSelected ? 3 / transform.scale : 1.4 / transform.scale;
    ctx.strokeStyle = active || relatedToSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.55)';
    ctx.stroke();

    if (active || relatedToSelected) {
      const pulse = 0.5 + 0.5 * Math.sin(frame * 0.045 + tag.id);
      ctx.beginPath();
      ctx.shadowBlur = 8 / transform.scale;
      ctx.strokeStyle = hexToRgba(tag.color, 0.22 + pulse * 0.18);
      ctx.lineWidth = 2 / transform.scale;
      ctx.arc(point.x, point.y, visualRadius * (1.55 + pulse * 0.25), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = active || relatedToSelected ? '#ffffff' : related ? 'rgba(232, 243, 255, 0.86)' : 'rgba(232, 243, 255, 0.42)';
    ctx.font = `${Math.max(12, 14 / transform.scale)}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(tag.name, point.x, point.y + visualRadius + 18 / transform.scale);
    pickNodes.push({ kind: 'tag', id: tag.id, x: point.x, y: point.y, r: visualRadius + 10 });
  }
}

function drawLogs(state: DrawState) {
  if (!ctx) {
    return;
  }
  for (const log of props.graph.logs) {
    const point = logPositions.get(log.id);
    if (!point) {
      continue;
    }
    if (!state.visibleLogIds.has(log.id)) {
      continue;
    }
    const selected = props.selectedLogId === log.id;
    const highlighted = state.highlightedLogIds.has(log.id);
    const muted = props.activeTagIds.size === 0 && state.activeRelationMode && !selected && !highlighted;
    ctx.save();
    ctx.shadowColor = selected ? '#ffffff' : highlighted ? '#9ee7ff' : 'transparent';
    ctx.shadowBlur = selected ? 8 : highlighted ? 4 : 0;
    ctx.beginPath();
    ctx.fillStyle = selected ? '#ffffff' : highlighted ? '#9ee7ff' : muted ? 'rgba(151, 165, 182, 0.16)' : 'rgba(151, 165, 182, 0.38)';
    const logRadius = selected ? 6.4 : highlighted ? 5.6 : point.r;
    ctx.moveTo(point.x, point.y - logRadius);
    ctx.lineTo(point.x + logRadius, point.y);
    ctx.lineTo(point.x, point.y + logRadius);
    ctx.lineTo(point.x - logRadius, point.y);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = selected ? 2 / transform.scale : 1 / transform.scale;
    ctx.strokeStyle = selected ? '#55d6ff' : 'rgba(255,255,255,0.28)';
    ctx.stroke();
    ctx.restore();
    pickNodes.push({ kind: 'log', id: log.id, x: point.x, y: point.y, r: 12 });
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

function hasActiveRelationMode() {
  return props.activeTagIds.size > 0 || props.selectedLogId !== null;
}

function relationFlowState(tagId: number, log: LogEntry, state: DrawState) {
  const selected = state.selectedLogId === log.id;
  const active = props.activeTagIds.has(tagId) && state.highlightedLogIds.has(log.id);
  return {
    visible:
      (selected && state.visibleLogIds.has(log.id) && state.visibleTagIds.has(tagId)) ||
      active,
    selected
  };
}

function quadraticPoint(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number },
  t: number
) {
  const inv = 1 - t;
  return {
    x: inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x,
    y: inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y
  };
}

function onPointerDown(event: PointerEvent) {
  event.preventDefault();
  updateNebulaCursor(event);
  isDragging = true;
  dragMode = event.button === 1 ? 'pan' : null;
  if (dragMode === 'pan') {
    lastPanInteractionAt = performance.now();
  }
  dragTagId = null;
  dragLogId = null;
  moved = false;
  dragButton = event.button;
  dragSnapshot = null;
  lastPointer = { x: event.clientX, y: event.clientY };
  const picked = pickNodeAt(event.offsetX, event.offsetY);
  if (event.button === 0 && picked?.kind === 'tag') {
    dragSnapshot = captureManualPositions();
    const point = screenToWorld(event.offsetX, event.offsetY);
    dragMode = 'tag';
    dragTagId = picked.id;
    dragTagOffset = {
      x: picked.x - point.x,
      y: picked.y - point.y
    };
  } else if (event.button === 0 && picked?.kind === 'log') {
    dragSnapshot = captureManualPositions();
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
  updateNebulaCursor(event);
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
    lastPanInteractionAt = performance.now();
    transform.x += dx;
    transform.y += dy;
  }
  lastPointer = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent) {
  updateNebulaCursor(event);
  canvas.value?.releasePointerCapture(event.pointerId);
  isDragging = false;
  const mode = dragMode;
  const tagId = dragTagId;
  const logId = dragLogId;
  const button = dragButton;
  dragMode = null;
  dragTagId = null;
  dragLogId = null;
  dragButton = 0;
  if (mode === 'pan') {
    lastPanInteractionAt = performance.now();
  }
  if (mode === 'tag' && tagId !== null) {
    if (moved) {
      pushLayoutHistory(dragSnapshot);
      emit('layoutDirty', true);
      requestLayout();
      return;
    }
    emit('tagToggle', tagId);
    return;
  }
  if (mode === 'log' && logId !== null) {
    if (moved) {
      pushLayoutHistory(dragSnapshot);
      emit('layoutDirty', true);
      requestLayout();
      return;
    }
    emit('logOpen', logId);
    return;
  }
  if (moved) {
    return;
  }
  if (button !== 0 && button !== 2) {
    return;
  }
  const picked = pickNodeAt(event.offsetX, event.offsetY);
  if (!picked) {
    return;
  }
  if (button === 2) {
    if (picked.kind === 'log') {
      inspectLogAt(picked.id, event);
    } else {
      inspectTagAt(picked.id, event);
    }
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
  if (isDragging || performance.now() - lastPanInteractionAt < 220) {
    return;
  }
  const zoom = event.deltaY < 0 ? 1.08 : 0.92;
  const before = screenToWorld(event.offsetX, event.offsetY);
  transform.scale = Math.min(2.4, Math.max(0.45, transform.scale * zoom));
  const after = worldToScreen(before.x, before.y);
  transform.x += event.offsetX - after.x;
  transform.y += event.offsetY - after.y;
}

function updateNebulaCursor(event: PointerEvent) {
  pendingCursor = { x: event.offsetX, y: event.offsetY };
  if (cursorRaf) {
    return;
  }
  cursorRaf = requestAnimationFrame(() => {
    cursorRaf = 0;
    if (!pendingCursor) {
      return;
    }
    const next = pendingCursor;
    pendingCursor = null;
    const dx = next.x - nebulaCursor.x;
    const dy = next.y - nebulaCursor.y;
  if (Math.abs(dx) + Math.abs(dy) > 1) {
    nebulaCursor.angle = Math.atan2(dy, dx);
  }
    nebulaCursor.x = next.x;
    nebulaCursor.y = next.y;
    nebulaCursor.visible = true;
  });
}

function hideNebulaCursor() {
  nebulaCursor.visible = false;
}

function inspectLogAt(logId: number, event: PointerEvent) {
  const rect = canvas.value?.getBoundingClientRect();
  emit('logInspect', {
    logId,
    x: event.offsetX,
    y: event.offsetY,
    width: rect?.width ?? window.innerWidth,
    height: rect?.height ?? window.innerHeight
  });
}

function inspectTagAt(tagId: number, event: PointerEvent) {
  const rect = canvas.value?.getBoundingClientRect();
  emit('tagContext', {
    tagId,
    x: event.offsetX,
    y: event.offsetY,
    width: rect?.width ?? window.innerWidth,
    height: rect?.height ?? window.innerHeight
  });
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

function focusLog(logId: number) {
  if (!canvas.value) {
    return null;
  }
  const point = logPositions.get(logId);
  if (!point) {
    requestLayout();
    return null;
  }
  const rect = canvas.value.getBoundingClientRect();
  transform.scale = Math.max(transform.scale, 1.12);
  transform.x = rect.width / 2 - point.x * transform.scale;
  transform.y = rect.height / 2 - point.y * transform.scale;
  draw();
  return {
    logId,
    x: rect.width / 2,
    y: rect.height / 2,
    width: rect.width,
    height: rect.height
  };
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
  return `nebula.tagPositions.${props.graph.map.id}.${props.layoutMode}`;
}

function logPositionStorageKey() {
  return `nebula.logPositions.${props.graph.map.id}.${props.layoutMode}`;
}

function loadManualPositions() {
  manualTagPositions.clear();
  manualLogPositions.clear();
  layoutHistory.length = 0;
  redoHistory.length = 0;
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

function saveLayout() {
  if (manualTagPositions.size === 0 && manualLogPositions.size === 0) {
    return false;
  }
  saveManualPositions();
  emit('layoutDirty', false);
  return true;
}

function undoLayout() {
  const snapshot = layoutHistory.pop();
  if (!snapshot) {
    return false;
  }
  pushRedoHistory(captureManualPositions());
  restoreManualPositions(snapshot);
  requestLayout();
  draw();
  return true;
}

function redoLayout() {
  const snapshot = redoHistory.pop();
  if (!snapshot) {
    return false;
  }
  pushLayoutHistory(captureManualPositions(), false);
  restoreManualPositions(snapshot);
  requestLayout();
  draw();
  return true;
}

function captureManualPositions(): LayoutSnapshot {
  return {
    tags: [...manualTagPositions.entries()].map(([id, point]) => [id, { ...point }]),
    logs: [...manualLogPositions.entries()].map(([id, point]) => [id, { ...point }])
  };
}

function restoreManualPositions(snapshot: LayoutSnapshot) {
  manualTagPositions.clear();
  manualLogPositions.clear();
  for (const [id, point] of snapshot.tags) {
    manualTagPositions.set(id, { ...point });
  }
  for (const [id, point] of snapshot.logs) {
    manualLogPositions.set(id, { ...point });
  }
}

function pushLayoutHistory(snapshot: LayoutSnapshot | null, clearRedo = true) {
  if (!snapshot) {
    return;
  }
  layoutHistory.push(snapshot);
  if (layoutHistory.length > 30) {
    layoutHistory.shift();
  }
  if (clearRedo) {
    redoHistory.length = 0;
  }
}

function pushRedoHistory(snapshot: LayoutSnapshot) {
  redoHistory.push(snapshot);
  if (redoHistory.length > 30) {
    redoHistory.shift();
  }
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
  pushLayoutHistory(captureManualPositions());
  manualTagPositions.clear();
  manualLogPositions.clear();
  window.localStorage.removeItem(tagPositionStorageKey());
  window.localStorage.removeItem(logPositionStorageKey());
  emit('layoutDirty', false);
  requestLayout();
}

function refreshLayout() {
  requestLayout();
  draw();
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

function hexToRgba(hex: string, alpha: number) {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function seeded(input: number) {
  const x = Math.sin(input * 999.91) * 10000;
  return x - Math.floor(x);
}
</script>

<template>
  <div class="canvas-wrap nebula-interactive-surface">
    <canvas
      ref="canvas"
      class="nebula-canvas"
      @pointerenter="updateNebulaCursor"
      @pointerleave="hideNebulaCursor"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @contextmenu.prevent
      @wheel="onWheel"
    ></canvas>
    <div
      class="nebula-star-cursor"
      :class="{ visible: nebulaCursor.visible }"
      :style="{ transform: `translate(${nebulaCursor.x}px, ${nebulaCursor.y}px) rotate(${nebulaCursor.angle}rad)` }"
    ></div>
    <slot name="overlay"></slot>
  </div>
</template>
