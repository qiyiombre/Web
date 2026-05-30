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

interface LabelItem {
  id: number;
  name: string;
  x: number;
  y: number;
  color: string;
  active: boolean;
  heat: 'up' | 'down' | 'flat';
}

interface VisualTag {
  id: number;
  x: number;
  y: number;
  r: number;
  color: string;
  active: boolean;
  fixed: boolean;
  heat: 'up' | 'down' | 'flat';
}

interface VisualLog {
  id: number;
  x: number;
  y: number;
  r: number;
  color: string;
  kind: 'gas' | 'rocky' | 'ice' | 'ringed' | 'lava';
  tilt: number;
  selected: boolean;
  highlighted: boolean;
  fixed: boolean;
}

interface VisualEdge {
  key: string;
  x: number;
  y: number;
  width: number;
  angle: number;
  color: string;
  active: boolean;
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
const labels = ref<LabelItem[]>([]);
const visualTags = ref<VisualTag[]>([]);
const visualLogs = ref<VisualLog[]>([]);
const visualEdges = ref<VisualEdge[]>([]);
const webgpuReady = ref(false);
const webgpuMessage = ref('正在初始化 WebGPU...');
const heatMode = ref(false);
const transform = reactive({ scale: 1, x: 0, y: 0 });

const tagPositions = new Map<number, LayoutPoint>();
const logPositions = new Map<number, LayoutPoint>();
const manualTagPositions = new Map<number, { x: number; y: number }>();
const manualLogPositions = new Map<number, { x: number; y: number }>();
const pickNodes: PickNode[] = [];
const activeIds = computed(() => [...props.activeTagIds]);
const tagTrendById = computed(() => {
  const now = Date.now();
  const week = 1000 * 60 * 60 * 24 * 7;
  const trend = new Map<number, { current: number; previous: number }>();
  for (const tag of props.graph.tags) {
    trend.set(tag.id, { current: 0, previous: 0 });
  }
  for (const log of props.graph.logs) {
    const age = now - new Date(log.createdAt).getTime();
    for (const tag of log.tags) {
      const item = trend.get(tag.id);
      if (!item) {
        continue;
      }
      if (age <= week) {
        item.current += 1;
      } else if (age <= week * 2) {
        item.previous += 1;
      }
    }
  }
  return trend;
});

let device: any = null;
let context: any = null;
let format = '';
let bindGroupLayout: any = null;
let bindGroup: any = null;
let uniformBuffer: any = null;
let quadBuffer: any = null;
let nodeInstanceBuffer: any = null;
let lineVertexBuffer: any = null;
let nodePipeline: any = null;
let linePipeline: any = null;
let nodeInstanceCapacity = 0;
let lineVertexCapacity = 0;
let starCount = 0;
let nodeCount = 0;
let lineVertexCount = 0;
let raf = 0;
let latestLayoutRequestId = 0;
let pendingFocusTagId: number | null = null;
let isDragging = false;
let dragMode: 'pan' | 'tag' | 'log' | null = null;
let dragTagId: number | null = null;
let dragLogId: number | null = null;
let dragTagOffset = { x: 0, y: 0 };
let dragLogOffset = { x: 0, y: 0 };
let moved = false;
let lastPointer = { x: 0, y: 0 };
let stars: Array<{ x: number; y: number; r: number; alpha: number; seed: number }> = [];
let cameraTarget: { scale: number; x: number; y: number } | null = null;

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
  if (pendingFocusTagId !== null) {
    const tagId = pendingFocusTagId;
    pendingFocusTagId = null;
    centerTag(tagId);
  }
  updateLabels();
};

layoutWorker.onerror = (event) => {
  webgpuMessage.value = `布局 Worker 运行失败：${event.message}`;
};

