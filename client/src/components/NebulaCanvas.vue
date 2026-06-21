<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { DomainCategory, GraphData, LayoutMode, LogEntry, TagNode } from '../types/domain';
import { buildLogClusters, shouldClusterLogs, type ClusterPoint } from '../utils/logClusters';

type PickNode =
  | { kind: 'tag'; id: number; x: number; y: number; r: number }
  | { kind: 'log'; id: number; x: number; y: number; r: number }
  | { kind: 'cluster'; id: string; x: number; y: number; r: number; logIds: number[] };

type LayoutPoint = { x: number; y: number; r: number };
type LayoutSnapshot = {
  tags: Array<[number, { x: number; y: number }]>;
  logs: Array<[number, { x: number; y: number }]>;
};
type CompleteLayoutCache = {
  signature: string;
  tags: Record<string, LayoutPoint>;
  logs: Record<string, LayoutPoint>;
  manualTags: Record<string, { x: number; y: number }>;
  manualLogs: Record<string, { x: number; y: number }>;
  view?: { scale: number; x: number; y: number };
};
type LayoutRequestOptions = { fitAll?: boolean; preferCache?: boolean };

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
  clusters: ClusterPoint[];
  clusteredLogIds: Set<number>;
};

const props = defineProps<{
  graph: GraphData;
  layoutMode: LayoutMode;
  activeTagIds: Set<number>;
  selectedLogId: number | null;
  focusPulseLogId?: number | null;
  priorityTagIds?: number[];
  priorityDisplayLimit?: number;
  logClusteringEnabled?: boolean;
  activeClusterLogIds?: Set<number> | null;
  domainFocusTagIds?: Set<number>;
}>();

const emit = defineEmits<{
  tagToggle: [tagId: number];
  tagContext: [payload: { tagId: number; x: number; y: number; width: number; height: number }];
  logOpen: [logId: number];
  logInspect: [payload: { logId: number; x: number; y: number; width: number; height: number }];
  logClusterOpen: [payload: { logIds: number[]; x: number; y: number; width: number; height: number }];
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
let pendingFocusLogId: number | null = null;
let pendingFocusCategory: DomainCategory | null = null;
let pendingFitAllTags = true;
let dragSnapshot: LayoutSnapshot | null = null;
let lastPanInteractionAt = 0;
const layoutHistory: LayoutSnapshot[] = [];
const redoHistory: LayoutSnapshot[] = [];
const MIN_VIEW_SCALE = 0.16;
const priorityRankByTagId = computed(() => new Map((props.priorityTagIds ?? []).map((id, index) => [id, index])));

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

  if (pendingFocusLogId !== null) {
    const logId = pendingFocusLogId;
    pendingFocusLogId = null;
    pendingFitAllTags = false;
    focusLog(logId);
  } else if (pendingFocusTagId !== null) {
    const tagId = pendingFocusTagId;
    pendingFocusTagId = null;
    pendingFitAllTags = false;
    centerTag(tagId);
  } else if (pendingFocusCategory) {
    const category = pendingFocusCategory;
    pendingFocusCategory = null;
    pendingFitAllTags = false;
    focusDomainCategory(category);
  } else if (pendingFitAllTags && fitAllTags(false)) {
    pendingFitAllTags = false;
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
  requestLayout({ fitAll: true, preferCache: true });
});

onBeforeUnmount(() => {
  saveCompleteLayout();
  window.removeEventListener('resize', resize);
  cancelAnimationFrame(raf);
  cancelAnimationFrame(cursorRaf);
  layoutWorker.terminate();
});

watch(
  () => [props.graph.map.id, props.layoutMode],
  () => {
    loadManualPositions();
    requestLayout({ fitAll: true, preferCache: true });
  },
  { immediate: true }
);

watch(
  () => [props.graph.tags, props.graph.logs, props.graph.tagSimilarities, props.graph.tagGroups, props.layoutMode],
  () => requestLayout({ fitAll: true, preferCache: true }),
  { deep: true }
);

watch(
  () => [
    props.activeTagIds,
    props.selectedLogId,
    props.focusPulseLogId,
    props.priorityTagIds,
    props.priorityDisplayLimit,
    props.logClusteringEnabled,
    props.activeClusterLogIds,
    props.domainFocusTagIds
  ],
  () => draw(),
  { deep: true }
);