onMounted(async () => {
  await nextTick();
  resize();
  window.addEventListener('resize', resize);
  await initWebGpu();
  requestLayout();
  raf = requestAnimationFrame(render);
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
  () => {
    updateLabels();
  },
  { deep: true }
);

defineExpose({
  focusTag,
  resetTagLayout
});

async function initWebGpu() {
  const gpu = (navigator as any).gpu;
  if (!gpu) {
    webgpuReady.value = false;
    webgpuMessage.value = '当前浏览器不支持 WebGPU，请切回 Canvas 模式。';
    return;
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    webgpuReady.value = false;
    webgpuMessage.value = '没有找到可用 GPU 适配器，请切回 Canvas 模式。';
    return;
  }

  device = await adapter.requestDevice();
  device.addEventListener?.('uncapturederror', (event: any) => {
    const message = event?.error?.message ?? 'WebGPU 渲染管线出现兼容性错误';
    webgpuMessage.value = message;
    console.error('WebGPU uncaptured error:', message);
  });
  context = canvas.value?.getContext('webgpu');
  if (!context) {
    webgpuReady.value = false;
    webgpuMessage.value = 'WebGPU 上下文创建失败。';
    return;
  }

  format = gpu.getPreferredCanvasFormat();
  createResources();
  configureContext();
  webgpuReady.value = true;
  webgpuMessage.value = '';
}

function createResources() {
  const usage = (globalThis as any).GPUBufferUsage;
  uniformBuffer = device.createBuffer({
    size: 32,
    usage: usage.UNIFORM | usage.COPY_DST
  });

  bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: 3, buffer: { type: 'uniform' } }]
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  quadBuffer = device.createBuffer({
    size: 48,
    usage: usage.VERTEX | usage.COPY_DST
  });
  device.queue.writeBuffer(
    quadBuffer,
    0,
    new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1])
  );

  nodePipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: device.createShaderModule({ code: nodeShader }),
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 8,
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
        },
        {
          arrayStride: 48,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 1, offset: 0, format: 'float32x2' },
            { shaderLocation: 2, offset: 8, format: 'float32' },
            { shaderLocation: 4, offset: 12, format: 'float32' },
            { shaderLocation: 3, offset: 16, format: 'float32x4' },
            { shaderLocation: 5, offset: 32, format: 'float32' },
            { shaderLocation: 6, offset: 36, format: 'float32' }
          ]
        }
      ]
    },
    fragment: {
      module: device.createShaderModule({ code: nodeShader }),
      entryPoint: 'fs',
      targets: [blendTarget()]
    },
    primitive: { topology: 'triangle-list' }
  });

  linePipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: device.createShaderModule({ code: lineShader }),
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 48,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 2, offset: 8, format: 'float32x2' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' }
          ]
        }
      ]
    },
    fragment: {
      module: device.createShaderModule({ code: lineShader }),
      entryPoint: 'fs',
      targets: [blendTarget()]
    },
    primitive: { topology: 'triangle-list' }
  });
}

function blendTarget() {
  return {
    format,
    blend: {
      color: {
        srcFactor: 'src-alpha',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add'
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add'
      }
    },
    writeMask: 15
  };
}

function configureContext() {
  if (!context || !device) {
    return;
  }
  context.configure({
    device,
    format,
    alphaMode: 'opaque'
  });
}

function resize() {
  if (!canvas.value) {
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.value.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.value.height = Math.max(1, Math.floor(rect.height * dpr));
  canvas.value.style.width = `${rect.width}px`;
  canvas.value.style.height = `${rect.height}px`;
  if (transform.x === 0 && transform.y === 0) {
    transform.x = rect.width / 2;
    transform.y = rect.height / 2;
  }
  buildStars(rect.width, rect.height);
  configureContext();
  updateLabels();
}

function buildStars(width: number, height: number) {
  stars = Array.from({ length: 900 }, (_, index) => {
    const seed = seeded(index + 37);
    return {
      x: seeded(index + 17) * width,
      y: seeded(index + 89) * height,
      r: 0.7 + seeded(index + 144) * 2.9,
      alpha: 0.3 + seeded(index + 233) * 0.7,
      seed
    };
  });
}

function requestLayout() {
  latestLayoutRequestId += 1;
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

function render(timeMs: number) {
  raf = requestAnimationFrame(render);
  if (!webgpuReady.value || !device || !context || !canvas.value) {
    return;
  }

  const rect = canvas.value.getBoundingClientRect();
  animateCamera();
  updateGeometryBuffers();
  updateLabels();
  device.queue.writeBuffer(
    uniformBuffer,
    0,
    new Float32Array([rect.width, rect.height, transform.scale, timeMs / 1000, transform.x, transform.y, 0, 0])
  );

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.025, g: 0.055, b: 0.1, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }
    ]
  });

  pass.setBindGroup(0, bindGroup);
  if (nodeInstanceBuffer && starCount > 0) {
    pass.setPipeline(nodePipeline);
    pass.setVertexBuffer(0, quadBuffer);
    pass.setVertexBuffer(1, nodeInstanceBuffer);
    pass.draw(6, starCount, 0, 0);
  }
  if (lineVertexBuffer && lineVertexCount > 0) {
    pass.setPipeline(linePipeline);
    pass.setVertexBuffer(0, lineVertexBuffer);
    pass.draw(lineVertexCount);
  }
  if (nodeInstanceBuffer && nodeCount > 0) {
    pass.setPipeline(nodePipeline);
    pass.setVertexBuffer(0, quadBuffer);
    pass.setVertexBuffer(1, nodeInstanceBuffer);
    pass.draw(6, nodeCount, 0, starCount);
  }

  pass.end();
  device.queue.submit([encoder.finish()]);
}

function updateGeometryBuffers() {
  const nodeRows: number[] = [];
  pickNodes.length = 0;

  for (const star of stars) {
    pushNodeInstance(nodeRows, star.x, star.y, star.r, 0, { r: 0.62, g: 0.86, b: 1 }, star.alpha, 0, star.seed);
  }
  starCount = stars.length;

  for (const tag of props.graph.tags) {
    const point = tagPositions.get(tag.id);
    if (!point) {
      continue;
    }
    const heat = heatState(tag.id);
    const color = heatMode.value ? heatColor(tag.color, heat) : hexToRgb(tag.color);
    const active = props.activeTagIds.has(tag.id);
    const related =
      activeIds.value.length === 0 ||
      active ||
      props.graph.logs.some((log) => isLogHighlighted(log) && log.tags.some((item) => item.id === tag.id));
    const state = heatMode.value && heat !== 'flat' ? 1 : active ? 1 : related ? 0.62 : 0.28;
    const depth = 0.92 + seeded(tag.id + 2200) * 0.22;
    const coreRadius = point.r * 1.35 * depth;
    pushNodeInstance(nodeRows, point.x, point.y, coreRadius * 3.3, 3, color, 0.36, state, seeded(tag.id + 700));
    pushNodeInstance(nodeRows, point.x, point.y, coreRadius * 1.08, 1, color, 1, state, seeded(tag.id + 800));
    pickNodes.push({ kind: 'tag', id: tag.id, x: point.x, y: point.y, r: coreRadius + 12 });
  }

  for (const log of props.graph.logs) {
    const point = logPositions.get(log.id);
    if (!point) {
      continue;
    }
    const selected = props.selectedLogId === log.id;
    const highlighted = isLogHighlighted(log);
    const state = selected ? 1 : highlighted ? 0.82 : 0.26;
    const radius = selected ? 10.5 : highlighted ? 8.2 : 6.6;
    const logColor = logVisualRgb(log);
    pushNodeInstance(nodeRows, point.x, point.y, radius * 3.4, 3, logColor, selected ? 0.42 : 0.2, state, seeded(log.id + 1600));
    pushNodeInstance(nodeRows, point.x, point.y, radius, 2, mixColor(logColor, { r: 1, g: 1, b: 1 }, 0.2), selected ? 1 : 0.9, state, seeded(log.id + 1900));
    pickNodes.push({ kind: 'log', id: log.id, x: point.x, y: point.y, r: radius + 10 });
  }
  nodeCount = Math.max(0, nodeRows.length / 12 - starCount);
  writeDynamicBuffer('node', new Float32Array(nodeRows), 48);

  const lineRows: number[] = [];
  for (const edge of props.graph.edges) {
    const tag = tagPositions.get(edge.tagId);
    const log = logPositions.get(edge.logId);
    const logEntry = props.graph.logs.find((item) => item.id === edge.logId);
    if (!tag || !log || !logEntry) {
      continue;
    }
    const selected = props.selectedLogId === edge.logId;
    const highlighted = selected || isLogHighlighted(logEntry);
    const color = highlighted ? [0.42, 0.9, 1, 0.82] : [0.24, 0.62, 0.92, 0.24];
    pushLineQuad(lineRows, tag, log, highlighted ? 3.2 / transform.scale : 1.15 / transform.scale, color, highlighted ? 1 : 0.18);
  }
  lineVertexCount = lineRows.length / 12;
  writeDynamicBuffer('line', new Float32Array(lineRows), 48);
}