defineExpose({
  focusTag,
  focusLog,
  focusDomainCategory,
  fitAllTags,
  resetTagLayout,
  refreshLayout,
  saveLayout,
  saveCompleteLayout,
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
  if (pendingFitAllTags && tagPositions.size > 0 && fitAllTags(false)) {
    pendingFitAllTags = false;
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

function requestLayout(options: LayoutRequestOptions = {}) {
  if (options.fitAll) {
    pendingFitAllTags = true;
  }
  if (options.preferCache && restoreCompleteLayout(options)) {
    return;
  }
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
  drawHud(rect.width, rect.height, state);
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
  } else {
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
  }

  const clusterState = computeCanvasClusters(visibleLogIds);

  return {
    logsById,
    tagsById,
    selectedLogId: props.selectedLogId,
    activeRelationMode,
    highlightedLogIds,
    visibleLogIds,
    visibleTagIds,
    selectedLogTagIds,
    relatedTagIds,
    clusters: clusterState.clusters,
    clusteredLogIds: clusterState.clusteredLogIds
  };
}

function computeCanvasClusters(visibleLogIds: Set<number>) {
  const visibleLogs = props.graph.logs.filter((log) => visibleLogIds.has(log.id) && logPositions.has(log.id));
  if (!shouldClusterLogs(visibleLogs.length, transform.scale, props.logClusteringEnabled !== false)) {
    return { clusters: [] as ClusterPoint[], clusteredLogIds: new Set<number>() };
  }
  const clusterState = buildLogClusters(visibleLogs, logPositions, tagPositions, {
    selectedLogId: props.selectedLogId,
    focusPulseLogId: props.focusPulseLogId ?? null,
    activeTagIds: props.activeTagIds,
    expandedLogIds: props.activeClusterLogIds
  });
  const clusteredLogIds = new Set<number>();
  for (const cluster of clusterState.clusters) {
    for (const logId of cluster.logIds) {
      clusteredLogIds.add(logId);
    }
  }
  for (const logId of clusterState.singleLogIds) {
    clusteredLogIds.delete(logId);
  }
  return { clusters: clusterState.clusters, clusteredLogIds };
}

function drawBackground(width: number, height: number) {
  if (!ctx) {
    return;
  }
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, themeColor('--canvas-bg', '#08111f'));
  gradient.addColorStop(0.48, themeColor('--page-bg-b', '#101927'));
  gradient.addColorStop(1, themeColor('--page-bg-c', '#061318'));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const parallax = 0.42;
  const bgScale = Math.max(0.28, Math.pow(transform.scale, 0.62));
  const offsetX = (transform.x - width / 2) * parallax;
  const offsetY = (transform.y - height / 2) * parallax;
  const wrapWidth = width + 260;
  const wrapHeight = height + 260;

  const glowPoints = [
    { seed: 31, radius: 210, color: colorWithAlpha(themeColor('--accent-primary', '#62d6ff'), 0.08) },
    { seed: 63, radius: 260, color: colorWithAlpha(themeColor('--accent-secondary', '#6f8ed8'), 0.06) },
    { seed: 97, radius: 180, color: colorWithAlpha(themeColor('--warning', '#f7d774'), 0.045) }
  ];

  for (const glow of glowPoints) {
    const baseX = (seeded(glow.seed) - 0.5) * width * 1.8;
    const baseY = (seeded(glow.seed + 17) - 0.5) * height * 1.7;
    const x = width / 2 + baseX * bgScale + offsetX;
    const y = height / 2 + baseY * bgScale + offsetY;
    const radius = glow.radius * bgScale;
    const radial = ctx.createRadialGradient(x, y, 0, x, y, radius);
    radial.addColorStop(0, glow.color);
    radial.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, width, height);
  }

  for (let i = 0; i < 150; i += 1) {
    const baseX = (seeded(i + 11) - 0.5) * width * 2.2;
    const baseY = (seeded(i + 97) - 0.5) * height * 2.2;
    const drift = frame * 0.018 * (i % 3);
    const x = wrapScreenPoint(width / 2 + baseX * bgScale + offsetX + drift, wrapWidth) - 130;
    const y = wrapScreenPoint(height / 2 + baseY * bgScale + offsetY, wrapHeight) - 130;
    const alpha = 0.18 + seeded(i + 177) * 0.36;
    const size = Math.max(0.7, (0.8 + seeded(i + 233) * 1.3) * Math.min(1.35, bgScale));
    ctx.fillStyle = `rgba(210, 235, 255, ${alpha})`;
    ctx.fillRect(x, y, size, size);
  }
}