function pushNodeInstance(
  rows: number[],
  x: number,
  y: number,
  radius: number,
  kind: number,
  color: { r: number; g: number; b: number },
  alpha: number,
  state: number,
  seed: number
) {
  rows.push(x, y, radius, kind, color.r, color.g, color.b, alpha, state, seed, 0, 0);
}

function animateCamera() {
  if (!cameraTarget) {
    return;
  }
  const ease = 0.12;
  transform.scale += (cameraTarget.scale - transform.scale) * ease;
  transform.x += (cameraTarget.x - transform.x) * ease;
  transform.y += (cameraTarget.y - transform.y) * ease;
  if (
    Math.abs(transform.scale - cameraTarget.scale) < 0.002 &&
    Math.abs(transform.x - cameraTarget.x) < 0.5 &&
    Math.abs(transform.y - cameraTarget.y) < 0.5
  ) {
    transform.scale = cameraTarget.scale;
    transform.x = cameraTarget.x;
    transform.y = cameraTarget.y;
    cameraTarget = null;
  }
}

function writeDynamicBuffer(kind: 'node' | 'line', data: Float32Array, stride: number) {
  if (!device) {
    return;
  }
  const usage = (globalThis as any).GPUBufferUsage;
  const required = Math.max(stride, data.byteLength);
  if (kind === 'node') {
    if (!nodeInstanceBuffer || required > nodeInstanceCapacity) {
      nodeInstanceCapacity = Math.max(required, nodeInstanceCapacity * 2 || 4096);
      nodeInstanceBuffer = device.createBuffer({
        size: nodeInstanceCapacity,
        usage: usage.VERTEX | usage.COPY_DST
      });
    }
    if (data.byteLength > 0) {
      device.queue.writeBuffer(nodeInstanceBuffer, 0, data);
    }
    return;
  }

  if (!lineVertexBuffer || required > lineVertexCapacity) {
    lineVertexCapacity = Math.max(required, lineVertexCapacity * 2 || 4096);
    lineVertexBuffer = device.createBuffer({
      size: lineVertexCapacity,
      usage: usage.VERTEX | usage.COPY_DST
    });
  }
  if (data.byteLength > 0) {
    device.queue.writeBuffer(lineVertexBuffer, 0, data);
  }
}

function pushLineQuad(
  rows: number[],
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  color: number[],
  state: number
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const nx = (-dy / length) * width;
  const ny = (dx / length) * width;
  const p1 = [a.x + nx, a.y + ny];
  const p2 = [a.x - nx, a.y - ny];
  const p3 = [b.x + nx, b.y + ny];
  const p4 = [b.x - nx, b.y - ny];
  pushLineVertex(rows, p1, color, 0, state);
  pushLineVertex(rows, p2, color, 0, state);
  pushLineVertex(rows, p3, color, 1, state);
  pushLineVertex(rows, p2, color, 0, state);
  pushLineVertex(rows, p4, color, 1, state);
  pushLineVertex(rows, p3, color, 1, state);
}