function wrapScreenPoint(value: number, span: number) {
  return ((value % span) + span) % span;
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
    if (
      state.clusteredLogIds.has(logEntry.id) &&
      props.selectedLogId !== logEntry.id &&
      props.focusPulseLogId !== logEntry.id
    ) {
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
    const logToTag = relation.direction === 'log-to-tag';
    const alpha = logToTag ? 0.24 : relation.selected ? 0.18 : 0.12;

    ctx.beginPath();
    ctx.moveTo(tag.x, tag.y);
    ctx.quadraticCurveTo(control.x, control.y, log.x, log.y);
    ctx.strokeStyle = hexToRgba(tagEntry.color, alpha);
    ctx.lineWidth = (logToTag ? 6.8 : relation.selected ? 7 : 4.5) / transform.scale;
    ctx.shadowColor = tagEntry.color;
    ctx.shadowBlur = (logToTag ? 11 : relation.selected ? 9 : 4) / transform.scale;
    ctx.lineCap = 'round';
    if (logToTag) {
      ctx.setLineDash([10 / transform.scale, 8 / transform.scale]);
      ctx.lineDashOffset = -(frame * 0.22 + phase * 24) / transform.scale;
    } else {
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (logToTag) {
      drawRelationDiamond(log.x, log.y, tagEntry.color, 5.4 / transform.scale);
      drawRelationRing(tag.x, tag.y, tagEntry.color, 9 / transform.scale);
    } else {
      drawRelationSourceDot(tag.x, tag.y, tagEntry.color, 4.8 / transform.scale);
    }

    const particleCount = logToTag || relation.selected ? 4 : 2;
    for (let index = 0; index < particleCount; index += 1) {
      const flowT = (frame * 0.018 + phase + index / particleCount) % 1;
      const t = logToTag ? 1 - flowT : flowT;
      const point = quadraticPoint(tag, control, log, t);
      const pulse = 0.65 + Math.sin((t + phase) * Math.PI * 2) * 0.25;
      if (logToTag) {
        const tangent = quadraticTangent(tag, control, log, t);
        drawRelationArrowParticle(point, { x: -tangent.x, y: -tangent.y }, tagEntry.color, pulse);
      } else {
        ctx.beginPath();
        ctx.fillStyle = hexToRgba(tagEntry.color, (relation.selected ? 0.72 : 0.48) * pulse);
        ctx.shadowBlur = 3 / transform.scale;
        ctx.arc(point.x, point.y, (1.7 + pulse * 1.4) / transform.scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawRelationSourceDot(x: number, y: number, color: string, radius: number) {
  if (!ctx) return;
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = hexToRgba(color, 0.86);
  ctx.shadowColor = color;
  ctx.shadowBlur = radius * 2.4;
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawRelationRing(x: number, y: number, color: string, radius: number) {
  if (!ctx) return;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = hexToRgba(color, 0.62);
  ctx.lineWidth = Math.max(1, radius * 0.16);
  ctx.shadowColor = color;
  ctx.shadowBlur = radius * 1.8;
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawRelationDiamond(x: number, y: number, color: string, radius: number) {
  if (!ctx) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = hexToRgba(color, 0.8);
  ctx.strokeStyle = hexToRgba('#ffffff', 0.34);
  ctx.lineWidth = Math.max(0.8, radius * 0.18);
  ctx.shadowColor = color;
  ctx.shadowBlur = radius * 2.2;
  ctx.beginPath();
  ctx.rect(-radius, -radius, radius * 2, radius * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawRelationArrowParticle(
  point: { x: number; y: number },
  tangent: { x: number; y: number },
  color: string,
  pulse: number
) {
  if (!ctx) return;
  const angle = Math.atan2(tangent.y, tangent.x);
  const size = (4.2 + pulse * 1.8) / transform.scale;
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);
  ctx.fillStyle = hexToRgba(color, 0.82 * pulse);
  ctx.shadowColor = color;
  ctx.shadowBlur = 5 / transform.scale;
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.72, -size * 0.52);
  ctx.lineTo(-size * 0.42, 0);
  ctx.lineTo(-size * 0.72, size * 0.52);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawTags(state: DrawState) {
  if (!ctx) {
    return;
  }
  const labelBoxes: Array<{ x: number; y: number; w: number; h: number; required: boolean }> = [];
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
    const domainFocused = props.domainFocusTagIds?.has(tag.id) ?? false;
    const related = !state.activeRelationMode || active || relatedToSelected || state.relatedTagIds.has(tag.id);
    const priorityRank = tagPriorityRank(tag.id);
    const priorityActive = hasTagPriority() && shouldShowPriorityBadge(priorityRank);
    const priorityLevel = priorityActive ? tagPriority(tag.id) : 0;
    const glow = active || relatedToSelected ? 16 : domainFocused ? 14 : priorityActive ? 10 + priorityLevel * 8 : related ? 7 : 0;
    ctx.save();
    ctx.shadowColor = tag.color;
    ctx.shadowBlur = glow;
    ctx.beginPath();
    ctx.fillStyle = active || relatedToSelected ? tag.color : related ? `${tag.color}dd` : `${tag.color}55`;
    const visualRadius = point.r * (active || relatedToSelected ? 1.12 : 1) * (priorityActive ? 1 + priorityLevel * 0.16 : 1);
    ctx.arc(point.x, point.y, visualRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = active || relatedToSelected ? 3 / transform.scale : 1.4 / transform.scale;
    ctx.strokeStyle = active || relatedToSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.55)';
    ctx.stroke();

    if (priorityActive) {
      const pulse = 0.5 + 0.5 * Math.sin(frame * 0.038 + tag.id);
      ctx.beginPath();
      ctx.shadowBlur = (8 + priorityLevel * 8) / transform.scale;
      ctx.strokeStyle = hexToRgba(tag.color, 0.24 + priorityLevel * 0.16 + pulse * 0.08);
      ctx.lineWidth = (1.5 + priorityLevel * 1.2) / transform.scale;
      ctx.arc(point.x, point.y, visualRadius * (1.75 + priorityLevel * 0.22 + pulse * 0.1), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (domainFocused) {
      const pulse = 0.5 + 0.5 * Math.sin(frame * 0.05 + tag.id);
      ctx.beginPath();
      ctx.shadowBlur = 10 / transform.scale;
      ctx.strokeStyle = hexToRgba(tag.color, 0.34 + pulse * 0.16);
      ctx.lineWidth = 2.4 / transform.scale;
      ctx.arc(point.x, point.y, visualRadius * (2.05 + pulse * 0.18), 0, Math.PI * 2);
      ctx.stroke();
    }

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

    ctx.fillStyle = active || relatedToSelected || domainFocused ? '#ffffff' : related ? 'rgba(232, 243, 255, 0.86)' : 'rgba(232, 243, 255, 0.42)';
    ctx.font = `${Math.max(12, 14 / transform.scale)}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    const labelY = point.y + visualRadius + 18 / transform.scale;
    if (shouldDrawTagLabel(tag.name, point.x, labelY, active || relatedToSelected || domainFocused || shouldShowPriorityBadge(priorityRank))) {
      ctx.fillText(tag.name, point.x, labelY);
    }
    if (priorityRank !== null && priorityActive && shouldShowPriorityBadge(priorityRank, active || relatedToSelected || domainFocused)) {
      const badgeText = `#${priorityRank + 1}`;
      const badgeX = point.x + visualRadius * 0.72;
      const badgeY = point.y - visualRadius * 0.72;
      const badgeR = Math.max(8, 10 / transform.scale);
      ctx.save();
      ctx.shadowColor = tag.color;
      ctx.shadowBlur = 8 / transform.scale;
      ctx.fillStyle = 'rgba(3, 12, 22, 0.82)';
      ctx.strokeStyle = hexToRgba(tag.color, 0.72);
      ctx.lineWidth = 1.2 / transform.scale;
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#eef6ff';
      ctx.font = `${Math.max(9, 10 / transform.scale)}px "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, badgeX, badgeY);
      ctx.restore();
    }
    pickNodes.push({ kind: 'tag', id: tag.id, x: point.x, y: point.y, r: visualRadius + 10 });
  }

  function shouldDrawTagLabel(name: string, x: number, y: number, required: boolean) {
    const width = Math.max(42, name.length * Math.max(10, 12 / transform.scale));
    const height = Math.max(18, 18 / transform.scale);
    const box = { x: x - width / 2, y: y - height + 4 / transform.scale, w: width, h: height, required };
    const overlapped = labelBoxes.some((item) => boxesOverlap(box, item));
    if (overlapped && !required && hasTagPriority()) {
      return false;
    }
    labelBoxes.push(box);
    return true;
  }
}

function drawLogs(state: DrawState) {
  if (!ctx) {
    return;
  }
  drawLogClusters(state);
  for (const log of props.graph.logs) {
    const point = logPositions.get(log.id);
    if (!point) {
      continue;
    }
    if (!state.visibleLogIds.has(log.id)) {
      continue;
    }
    const selected = props.selectedLogId === log.id;
    const pulsing = props.focusPulseLogId === log.id;
    const highlighted = state.highlightedLogIds.has(log.id);
    if (state.clusteredLogIds.has(log.id) && !selected && !pulsing && !highlighted) {
      continue;
    }
    const muted = props.activeTagIds.size === 0 && state.activeRelationMode && !selected && !highlighted;
    ctx.save();
    ctx.shadowColor = selected || pulsing ? '#ffffff' : highlighted ? '#9ee7ff' : 'transparent';
    ctx.shadowBlur = selected ? 8 : pulsing ? 13 : highlighted ? 4 : 0;
    ctx.beginPath();
    ctx.fillStyle = selected || pulsing ? '#ffffff' : highlighted ? '#9ee7ff' : muted ? 'rgba(151, 165, 182, 0.16)' : 'rgba(151, 165, 182, 0.38)';
    const pulse = pulsing ? 0.5 + 0.5 * Math.sin(frame * 0.12) : 0;
    const logRadius = selected ? 6.4 : pulsing ? 6.2 + pulse * 1.8 : highlighted ? 5.6 : point.r;
    ctx.moveTo(point.x, point.y - logRadius);
    ctx.lineTo(point.x + logRadius, point.y);
    ctx.lineTo(point.x, point.y + logRadius);
    ctx.lineTo(point.x - logRadius, point.y);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = selected || pulsing ? 2 / transform.scale : 1 / transform.scale;
    ctx.strokeStyle = selected || pulsing ? themeColor('--accent-primary', '#55d6ff') : 'rgba(255,255,255,0.28)';
    ctx.stroke();
    if (pulsing) {
      ctx.beginPath();
      ctx.shadowBlur = 10 / transform.scale;
      ctx.strokeStyle = colorWithAlpha(themeColor('--accent-primary', '#62d6ff'), 0.58);
      ctx.lineWidth = 1.4 / transform.scale;
      ctx.arc(point.x, point.y, logRadius * (2.1 + pulse * 0.35), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    pickNodes.push({ kind: 'log', id: log.id, x: point.x, y: point.y, r: 12 });
  }
}

function drawLogClusters(state: DrawState) {
  if (!ctx || state.clusters.length === 0) {
    return;
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const cluster of state.clusters) {
    const color = clusterColor(cluster, state);
    const active = cluster.logIds.some((id) => props.activeClusterLogIds?.has(id));
    const child = cluster.level === 'child';
    const pulse = active ? 0.5 + 0.5 * Math.sin(frame * 0.05) : 0;
    const radius = cluster.r * (child ? 0.9 : 1) * (active ? 1.12 + pulse * 0.04 : 1);
    const cloudRadius = radius * (child ? 1.78 : 2.28);
    const seed = seeded(cluster.count * 37 + cluster.x * 0.11 + cluster.y * 0.17);
    ctx.save();
    ctx.translate(cluster.x, cluster.y);
    ctx.shadowColor = color;
    ctx.shadowBlur = (active ? 24 : child ? 14 : 17) / transform.scale;

    const haze = ctx.createRadialGradient(0, 0, radius * 0.18, 0, 0, cloudRadius);
    haze.addColorStop(0, hexToRgba(color, active ? 0.32 : 0.2));
    haze.addColorStop(0.48, hexToRgba(color, active ? 0.16 : 0.1));
    haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.beginPath();
    ctx.fillStyle = haze;
    ctx.arc(0, 0, cloudRadius, 0, Math.PI * 2);
    ctx.fill();

    const ringCount = child ? 1 : cluster.count > 28 ? 3 : 2;
    for (let ring = 0; ring < ringCount; ring += 1) {
      const ringRadius = radius * (1.1 + ring * 0.36 + pulse * 0.08);
      ctx.save();
      ctx.rotate(seed * Math.PI + ring * 0.72 + frame * (active ? 0.0022 : 0.0011));
      ctx.beginPath();
      ctx.strokeStyle = hexToRgba(color, active ? 0.38 - ring * 0.06 : 0.22 - ring * 0.04);
      ctx.lineWidth = (active ? 1.35 : 0.9) / transform.scale;
      ctx.ellipse(0, 0, ringRadius * (1.18 + ring * 0.08), ringRadius * (0.55 + ring * 0.04), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const dustCount = Math.min(child ? 7 : 10, Math.max(4, Math.round(Math.log2(cluster.count + 2) * 1.7)));
    for (let index = 0; index < dustCount; index += 1) {
      const angle = seeded(cluster.count * 53 + index * 19 + cluster.x) * Math.PI * 2 + frame * 0.003;
      const distance = radius * (1.12 + seeded(cluster.y + index * 31) * (child ? 0.86 : 1.28));
      const dotRadius = (1.05 + seeded(index + cluster.count) * 1.3) / transform.scale;
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(index % 3 === 0 ? '#ffffff' : color, active ? 0.72 : 0.48);
      ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance * 0.72, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.fillStyle = hexToRgba(color, active ? 0.72 : child ? 0.58 : 0.52);
    ctx.strokeStyle = active ? '#ffffff' : hexToRgba(color, child ? 0.72 : 0.58);
    ctx.lineWidth = (active ? 2.2 : 1.4) / transform.scale;
    ctx.arc(0, 0, radius * (child ? 0.58 : 0.68), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (active || child) {
      const label = `${cluster.count}条`;
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `700 ${Math.max(10, 11 / transform.scale)}px "Microsoft YaHei", sans-serif`;
      const labelWidth = ctx.measureText(label).width + 14 / transform.scale;
      const labelHeight = 18 / transform.scale;
      const labelX = radius * 0.86;
      const labelY = -radius * 1.08;
      ctx.fillStyle = 'rgba(5, 13, 24, 0.78)';
      ctx.strokeStyle = hexToRgba(color, 0.46);
      ctx.lineWidth = 1 / transform.scale;
      roundRect(ctx, labelX, labelY, labelWidth, labelHeight, 9 / transform.scale);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(241, 249, 255, 0.88)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, labelX + labelWidth / 2, labelY + labelHeight / 2);
    }
    ctx.restore();
    pickNodes.push({ kind: 'cluster', id: cluster.id, x: cluster.x, y: cluster.y, r: cloudRadius + 10 / transform.scale, logIds: cluster.logIds });
  }
  ctx.restore();
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function clusterColor(cluster: ClusterPoint, state: DrawState) {
  const tagColor = cluster.primaryTagId ? state.tagsById.get(cluster.primaryTagId)?.color : null;
  if (tagColor) {
    return tagColor;
  }
  const log = cluster.logIds.map((id) => state.logsById.get(id)).find(Boolean);
  return log?.tags[0]?.color ?? themeColor('--accent-primary', '#62d6ff');
}

function drawHud(width: number, height: number, state: DrawState) {
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
  if (state.activeRelationMode && width > 560) {
    drawRelationLegend(context);
  }
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
  const visible =
    (selected && state.visibleLogIds.has(log.id) && state.visibleTagIds.has(tagId)) ||
    active;
  return {
    visible,
    selected,
    direction: selected ? 'log-to-tag' : 'tag-to-log'
  };
}

function drawRelationLegend(context: CanvasRenderingContext2D) {
  const x = 18;
  const y = 18;
  const width = 242;
  const height = 58;
  const accent = themeColor('--accent-primary', '#62d6ff');
  context.save();
  context.globalCompositeOperation = 'source-over';
  roundRect(context, x, y, width, height, 12);
  context.fillStyle = colorWithAlpha(themeColor('--panel-bg-strong', '#071421'), 0.76);
  context.strokeStyle = colorWithAlpha(themeColor('--panel-border', 'rgba(238, 246, 255, 0.14)'), 0.92);
  context.lineWidth = 1;
  context.fill();
  context.stroke();

  context.font = '11px "Microsoft YaHei", sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillStyle = colorWithAlpha(themeColor('--text-muted', '#9fb3c8'), 0.88);

  drawLegendSolidLine(context, x + 14, y + 20, accent);
  context.fillText('实线：标签 → 日志', x + 62, y + 20);
  drawLegendDashedLine(context, x + 14, y + 40, accent);
  context.fillText('分段线：日志 → 标签', x + 62, y + 40);
  context.restore();
}

function themeColor(name: string, fallback: string) {
  const target = canvas.value;
  if (!target) {
    return fallback;
  }
  return getComputedStyle(target).getPropertyValue(name).trim() || fallback;
}

function colorWithAlpha(color: string, alpha: number) {
  const normalized = color.trim();
  if (normalized.startsWith('#')) {
    return hexToRgba(normalized, alpha);
  }
  const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((part) => part.trim());
    if (parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
  }
  return normalized;
}

function drawLegendSolidLine(context: CanvasRenderingContext2D, x: number, y: number, color: string) {
  context.save();
  context.strokeStyle = hexToRgba(color, 0.62);
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + 36, y);
  context.stroke();
  context.fillStyle = hexToRgba(color, 0.86);
  context.beginPath();
  context.arc(x, y, 3.5, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawLegendDashedLine(context: CanvasRenderingContext2D, x: number, y: number, color: string) {
  context.save();
  context.strokeStyle = hexToRgba(color, 0.7);
  context.lineWidth = 2;
  context.setLineDash([7, 5]);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + 36, y);
  context.stroke();
  context.setLineDash([]);
  context.translate(x + 2, y);
  context.rotate(Math.PI / 4);
  context.fillStyle = hexToRgba(color, 0.82);
  context.fillRect(-3, -3, 6, 6);
  context.restore();
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
  if (picked.kind === 'cluster') {
    openLogCluster(picked, event);
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

function quadraticTangent(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number },
  t: number
) {
  const inv = 1 - t;
  const dx = 2 * inv * (control.x - start.x) + 2 * t * (end.x - control.x);
  const dy = 2 * inv * (control.y - start.y) + 2 * t * (end.y - control.y);
  const length = Math.max(0.001, Math.hypot(dx, dy));
  return { x: dx / length, y: dy / length };
}

function openLogCluster(cluster: Extract<PickNode, { kind: 'cluster' }>, event: PointerEvent) {
  const rect = canvas.value?.getBoundingClientRect();
  emit('logClusterOpen', {
    logIds: cluster.logIds,
    x: event.offsetX,
    y: event.offsetY,
    width: rect?.width ?? window.innerWidth,
    height: rect?.height ?? window.innerHeight
  });
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  if (isDragging || performance.now() - lastPanInteractionAt < 220) {
    return;
  }
  const zoom = event.deltaY < 0 ? 1.08 : 0.92;
  const before = screenToWorld(event.offsetX, event.offsetY);
  transform.scale = Math.min(2.4, Math.max(MIN_VIEW_SCALE, transform.scale * zoom));
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
    pendingFocusLogId = logId;
    return null;
  }
  const point = logPositions.get(logId);
  if (!point) {
    pendingFocusLogId = logId;
    requestLayout();
    return null;
  }
  pendingFocusLogId = null;
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

function focusDomainCategory(category: DomainCategory) {
  if (!canvas.value) {
    pendingFocusCategory = category;
    return false;
  }
  if (layoutBusy.value) {
    pendingFocusCategory = category;
    pendingFitAllTags = false;
    return true;
  }
  const tagIds = resolveCategoryTagIds(category);
  if (tagIds.length === 0) {
    if (tagPositions.size === 0) {
      pendingFocusCategory = category;
      requestLayout();
      return true;
    }
    return false;
  }
  return fitTagBounds(tagIds, { margin: 92, minScale: 0.26, maxScale: 1.18 });
}

function fitAllTags(drawNow = true) {
  return fitTagBounds(
    props.graph.tags.map((tag) => tag.id),
    { margin: 54, minScale: MIN_VIEW_SCALE, maxScale: 1.08, drawNow }
  );
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

function fitTagBounds(
  tagIds: number[],
  options: { margin?: number; minScale?: number; maxScale?: number; drawNow?: boolean } = {}
) {
  if (!canvas.value || tagIds.length === 0) {
    return false;
  }
  const rect = canvas.value.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const idSet = new Set(tagIds);
  const points = props.graph.tags
    .filter((tag) => idSet.has(tag.id))
    .map((tag) => {
      const point = tagPositions.get(tag.id);
      return point ? { tag, point } : null;
    })
    .filter((item): item is { tag: TagNode; point: LayoutPoint } => Boolean(item));

  if (points.length === 0) {
    return false;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { tag, point } of points) {
    const labelPadding = Math.max(96, tag.name.length * 18);
    minX = Math.min(minX, point.x - point.r - labelPadding);
    maxX = Math.max(maxX, point.x + point.r + labelPadding);
    minY = Math.min(minY, point.y - point.r - 78);
    maxY = Math.max(maxY, point.y + point.r + 118);
  }

  const margin = options.margin ?? 56;
  const usableWidth = Math.max(120, rect.width - margin * 2);
  const usableHeight = Math.max(120, rect.height - margin * 2);
  const boundsWidth = Math.max(1, maxX - minX);
  const boundsHeight = Math.max(1, maxY - minY);
  const nextScale = Math.min(
    options.maxScale ?? 1.08,
    Math.max(options.minScale ?? MIN_VIEW_SCALE, Math.min(usableWidth / boundsWidth, usableHeight / boundsHeight))
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  transform.scale = nextScale;
  transform.x = rect.width / 2 - centerX * nextScale;
  transform.y = rect.height / 2 - centerY * nextScale;
  if (options.drawNow ?? true) {
    draw();
  }
  return true;
}

function resolveCategoryTagIds(category: DomainCategory) {
  const cleanName = normalizeText(category.name);
  const matchingGroup = props.graph.tagGroups.find((group) => normalizeText(group.name) === cleanName);
  if (matchingGroup?.tagIds.length) {
    return matchingGroup.tagIds.filter((id) => tagPositions.has(id));
  }

  const keywords = [category.name, ...(category.keywords ?? [])].map(normalizeText).filter(Boolean);
  if (keywords.length === 0) {
    return [];
  }
  return props.graph.tags
    .filter((tag) => {
      const name = normalizeText(tag.name);
      return keywords.some((keyword) => name.includes(keyword) || keyword.includes(name));
    })
    .map((tag) => tag.id)
    .filter((id) => tagPositions.has(id));
}

function normalizeText(value: string) {
  return String(value ?? '').trim().toLowerCase();
}

function hasTagPriority() {
  return (props.priorityTagIds?.length ?? 0) > 1;
}

function tagPriorityRank(tagId: number) {
  return priorityRankByTagId.value.get(tagId) ?? null;
}

function tagPriority(tagId: number) {
  const total = props.priorityTagIds?.length ?? 0;
  if (total <= 1) return 0.5;
  const rank = tagPriorityRank(tagId);
  if (rank === null) return 0;
  return 1 - rank / Math.max(1, total - 1);
}

function shouldShowPriorityBadge(rank: number | null, force = false) {
  if (rank === null) return false;
  const limit = Math.max(0, Math.round(props.priorityDisplayLimit ?? 8));
  return force || rank < limit;
}

function boxesOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
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

function completeLayoutStorageKey() {
  return `nebula.completeLayout.canvas.${props.graph.map.id}.${props.layoutMode}`;
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
  saveCompleteLayout();
  emit('layoutDirty', false);
  return true;
}

function saveCompleteLayout() {
  if (tagPositions.size === 0 && logPositions.size === 0) {
    return false;
  }
  const cache: CompleteLayoutCache = {
    signature: layoutSignature(),
    tags: pointRecord(tagPositions),
    logs: pointRecord(logPositions),
    manualTags: manualPointRecord(manualTagPositions),
    manualLogs: manualPointRecord(manualLogPositions),
    view: {
      scale: transform.scale,
      x: transform.x,
      y: transform.y
    }
  };
  window.localStorage.setItem(completeLayoutStorageKey(), JSON.stringify(cache));
  return true;
}

function restoreCompleteLayout(options: LayoutRequestOptions = {}) {
  const raw = window.localStorage.getItem(completeLayoutStorageKey());
  if (!raw) {
    return false;
  }
  try {
    const cache = JSON.parse(raw) as Partial<CompleteLayoutCache>;
    if (cache.signature !== layoutSignature()) {
      return false;
    }
    const validTagIds = new Set(props.graph.tags.map((tag) => tag.id));
    const validLogIds = new Set(props.graph.logs.map((log) => log.id));
    const restoredTags = loadLayoutPointRecord(cache.tags, validTagIds);
    const restoredLogs = loadLayoutPointRecord(cache.logs, validLogIds);
    if (restoredTags.size !== validTagIds.size || restoredLogs.size !== validLogIds.size) {
      return false;
    }

    tagPositions.clear();
    logPositions.clear();
    manualTagPositions.clear();
    manualLogPositions.clear();
    copyPointMap(restoredTags, tagPositions);
    copyPointMap(restoredLogs, logPositions);
    copyManualPointMap(loadManualPointRecord(cache.manualTags, validTagIds), manualTagPositions);
    copyManualPointMap(loadManualPointRecord(cache.manualLogs, validLogIds), manualLogPositions);

    if (
      cache.view &&
      Number.isFinite(cache.view.scale) &&
      Number.isFinite(cache.view.x) &&
      Number.isFinite(cache.view.y)
    ) {
      transform.scale = cache.view.scale;
      transform.x = cache.view.x;
      transform.y = cache.view.y;
      pendingFitAllTags = false;
    } else if (options.fitAll && fitAllTags(false)) {
      pendingFitAllTags = false;
    }
    layoutBusy.value = false;
    draw();
    return true;
  } catch {
    window.localStorage.removeItem(completeLayoutStorageKey());
    return false;
  }
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

function pointRecord(source: Map<number, LayoutPoint>) {
  return Object.fromEntries(
    [...source.entries()].map(([id, point]) => [id, { x: point.x, y: point.y, r: point.r }])
  );
}

function manualPointRecord(source: Map<number, { x: number; y: number }>) {
  return Object.fromEntries([...source.entries()].map(([id, point]) => [id, { x: point.x, y: point.y }]));
}

function loadLayoutPointRecord(
  source: CompleteLayoutCache['tags'] | undefined,
  validIds: Set<number>
) {
  const points = new Map<number, LayoutPoint>();
  if (!source) {
    return points;
  }
  for (const [id, point] of Object.entries(source)) {
    const nodeId = Number(id);
    if (
      validIds.has(nodeId) &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isFinite(point.r)
    ) {
      points.set(nodeId, { x: point.x, y: point.y, r: point.r });
    }
  }
  return points;
}

function loadManualPointRecord(
  source: CompleteLayoutCache['manualTags'] | undefined,
  validIds: Set<number>
) {
  const points = new Map<number, { x: number; y: number }>();
  if (!source) {
    return points;
  }
  for (const [id, point] of Object.entries(source)) {
    const nodeId = Number(id);
    if (validIds.has(nodeId) && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      points.set(nodeId, { x: point.x, y: point.y });
    }
  }
  return points;
}

function copyPointMap(source: Map<number, LayoutPoint>, target: Map<number, LayoutPoint>) {
  for (const [id, point] of source) {
    target.set(id, { ...point });
  }
}

function copyManualPointMap(
  source: Map<number, { x: number; y: number }>,
  target: Map<number, { x: number; y: number }>
) {
  for (const [id, point] of source) {
    target.set(id, { ...point });
  }
}

function layoutSignature() {
  return JSON.stringify({
    mapId: props.graph.map.id,
    layoutMode: props.layoutMode,
    tags: [...props.graph.tags]
      .map((tag) => [tag.id, tag.name, tag.count])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
    logs: [...props.graph.logs]
      .map((log) => [
        log.id,
        log.updatedAt,
        log.createdAt,
        log.tags.map((tag) => tag.id).sort((a, b) => a - b)
      ])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
    similarities: [...(props.graph.tagSimilarities ?? [])]
      .map((item) => [item.tagAId, item.tagBId, Number(item.score).toFixed(4)])
      .sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1])),
    groups: [...(props.graph.tagGroups ?? [])]
      .map((group) => [group.name, [...group.tagIds].sort((a, b) => a - b)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  });
}

function resetTagLayout() {
  pushLayoutHistory(captureManualPositions());
  manualTagPositions.clear();
  manualLogPositions.clear();
  window.localStorage.removeItem(tagPositionStorageKey());
  window.localStorage.removeItem(logPositionStorageKey());
  window.localStorage.removeItem(completeLayoutStorageKey());
  emit('layoutDirty', false);
  requestLayout();
}

function refreshLayout() {
  loadManualPositions();
  window.localStorage.removeItem(completeLayoutStorageKey());
  emit('layoutDirty', false);
  requestLayout({ fitAll: true });
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