function pushLineVertex(rows: number[], point: number[], color: number[], u: number, state: number) {
  rows.push(point[0], point[1], u, state, color[0], color[1], color[2], color[3], 0, 0, 0, 0);
}

function isLogHighlighted(log: LogEntry) {
  if (props.activeTagIds.size === 0) {
    return false;
  }
  return [...props.activeTagIds].every((id) => log.tags.some((tag) => tag.id === id));
}

function onPointerDown(event: PointerEvent) {
  cameraTarget = null;
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
  updateLabels();
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
  cameraTarget = null;
  const zoom = event.deltaY < 0 ? 1.08 : 0.92;
  const before = screenToWorld(event.offsetX, event.offsetY);
  transform.scale = Math.min(2.4, Math.max(0.45, transform.scale * zoom));
  const after = worldToScreen(before.x, before.y);
  transform.x += event.offsetX - after.x;
  transform.y += event.offsetY - after.y;
  updateLabels();
}

function focusTag(tagId: number) {
  if (!canvas.value || !tagPositions.has(tagId)) {
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
  const nextScale = Math.max(transform.scale, 1.18);
  cameraTarget = {
    scale: nextScale,
    x: rect.width / 2 - point.x * nextScale,
    y: rect.height / 2 - point.y * nextScale
  };
}

function pickNodeAt(screenX: number, screenY: number) {
  const point = screenToWorld(screenX, screenY);
  return [...pickNodes].reverse().find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= node.r);
}

function updateLabels() {
  if (!canvas.value) {
    labels.value = [];
    visualTags.value = [];
    visualLogs.value = [];
    visualEdges.value = [];
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const nextLabels: LabelItem[] = [];
  const nextTags: VisualTag[] = [];
  const nextLogs: VisualLog[] = [];
  const nextEdges: VisualEdge[] = [];

  for (const tag of props.graph.tags) {
    const point = tagPositions.get(tag.id);
    if (!point) {
      continue;
    }
    const screen = worldToScreen(point.x, point.y);
    const heat = heatMode.value ? heatState(tag.id) : 'flat';
    const active = props.activeTagIds.has(tag.id);
    if (screen.x > -120 && screen.x < rect.width + 120 && screen.y > -120 && screen.y < rect.height + 120) {
      nextTags.push({
        id: tag.id,
        x: screen.x,
        y: screen.y,
        r: Math.max(18, point.r * transform.scale * 1.26),
        color: heatMode.value ? rgbToCss(heatColor(tag.color, heat)) : tag.color,
        active,
        fixed: manualTagPositions.has(tag.id),
        heat
      });
      nextLabels.push({
        id: tag.id,
        name: tag.name,
        x: screen.x,
        y: screen.y + point.r * transform.scale + 18,
        color: tag.color,
        active,
        heat
      });
    }
  }

  for (const log of props.graph.logs) {
    const point = logPositions.get(log.id);
    if (!point) {
      continue;
    }
    const screen = worldToScreen(point.x, point.y);
    const selected = props.selectedLogId === log.id;
    const highlighted = isLogHighlighted(log);
    if (screen.x > -80 && screen.x < rect.width + 80 && screen.y > -80 && screen.y < rect.height + 80) {
      nextLogs.push({
        id: log.id,
        x: screen.x,
        y: screen.y,
        r: selected ? 12 : highlighted ? 10 : 7,
        color: logVisualColor(log),
        kind: logPlanetKind(log),
        tilt: Math.round(seeded(log.id + 341) * 42 - 21),
        selected,
        highlighted,
        fixed: manualLogPositions.has(log.id)
      });
    }
  }

  for (const edge of props.graph.edges) {
    const tag = tagPositions.get(edge.tagId);
    const log = logPositions.get(edge.logId);
    const logEntry = props.graph.logs.find((item) => item.id === edge.logId);
    if (!tag || !log || !logEntry) {
      continue;
    }
    const a = worldToScreen(tag.x, tag.y);
    const b = worldToScreen(log.x, log.y);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const width = Math.hypot(dx, dy);
    const active = props.selectedLogId === edge.logId || isLogHighlighted(logEntry);
    const tagMeta = props.graph.tags.find((item) => item.id === edge.tagId);
    if (width > 2) {
      nextEdges.push({
        key: `${edge.tagId}-${edge.logId}`,
        x: a.x,
        y: a.y,
        width,
        angle: Math.atan2(dy, dx),
        color: tagMeta?.color ?? '#62d6ff',
        active
      });
    }
  }

  labels.value = nextLabels;
  visualTags.value = nextTags;
  visualLogs.value = nextLogs;
  visualEdges.value = nextEdges;
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

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255
  };
}

function heatState(tagId: number): 'up' | 'down' | 'flat' {
  const item = tagTrendById.value.get(tagId);
  if (!item) {
    return 'flat';
  }
  const delta = item.current - item.previous;
  if (delta > 0) {
    return 'up';
  }
  if (item.previous > 0 && delta < 0) {
    return 'down';
  }
  return 'flat';
}

function heatColor(baseHex: string, heat: 'up' | 'down' | 'flat') {
  const base = hexToRgb(baseHex);
  if (heat === 'up') {
    return mixColor(base, { r: 1, g: 0.46, b: 0.18 }, 0.62);
  }
  if (heat === 'down') {
    return mixColor(base, { r: 0.28, g: 0.62, b: 1 }, 0.62);
  }
  return base;
}

function rgbToCss(color: { r: number; g: number; b: number }) {
  return `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
}

function logVisualColor(log: LogEntry) {
  return rgbToCss(logVisualRgb(log));
}

function logVisualRgb(log: LogEntry) {
  if (log.tags.length === 0) {
    return { r: 0.57, g: 0.86, b: 1 };
  }
  if (log.tags.length === 1) {
    return hexToRgb(log.tags[0].color);
  }
  const total = log.tags.reduce(
    (acc, tag) => {
      const color = hexToRgb(tag.color);
      return {
        r: acc.r + color.r,
        g: acc.g + color.g,
        b: acc.b + color.b
      };
    },
    { r: 0, g: 0, b: 0 }
  );
  return {
    r: total.r / log.tags.length,
    g: total.g / log.tags.length,
    b: total.b / log.tags.length
  };
}

function logPlanetKind(log: LogEntry): VisualLog['kind'] {
  const seed = seeded(log.id + log.tags.length * 17);
  if (log.tags.length >= 3) {
    return 'ringed';
  }
  if (seed < 0.22) {
    return 'rocky';
  }
  if (seed < 0.44) {
    return 'gas';
  }
  if (seed < 0.66) {
    return 'ice';
  }
  if (seed < 0.82) {
    return 'lava';
  }
  return 'ringed';
}

function mixColor(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number) {
  return {
    r: a.r * (1 - t) + b.r * t,
    g: a.g * (1 - t) + b.g * t,
    b: a.b * (1 - t) + b.b * t
  };
}

function seeded(input: number) {
  const x = Math.sin(input * 999.91) * 10000;
  return x - Math.floor(x);
}

const nodeShader = `
struct Uniforms {
  viewport: vec4f,
  pan: vec4f
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexIn {
  @location(0) local: vec2f,
  @location(1) world: vec2f,
  @location(2) radius: f32,
  @location(3) color: vec4f,
  @location(4) kind: f32,
  @location(5) state: f32,
  @location(6) seed: f32
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec4f,
  @location(2) kind: f32,
  @location(3) state: f32,
  @location(4) seed: f32,
  @location(5) time: f32
};

@vertex
fn vs(input: VertexIn) -> VertexOut {
  let size = u.viewport.xy;
  let scale = u.viewport.z;
  let time = u.viewport.w;
  var screen = input.world * scale + u.pan.xy;
  var radius = input.radius * scale;
  if (input.kind < 0.5) {
    let drift = vec2f(sin(time * 0.18 + input.seed * 6.283) * 12.0, cos(time * 0.13 + input.seed * 5.1) * 8.0);
    screen = input.world + drift + u.pan.xy * 0.045;
    radius = input.radius;
  }
  let pos = screen + input.local * radius;
  let clip = vec2f(pos.x / size.x * 2.0 - 1.0, 1.0 - pos.y / size.y * 2.0);
  var out: VertexOut;
  out.position = vec4f(clip, 0.0, 1.0);
  out.local = input.local;
  out.color = input.color;
  out.kind = input.kind;
  out.state = input.state;
  out.seed = input.seed;
  out.time = time;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let d = length(input.local);
  if (d > 1.72) {
    discard;
  }
  if (input.kind < 0.5) {
    let twinkle = 0.72 + sin(input.time * 1.8 + input.seed * 9.7) * 0.28;
    let alpha = (1.0 - smoothstep(0.0, 1.0, d)) * input.color.a * twinkle;
    return vec4f(input.color.rgb, alpha);
  }

  if (input.kind > 3.5) {
    let ring = exp(-abs(d - 0.92) * 34.0);
    let pulse = 0.62 + sin(input.time * 2.4 + input.seed * 5.2) * 0.24;
    return vec4f(input.color.rgb, ring * input.color.a * pulse);
  }

  if (input.kind > 2.5) {
    let halo = 1.0 - smoothstep(0.0, 1.72, d);
    let core = 1.0 - smoothstep(0.0, 0.72, d);
    let pulse = 0.76 + sin(input.time * 2.2 + input.seed * 6.283) * 0.18;
    let alpha = (halo * 0.82 + core * 0.28) * input.color.a * pulse * (0.82 + input.state * 0.42);
    return vec4f(input.color.rgb, alpha);
  }

  if (input.kind > 0.5 && input.kind < 1.5) {
    let plasma = 0.5 + 0.5 * sin((input.local.x * 8.0 + input.local.y * 5.0) + input.time * 1.7 + input.seed * 5.2);
    let core = 1.0 - smoothstep(0.0, 0.34, d);
    let chroma = 1.0 - smoothstep(0.18, 1.28, d);
    let corona = 1.0 - smoothstep(0.38, 1.62, d);
    let pulse = 0.86 + sin(input.time * 2.7 + input.seed * 6.283) * 0.14;
    let alpha = min(1.0, input.color.a * pulse * (core * 1.15 + chroma * 0.72 + corona * 0.34));
    let whiteCore = vec3f(1.0, 0.96, 0.88) * (core * 0.9);
    let plasmaColor = input.color.rgb * (0.78 + plasma * 0.42) + vec3f(0.28, 0.18, 0.36) * corona;
    return vec4f(min(plasmaColor + whiteCore, vec3f(1.0)), alpha);
  }

  let pulse = (sin(input.time * 3.2 + input.seed * 6.283) * 0.5 + 0.5) * input.state;
  let core = 1.0 - smoothstep(0.12, 1.0, d);
  let glow = (1.0 - smoothstep(0.0, 1.55, d)) * (0.45 + input.state * 0.46);
  let ringState = clamp((input.state - 0.62) * 2.6, 0.0, 1.0);
  let ring = exp(-abs(d - 1.03) * 24.0) * ringState * 0.72;
  let alpha = min(1.0, input.color.a * (core + glow + ring + pulse * 0.18));
  let hot = vec3f(1.0, 1.0, 1.0) * (core * 0.38 + input.state * 0.2);
  let limb = vec3f(0.12, 0.18, 0.26) * smoothstep(0.0, 0.95, d);
  return vec4f(min(input.color.rgb + hot + limb, vec3f(1.0)), alpha);
}
`;

const lineShader = `
struct Uniforms {
  viewport: vec4f,
  pan: vec4f
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexIn {
  @location(0) world: vec2f,
  @location(1) color: vec4f,
  @location(2) meta: vec2f
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) meta: vec2f,
  @location(2) time: f32
};

@vertex
fn vs(input: VertexIn) -> VertexOut {
  let size = u.viewport.xy;
  let scale = u.viewport.z;
  let screen = input.world * scale + u.pan.xy;
  let clip = vec2f(screen.x / size.x * 2.0 - 1.0, 1.0 - screen.y / size.y * 2.0);
  var out: VertexOut;
  out.position = vec4f(clip, 0.0, 1.0);
  out.color = input.color;
  out.meta = input.meta;
  out.time = u.viewport.w;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let wave = fract(input.meta.x * 3.4 - input.time * 0.82);
  let flow = smoothstep(0.72, 0.92, wave) * (1.0 - smoothstep(0.92, 1.0, wave));
  let alpha = min(1.0, input.color.a + flow * (0.18 + input.meta.y * 0.72));
  let color = input.color.rgb + vec3f(0.32, 0.5, 0.62) * flow * (0.35 + input.meta.y);
  return vec4f(color, alpha);
}
`;
</script>

<template>
  <div class="canvas-wrap webgpu-wrap">
    <canvas
      ref="canvas"
      class="nebula-canvas webgpu-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @wheel="onWheel"
    ></canvas>

    <div class="webgpu-space-field"></div>
    <div class="webgpu-nebula-clouds"></div>

    <div class="webgpu-visual-layer">
      <span
        v-for="edge in visualEdges"
        :key="edge.key"
        class="webgpu-energy-line"
        :class="{ active: edge.active }"
        :style="{
          left: `${edge.x}px`,
          top: `${edge.y}px`,
          width: `${edge.width}px`,
          transform: `rotate(${edge.angle}rad)`,
          '--edge-color': edge.color
        }"
      ></span>
      <span
        v-for="tag in visualTags"
        :key="tag.id"
        class="webgpu-star"
        :class="{ active: tag.active, fixed: tag.fixed, up: tag.heat === 'up', down: tag.heat === 'down' }"
        :style="{
          left: `${tag.x}px`,
          top: `${tag.y}px`,
          width: `${tag.r * 2}px`,
          height: `${tag.r * 2}px`,
          '--node-color': tag.color
        }"
      ></span>
      <span
        v-for="log in visualLogs"
        :key="log.id"
        class="webgpu-planet"
        :class="[`type-${log.kind}`, { selected: log.selected, highlighted: log.highlighted, fixed: log.fixed }]"
        :style="{
          left: `${log.x}px`,
          top: `${log.y}px`,
          width: `${log.r * 2}px`,
          height: `${log.r * 2}px`,
          '--planet-color': log.color,
          '--planet-tilt': `${log.tilt}deg`
        }"
      ></span>
    </div>

    <div class="webgpu-label-layer">
      <button
        v-for="label in labels"
        :key="label.id"
        class="webgpu-label"
        :class="{ active: label.active, up: label.heat === 'up', down: label.heat === 'down' }"
        :style="{ left: `${label.x}px`, top: `${label.y}px`, '--label-color': label.color }"
        @click="emit('tagToggle', label.id)"
      >
        {{ label.name }}
      </button>
    </div>

    <div v-if="!webgpuReady" class="webgpu-status">
      {{ webgpuMessage }}
    </div>
    <button class="webgpu-heat-toggle" :class="{ active: heatMode }" @click="heatMode = !heatMode">
      热力
    </button>
    <div class="webgpu-hud">WebGPU 2.5D 星系 · 粒子星空 · 能量丝线 · 固定环 · 热力模式</div>
  </div>
</template>
