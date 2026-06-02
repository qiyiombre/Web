<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Maximize2, Minimize2 } from 'lucide-vue-next';
import type { GraphData, LogEntry } from '../types/domain';

type PickNode =
  | { kind: 'tag'; id: number; x: number; y: number; r: number }
  | { kind: 'log'; id: number; x: number; y: number; r: number };

type LayoutPoint = { x: number; y: number; r: number };
type Point3D = { x: number; y: number; z: number };
type CameraTarget = { scale: number; panX: number; panY: number; panZ: number; yaw?: number; pitch?: number };
type LayoutSnapshot = {
  tags: Array<[number, { x: number; y: number }]>;
  logs: Array<[number, { x: number; y: number }]>;
};

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

const props = defineProps<{
  graph: GraphData;
  activeTagIds: Set<number>;
  selectedLogId: number | null;
}>();

const emit = defineEmits<{
  tagToggle: [tagId: number];
  logOpen: [logId: number];
  logInspect: [payload: { logId: number; x: number; y: number; width: number; height: number }];
  layoutDirty: [dirty: boolean];
}>();

const FOCAL_LENGTH = 740;
const VIEW_DISTANCE = 980;

const wrap = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const labels = ref<LabelItem[]>([]);
const webgpuReady = ref(false);
const webgpuMessage = ref('正在初始化 WebGPU...');
const webgpuError = ref('');
const heatMode = ref(false);
const fullscreen = ref(false);
const transform = reactive({ scale: 1, x: 0, y: 0 });
const camera = reactive({ yaw: -0.42, pitch: -0.32, panX: 0, panY: 0, panZ: 0 });
const nebulaCursor = reactive({ x: 0, y: 0, visible: false, angle: -0.2 });

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
let lineInstanceBuffer: any = null;
let backgroundPipeline: any = null;
let nodePipeline: any = null;
let linePipeline: any = null;
let nodeInstanceCapacity = 0;
let lineInstanceCapacity = 0;
let starCount = 0;
let nodeCount = 0;
let lineCount = 0;
let raf = 0;
let latestLayoutRequestId = 0;
let pendingFocusTagId: number | null = null;
let isDragging = false;
let dragMode: 'orbit' | 'pan' | 'tag' | 'log' | null = null;
let dragTagId: number | null = null;
let dragLogId: number | null = null;
let dragTagOffset = { x: 0, y: 0 };
let dragLogOffset = { x: 0, y: 0 };
let dragWorldZ = 0;
let moved = false;
let lastPointer = { x: 0, y: 0 };
let dragButton = 0;
let stars: Array<{ x: number; y: number; z: number; r: number; alpha: number; seed: number }> = [];
let cameraTarget: CameraTarget | null = null;
let resizeObserver: ResizeObserver | null = null;
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
  document.addEventListener('fullscreenchange', onFullscreenChange);
  if (wrap.value) {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(wrap.value);
  }
  await initWebGpu();
  requestLayout();
  raf = requestAnimationFrame(render);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  resizeObserver?.disconnect();
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
  resetTagLayout,
  refreshLayout,
  saveLayout,
  undoLayout,
  redoLayout
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
    webgpuError.value = message;
    console.error('WebGPU uncaptured error:', message);
  });
  context = canvas.value?.getContext('webgpu');
  if (!context) {
    webgpuReady.value = false;
    webgpuMessage.value = 'WebGPU 上下文创建失败。';
    return;
  }

  format = gpu.getPreferredCanvasFormat();
  try {
    await createResources();
  } catch (error) {
    webgpuReady.value = false;
    webgpuError.value = error instanceof Error ? error.message : 'WebGPU 渲染资源创建失败';
    return;
  }
  configureContext();
  webgpuReady.value = true;
  webgpuMessage.value = '';
  webgpuError.value = '';
}

async function createResources() {
  const usage = (globalThis as any).GPUBufferUsage;
  const shaderStage = (globalThis as any).GPUShaderStage;
  uniformBuffer = device.createBuffer({
    size: 64,
    usage: usage.UNIFORM | usage.COPY_DST
  });

  bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: shaderStage.VERTEX | shaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
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

  backgroundPipeline = await createPipeline('WebGPU 背景星云管线', {
    layout: pipelineLayout,
    vertex: {
      module: await createShaderModule('WebGPU 背景星云 shader', backgroundShader),
      entryPoint: 'vs'
    },
    fragment: {
      module: await createShaderModule('WebGPU 背景星云 shader', backgroundShader),
      entryPoint: 'fs',
      targets: [{ format }]
    },
    primitive: { topology: 'triangle-list' }
  });

  nodePipeline = await createPipeline('WebGPU 恒星行星管线', {
    layout: pipelineLayout,
    vertex: {
      module: await createShaderModule('WebGPU 恒星行星 shader', nodeShader),
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
            { shaderLocation: 1, offset: 0, format: 'float32x3' },
            { shaderLocation: 2, offset: 12, format: 'float32' },
            { shaderLocation: 3, offset: 16, format: 'float32x4' },
            { shaderLocation: 4, offset: 32, format: 'float32' },
            { shaderLocation: 5, offset: 36, format: 'float32' },
            { shaderLocation: 6, offset: 40, format: 'float32' },
            { shaderLocation: 7, offset: 44, format: 'float32' }
          ]
        }
      ]
    },
    fragment: {
      module: await createShaderModule('WebGPU 恒星行星 shader', nodeShader),
      entryPoint: 'fs',
      targets: [blendTarget()]
    },
    primitive: { topology: 'triangle-list' }
  });

  linePipeline = await createPipeline('WebGPU 空间能量线管线', {
    layout: pipelineLayout,
    vertex: {
      module: await createShaderModule('WebGPU 空间能量线 shader', lineShader),
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 64,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x4' },
            { shaderLocation: 3, offset: 40, format: 'float32x4' }
          ]
        }
      ]
    },
    fragment: {
      module: await createShaderModule('WebGPU 空间能量线 shader', lineShader),
      entryPoint: 'fs',
      targets: [blendTarget()]
    },
    primitive: { topology: 'triangle-list' }
  });
}

async function createShaderModule(label: string, code: string) {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo?.();
  const error = info?.messages?.find((message: any) => message.type === 'error');
  if (error) {
    throw new Error(`${label} 编译失败：${error.message}`);
  }
  return module;
}

async function createPipeline(label: string, descriptor: any) {
  device.pushErrorScope?.('validation');
  try {
    if (device.createRenderPipelineAsync) {
      const pipeline = await device.createRenderPipelineAsync({ label, ...descriptor });
      const scopedError = await device.popErrorScope?.();
      if (scopedError) {
        throw new Error(`${label} 创建失败：${scopedError.message}`);
      }
      return pipeline;
    }
    const pipeline = device.createRenderPipeline({ label, ...descriptor });
    const scopedError = await device.popErrorScope?.();
    if (scopedError) {
      throw new Error(`${label} 创建失败：${scopedError.message}`);
    }
    return pipeline;
  } catch (error) {
    const scopedError = await device.popErrorScope?.().catch?.(() => null);
    if (scopedError) {
      throw new Error(`${label} 创建失败：${scopedError.message}`);
    }
    throw error;
  }
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
  canvas.value.style.width = '100%';
  canvas.value.style.height = '100%';
  buildStars();
  configureContext();
  updateLabels();
}

function buildStars() {
  stars = Array.from({ length: 1200 }, (_, index) => {
    const seed = seeded(index + 37);
    return {
      x: (seeded(index + 17) - 0.5) * 1900,
      y: (seeded(index + 89) - 0.5) * 1120,
      z: (seeded(index + 191) - 0.5) * 1450,
      r: 0.62 + seeded(index + 144) * 1.72,
      alpha: 0.11 + seeded(index + 233) * 0.24,
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
  if (!webgpuReady.value || webgpuError.value || !device || !context || !canvas.value) {
    return;
  }

  const rect = canvas.value.getBoundingClientRect();
  animateCamera();
  updateGeometryBuffers();
  updateLabels();
  device.queue.writeBuffer(
    uniformBuffer,
    0,
    new Float32Array([
      rect.width,
      rect.height,
      transform.scale,
      timeMs / 1000,
      camera.panX,
      camera.panY,
      camera.yaw,
      camera.pitch,
      FOCAL_LENGTH,
      VIEW_DISTANCE,
      1,
      0,
      camera.panZ,
      0,
      0,
      0
    ])
  );

  device.pushErrorScope?.('validation');
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.01, g: 0.018, b: 0.034, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(backgroundPipeline);
    pass.draw(3);

    if (nodeInstanceBuffer && starCount > 0) {
      pass.setPipeline(nodePipeline);
      pass.setVertexBuffer(0, quadBuffer);
      pass.setVertexBuffer(1, nodeInstanceBuffer);
      pass.draw(6, starCount, 0, 0);
    }
    if (lineInstanceBuffer && lineCount > 0) {
      pass.setPipeline(linePipeline);
      pass.setVertexBuffer(0, lineInstanceBuffer);
      pass.draw(6, lineCount);
    }
    if (nodeInstanceBuffer && nodeCount > 0) {
      pass.setPipeline(nodePipeline);
      pass.setVertexBuffer(0, quadBuffer);
      pass.setVertexBuffer(1, nodeInstanceBuffer);
      pass.draw(6, nodeCount, 0, starCount);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  } catch (error) {
    webgpuError.value = error instanceof Error ? error.message : 'WebGPU 命令提交失败';
  }
  device.popErrorScope?.()
    .then((error: any) => {
      if (error) {
        webgpuError.value = error.message ?? 'WebGPU 渲染命令验证失败';
      }
    })
    .catch(() => {});
}

function updateGeometryBuffers() {
  const nodeRows: number[] = [];

  for (const star of stars) {
    pushNodeInstance(nodeRows, star, star.r, 0, { r: 0.9, g: 0.96, b: 1 }, star.alpha, 0, star.seed, 0);
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
    const activeScale = active ? 1.22 : 1;
    const coreRadius = point.r * 1.38 * depth * activeScale;
    const world = tagPoint3D(tag.id, point);
    pushNodeInstance(nodeRows, world, coreRadius * (active ? 1.32 : 1.12), 3, color, active ? 0.12 : 0.06, state, seeded(tag.id + 700), 0);
    pushNodeInstance(nodeRows, world, coreRadius * (active ? 1.76 : 1.48), 1, color, active ? 1 : 0.94, state, seeded(tag.id + 800), 0);
  }

  for (const log of props.graph.logs) {
    const point = logPositions.get(log.id);
    if (!point) {
      continue;
    }
    const selected = props.selectedLogId === log.id;
    const highlighted = isLogHighlighted(log);
    const state = selected ? 1 : highlighted ? 0.82 : 0.26;
    const radius = selected ? 6.8 : highlighted ? 6.2 : 4.9;
    const glowAlpha = selected ? 0.6 : highlighted ? 0.28 : 0.07;
    const glowRadius = selected ? 3.4 : highlighted ? 2.75 : 2.1;
    const bodyAlpha = selected ? 0.98 : highlighted ? 0.92 : 0.84;
    const logColor = logVisualRgb(log);
    const world = logPoint3D(log, point);
    const seed = seeded(log.id + 1900);
    const tilt = seeded(log.id + 341) * 1.1 - 0.55;
    pushNodeInstance(nodeRows, world, radius * glowRadius, 3.25, logColor, glowAlpha, state, seeded(log.id + 1600), 0);
    pushNodeInstance(nodeRows, world, radius * 1.1, 2, mixColor(logColor, { r: 1, g: 1, b: 1 }, 0.16), bodyAlpha, state, seed, tilt);
  }
  nodeCount = Math.max(0, nodeRows.length / 12 - starCount);
  writeDynamicBuffer('node', new Float32Array(nodeRows), 48);

  const lineRows: number[] = [];
  for (const edge of props.graph.edges) {
    const tagPoint = tagPositions.get(edge.tagId);
    const logPoint = logPositions.get(edge.logId);
    const logEntry = props.graph.logs.find((item) => item.id === edge.logId);
    if (!tagPoint || !logPoint || !logEntry) {
      continue;
    }
    const selected = props.selectedLogId === edge.logId;
    const highlighted = selected || isLogHighlighted(logEntry);
    const tagMeta = props.graph.tags.find((item) => item.id === edge.tagId);
    const tagColor = tagMeta ? hexToRgb(tagMeta.color) : { r: 0.38, g: 0.84, b: 1 };
    const color = highlighted
      ? [Math.min(1, tagColor.r + 0.18), Math.min(1, tagColor.g + 0.28), Math.min(1, tagColor.b + 0.28), 0.8]
      : [tagColor.r * 0.7, tagColor.g * 0.82, Math.min(1, tagColor.b + 0.18), 0.2];
    pushLineInstance(
      lineRows,
      tagPoint3D(edge.tagId, tagPoint),
      logPoint3D(logEntry, logPoint),
      color,
      highlighted ? 3.4 : 1.25,
      highlighted ? 1 : 0.18,
      seeded(edge.tagId * 31 + edge.logId)
    );
  }
  lineCount = lineRows.length / 16;
  writeDynamicBuffer('line', new Float32Array(lineRows), 64);
}

function pushNodeInstance(
  rows: number[],
  world: Point3D,
  radius: number,
  kind: number,
  color: { r: number; g: number; b: number },
  alpha: number,
  state: number,
  seed: number,
  tilt: number
) {
  rows.push(world.x, world.y, world.z, radius, color.r, color.g, color.b, alpha, kind, state, seed, tilt);
}

function pushLineInstance(
  rows: number[],
  start: Point3D,
  end: Point3D,
  color: number[],
  width: number,
  state: number,
  seed: number
) {
  rows.push(
    start.x,
    start.y,
    start.z,
    end.x,
    end.y,
    end.z,
    color[0],
    color[1],
    color[2],
    color[3],
    width,
    state,
    seed,
    0,
    0,
    0
  );
}

function animateCamera() {
  if (!cameraTarget) {
    return;
  }
  const ease = 0.12;
  transform.scale += (cameraTarget.scale - transform.scale) * ease;
  camera.panX += (cameraTarget.panX - camera.panX) * ease;
  camera.panY += (cameraTarget.panY - camera.panY) * ease;
  camera.panZ += (cameraTarget.panZ - camera.panZ) * ease;
  if (cameraTarget.yaw !== undefined) {
    camera.yaw += (cameraTarget.yaw - camera.yaw) * ease;
  }
  if (cameraTarget.pitch !== undefined) {
    camera.pitch += (cameraTarget.pitch - camera.pitch) * ease;
  }
  if (
    Math.abs(transform.scale - cameraTarget.scale) < 0.002 &&
    Math.abs(camera.panX - cameraTarget.panX) < 0.5 &&
    Math.abs(camera.panY - cameraTarget.panY) < 0.5 &&
    Math.abs(camera.panZ - cameraTarget.panZ) < 0.5 &&
    (cameraTarget.yaw === undefined || Math.abs(camera.yaw - cameraTarget.yaw) < 0.003) &&
    (cameraTarget.pitch === undefined || Math.abs(camera.pitch - cameraTarget.pitch) < 0.003)
  ) {
    transform.scale = cameraTarget.scale;
    camera.panX = cameraTarget.panX;
    camera.panY = cameraTarget.panY;
    camera.panZ = cameraTarget.panZ;
    if (cameraTarget.yaw !== undefined) {
      camera.yaw = cameraTarget.yaw;
    }
    if (cameraTarget.pitch !== undefined) {
      camera.pitch = cameraTarget.pitch;
    }
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

  if (!lineInstanceBuffer || required > lineInstanceCapacity) {
    lineInstanceCapacity = Math.max(required, lineInstanceCapacity * 2 || 4096);
    lineInstanceBuffer = device.createBuffer({
      size: lineInstanceCapacity,
      usage: usage.VERTEX | usage.COPY_DST
    });
  }
  if (data.byteLength > 0) {
    device.queue.writeBuffer(lineInstanceBuffer, 0, data);
  }
}

function isLogHighlighted(log: LogEntry) {
  if (props.activeTagIds.size === 0) {
    return false;
  }
  return [...props.activeTagIds].every((id) => log.tags.some((tag) => tag.id === id));
}

function onPointerDown(event: PointerEvent) {
  event.preventDefault();
  updateNebulaCursor(event);
  cameraTarget = null;
  isDragging = true;
  dragMode = event.button === 1 ? 'pan' : 'orbit';
  if (dragMode === 'pan') {
    lastPanInteractionAt = performance.now();
  }
  dragTagId = null;
  dragLogId = null;
  dragWorldZ = 0;
  moved = false;
  dragButton = event.button;
  dragSnapshot = null;
  lastPointer = { x: event.clientX, y: event.clientY };
  const picked = pickNodeAt(event.offsetX, event.offsetY);
  if (event.button === 0 && picked?.kind === 'tag') {
    dragSnapshot = captureManualPositions();
    const current = tagPositions.get(picked.id);
    dragWorldZ = tagDepth(picked.id);
    const point = screenToWorldAtDepth(event.offsetX, event.offsetY, dragWorldZ);
    dragMode = 'tag';
    dragTagId = picked.id;
    dragTagOffset = {
      x: (current?.x ?? point.x) - point.x,
      y: (current?.y ?? point.y) - point.y
    };
  } else if (event.button === 0 && picked?.kind === 'log') {
    dragSnapshot = captureManualPositions();
    const current = logPositions.get(picked.id);
    const log = props.graph.logs.find((item) => item.id === picked.id);
    dragWorldZ = log && current ? logPoint3D(log, current).z : 0;
    const point = screenToWorldAtDepth(event.offsetX, event.offsetY, dragWorldZ);
    dragMode = 'log';
    dragLogId = picked.id;
    dragLogOffset = {
      x: (current?.x ?? point.x) - point.x,
      y: (current?.y ?? point.y) - point.y
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
    const point = screenToWorldAtDepth(event.offsetX, event.offsetY, dragWorldZ);
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
    const point = screenToWorldAtDepth(event.offsetX, event.offsetY, dragWorldZ);
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
  } else if (dragMode === 'pan') {
    lastPanInteractionAt = performance.now();
    panCameraByScreenDelta(dx, dy);
  } else {
    camera.yaw += dx * 0.004;
    camera.pitch = clamp(camera.pitch + dy * 0.003, -0.82, 0.58);
  }
  lastPointer = { x: event.clientX, y: event.clientY };
  updateLabels();
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
  dragWorldZ = 0;
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
  if (button !== 0) {
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
  if (isDragging || performance.now() - lastPanInteractionAt < 220) {
    return;
  }
  cameraTarget = null;
  const zoom = event.deltaY < 0 ? 1.08 : 0.92;
  const before = screenToWorld(event.offsetX, event.offsetY);
  transform.scale = Math.min(2.55, Math.max(0.42, transform.scale * zoom));
  const after = screenToWorld(event.offsetX, event.offsetY);
  camera.panX += before.x - after.x;
  camera.panY += before.y - after.y;
  updateLabels();
}

function panCameraByScreenDelta(dx: number, dy: number) {
  const delta = cameraPanDeltaForScreenShift(dx, dy, transform.scale, VIEW_DISTANCE);
  camera.panX += delta.x;
  camera.panY += delta.y;
  camera.panZ += delta.z;
}

function cameraPanDeltaForScreenShift(dx: number, dy: number, scale: number, depth = VIEW_DISTANCE) {
  const worldPerPixel = Math.max(170, depth) / (Math.max(0.001, scale) * FOCAL_LENGTH);
  const right = inverseRotateWorld({ x: 1, y: 0, z: 0 });
  const up = inverseRotateWorld({ x: 0, y: 1, z: 0 });
  return {
    x: (-dx * right.x - dy * up.x) * worldPerPixel,
    y: (-dx * right.y - dy * up.y) * worldPerPixel,
    z: (-dx * right.z - dy * up.z) * worldPerPixel
  };
}

function updateNebulaCursor(event: PointerEvent) {
  const dx = event.offsetX - nebulaCursor.x;
  const dy = event.offsetY - nebulaCursor.y;
  if (Math.abs(dx) + Math.abs(dy) > 1) {
    nebulaCursor.angle = Math.atan2(dy, dx);
  }
  nebulaCursor.x = event.offsetX;
  nebulaCursor.y = event.offsetY;
  nebulaCursor.visible = true;
}

function hideNebulaCursor() {
  nebulaCursor.visible = false;
}

function onDoubleClick(event: MouseEvent) {
  const picked = pickNodeAt(event.offsetX, event.offsetY);
  if (picked?.kind === 'log') {
    const rect = canvas.value?.getBoundingClientRect();
    emit('logInspect', {
      logId: picked.id,
      x: event.offsetX,
      y: event.offsetY,
      width: rect?.width ?? window.innerWidth,
      height: rect?.height ?? window.innerHeight
    });
  }
}

async function toggleFullscreen() {
  if (!wrap.value) {
    return;
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await wrap.value.requestFullscreen();
    }
  } catch (error) {
    webgpuError.value = error instanceof Error ? error.message : '全屏切换失败';
  }
}

function onFullscreenChange() {
  fullscreen.value = document.fullscreenElement === wrap.value;
  requestAnimationFrame(() => requestAnimationFrame(resize));
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
  const world = tagPoint3D(tagId, point);
  const base = projectWorldToScreen(world, nextScale);
  const delta = cameraPanDeltaForScreenShift(rect.width / 2 - base.x, rect.height / 2 - base.y, nextScale, base.depth);
  cameraTarget = {
    scale: nextScale,
    panX: camera.panX + delta.x,
    panY: camera.panY + delta.y,
    panZ: camera.panZ + delta.z
  };
}

function pickNodeAt(screenX: number, screenY: number) {
  return [...pickNodes].reverse().find((node) => Math.hypot(node.x - screenX, node.y - screenY) <= node.r);
}

function updateLabels() {
  if (!canvas.value) {
    labels.value = [];
    pickNodes.length = 0;
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const nextLabels: LabelItem[] = [];
  pickNodes.length = 0;

  for (const tag of props.graph.tags) {
    const point = tagPositions.get(tag.id);
    if (!point) {
      continue;
    }
    const screen = projectWorldToScreen(tagPoint3D(tag.id, point));
    const heat = heatMode.value ? heatState(tag.id) : 'flat';
    const active = props.activeTagIds.has(tag.id);
    const radius = Math.max(active ? 32 : 24, point.r * transform.scale * screen.perspective * (active ? 2.1 : 1.72));
    if (screen.x > -140 && screen.x < rect.width + 140 && screen.y > -140 && screen.y < rect.height + 140) {
      pickNodes.push({ kind: 'tag', id: tag.id, x: screen.x, y: screen.y, r: radius });
      nextLabels.push({
        id: tag.id,
        name: tag.name,
        x: screen.x,
        y: screen.y + radius + 15,
        color: heatMode.value ? rgbToCss(heatColor(tag.color, heat)) : tag.color,
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
    const screen = projectWorldToScreen(logPoint3D(log, point));
    const selected = props.selectedLogId === log.id;
    const highlighted = isLogHighlighted(log);
    const radius = Math.max(12, (highlighted || selected ? 11 : 8) * transform.scale * screen.perspective);
    if (screen.x > -90 && screen.x < rect.width + 90 && screen.y > -90 && screen.y < rect.height + 90) {
      pickNodes.push({ kind: 'log', id: log.id, x: screen.x, y: screen.y, r: radius + 6 });
    }
  }

  labels.value = nextLabels;
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
  updateLabels();
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
  updateLabels();
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
  cameraTarget = null;
  requestLayout();
  updateLabels();
}

function worldToScreen(x: number, y: number) {
  return projectWorldToScreen({ x, y, z: 0 });
}

function screenToWorld(x: number, y: number) {
  return screenToWorldAtDepth(x, y, 0);
}

function screenToWorldAtDepth(x: number, y: number, worldZ: number) {
  return screenToWorldAtDepthWithCamera(x, y, worldZ, transform.scale, camera.panX, camera.panY, camera.panZ);
}

function screenToWorldAtDepthWithCamera(
  x: number,
  y: number,
  worldZ: number,
  scaleValue: number,
  panX: number,
  panY: number,
  panZ: number
) {
  if (!canvas.value) {
    return { x: 0, y: 0 };
  }
  const rect = canvas.value.getBoundingClientRect();
  const scale = Math.max(0.001, scaleValue);
  const rayX = (x - rect.width / 2) / (scale * FOCAL_LENGTH);
  const rayY = (y - rect.height / 2) / (scale * FOCAL_LENGTH);
  const worldAtDepth0 = inverseRotateWorld({ x: 0, y: 0, z: -VIEW_DISTANCE });
  const worldAtDepth1 = inverseRotateWorld({ x: rayX, y: rayY, z: 1 - VIEW_DISTANCE });
  const depthDelta = worldAtDepth1.z - worldAtDepth0.z;
  if (Math.abs(depthDelta) < 0.0001) {
    return { x: worldAtDepth0.x + panX, y: worldAtDepth0.y + panY };
  }
  const depth = Math.max(170, (worldZ - panZ - worldAtDepth0.z) / depthDelta);
  const world = inverseRotateWorld({
    x: rayX * depth,
    y: rayY * depth,
    z: depth - VIEW_DISTANCE
  });
  return { x: world.x + panX, y: world.y + panY };
}

function projectWorldToScreen(
  point: Point3D,
  scale = transform.scale,
  panX = camera.panX,
  panY = camera.panY,
  panZ = camera.panZ
) {
  if (!canvas.value) {
    return { x: 0, y: 0, perspective: 1, depth: VIEW_DISTANCE };
  }
  const rect = canvas.value.getBoundingClientRect();
  const rotated = rotateWorld({ x: point.x - panX, y: point.y - panY, z: point.z - panZ });
  const depth = Math.max(170, VIEW_DISTANCE + rotated.z);
  const perspective = FOCAL_LENGTH / depth;
  return {
    x: rect.width / 2 + rotated.x * scale * perspective,
    y: rect.height / 2 + rotated.y * scale * perspective,
    perspective,
    depth
  };
}

function rotateWorld(point: Point3D) {
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const xz = {
    x: point.x * cy - point.z * sy,
    y: point.y,
    z: point.x * sy + point.z * cy
  };
  return {
    x: xz.x,
    y: xz.y * cp - xz.z * sp,
    z: xz.y * sp + xz.z * cp
  };
}

function inverseRotateWorld(point: Point3D) {
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const unpitched = {
    x: point.x,
    y: point.y * cp + point.z * sp,
    z: -point.y * sp + point.z * cp
  };
  return {
    x: unpitched.x * cy + unpitched.z * sy,
    y: unpitched.y,
    z: -unpitched.x * sy + unpitched.z * cy
  };
}

function tagPoint3D(tagId: number, point: LayoutPoint): Point3D {
  return {
    x: point.x,
    y: point.y,
    z: tagDepth(tagId)
  };
}

function logPoint3D(log: LogEntry, point: LayoutPoint): Point3D {
  const relatedDepths = log.tags.map((tag) => tagDepth(tag.id));
  const base =
    relatedDepths.length > 0
      ? relatedDepths.reduce((sum, depth) => sum + depth, 0) / relatedDepths.length
      : 0;
  return {
    x: point.x,
    y: point.y,
    z: base * 0.58 + (seeded(log.id + 854) - 0.5) * 190
  };
}

function tagDepth(tagId: number) {
  return (seeded(tagId + 4321) - 0.5) * 320;
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

function logPlanetKind(log: LogEntry) {
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function seeded(input: number) {
  const x = Math.sin(input * 999.91) * 10000;
  return x - Math.floor(x);
}

const backgroundShader = `
struct Uniforms {
  viewport: vec4f,
  camera: vec4f,
  space: vec4f,
  extra: vec4f
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
};

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn wrapCellX(cell: vec2f, periodX: f32) -> vec2f {
  let x = cell.x - floor(cell.x / periodX) * periodX;
  return vec2f(x, cell.y);
}

fn valueNoiseWrapped(p: vec2f, periodX: f32) -> f32 {
  let i = floor(p);
  let q = fract(p);
  let f = q * q * (vec2f(3.0) - 2.0 * q);
  let a = hash(wrapCellX(i, periodX));
  let b = hash(wrapCellX(i + vec2f(1.0, 0.0), periodX));
  let c = hash(wrapCellX(i + vec2f(0.0, 1.0), periodX));
  let d = hash(wrapCellX(i + vec2f(1.0, 1.0), periodX));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn rotateSky(dir: vec3f) -> vec3f {
  let cy = cos(-u.camera.z);
  let sy = sin(-u.camera.z);
  let cp = cos(-u.camera.w);
  let sp = sin(-u.camera.w);
  let pitched = vec3f(dir.x, dir.y * cp - dir.z * sp, dir.y * sp + dir.z * cp);
  return normalize(vec3f(pitched.x * cy - pitched.z * sy, pitched.y, pitched.x * sy + pitched.z * cy));
}

fn softStar(uv: vec2f, periodX: f32, threshold: f32, radius: f32, scale: f32) -> f32 {
  let cell = wrapCellX(floor(uv), periodX);
  let brightness = hash(cell);
  let intensity = smoothstep(threshold, 1.0, brightness);
  let offset = vec2f(hash(cell + vec2f(23.4, 11.8)), hash(cell + vec2f(7.2, 59.1)));
  let d = length(fract(uv) - offset);
  let core = 1.0 - smoothstep(radius * 0.25, radius, d);
  let glow = 1.0 - smoothstep(radius, radius * 2.8, d);
  return (core + glow * 0.28) * intensity * scale;
}

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var pos = vec2f(-1.0, -1.0);
  if (vertexIndex == 1u) {
    pos = vec2f(3.0, -1.0);
  }
  if (vertexIndex == 2u) {
    pos = vec2f(-1.0, 3.0);
  }
  var out: VertexOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + vec2f(0.5);
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let time = u.viewport.w;
  let aspect = max(0.4, u.viewport.x / max(1.0, u.viewport.y));
  let viewPan = vec2f(u.camera.x, -u.camera.y) / max(1.0, u.space.y) * 0.72;
  let screen = (input.uv * 2.0 - vec2f(1.0)) * vec2f(aspect, 1.0) + viewPan;
  let viewDir = normalize(vec3f(screen.x * 0.76, -screen.y * 0.76, 1.0));
  let dir = rotateSky(viewDir);
  let lon = atan2(dir.x, dir.z);
  let lat = asin(clamp(dir.y, -1.0, 1.0));
  let sky = vec2f(lon / 6.2831853 + 0.5, lat / 3.1415926 + 0.5);

  let horizon = 1.0 - smoothstep(0.28, 0.96, abs(dir.y));
  let swirlA = sin(lon * 2.0 + lat * 5.8 + time * 0.035);
  let swirlB = cos(lon * 5.0 - lat * 3.1 - time * 0.027);
  let noiseA = valueNoiseWrapped(sky * vec2f(12.0, 6.0) + vec2f(time * 0.006, 0.0), 12.0);
  let noiseB = valueNoiseWrapped(sky * vec2f(31.0, 15.0) - vec2f(0.0, time * 0.004), 31.0);
  let cloud = smoothstep(0.58, 1.28, swirlA * 0.16 + swirlB * 0.12 + noiseA * 0.38 + noiseB * 0.18 + horizon * 0.44);
  let deep = mix(vec3f(0.003, 0.007, 0.015), vec3f(0.012, 0.032, 0.064), horizon * 0.42);
  let cyan = vec3f(0.026, 0.15, 0.28) * cloud * (0.45 + horizon * 0.2);
  let violet = vec3f(0.12, 0.055, 0.22) * smoothstep(0.32, 0.96, swirlB * 0.5 + 0.5) * cloud * 0.12;
  let amber = vec3f(0.22, 0.12, 0.045) * smoothstep(0.5, 0.98, swirlA * 0.5 + 0.5) * cloud * 0.05;

  let uvTiny = sky * vec2f(520.0, 220.0);
  let uvFine = sky * vec2f(340.0, 148.0);
  let uvBright = sky * vec2f(150.0, 68.0) + vec2f(time * 0.0012, 0.0);
  let starTiny = softStar(uvTiny, 520.0, 0.955, 0.09, 0.46);
  let starFine = softStar(uvFine, 340.0, 0.965, 0.12, 0.76);
  let starBright = softStar(uvBright, 150.0, 0.982, 0.16, 0.95);
  let starColor = vec3f(0.95, 0.98, 1.0) * (starTiny + starFine + starBright) + vec3f(1.0, 0.86, 0.64) * starBright * 0.12;
  let vignette = 1.0 - smoothstep(0.72, 1.34, length(screen));
  let color = (deep + cyan + violet + amber) * (0.86 + vignette * 0.14) + starColor;
  return vec4f(min(color, vec3f(1.0)), 1.0);
}
`;

const projectionWGSL = `
struct Uniforms {
  viewport: vec4f,
  camera: vec4f,
  space: vec4f,
  extra: vec4f
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct Projected {
  screen: vec2f,
  perspective: f32,
  depth: f32
};

fn rotateWorld(point: vec3f) -> vec3f {
  let cy = cos(u.camera.z);
  let sy = sin(u.camera.z);
  let cp = cos(u.camera.w);
  let sp = sin(u.camera.w);
  let yawed = vec3f(point.x * cy - point.z * sy, point.y, point.x * sy + point.z * cy);
  return vec3f(yawed.x, yawed.y * cp - yawed.z * sp, yawed.y * sp + yawed.z * cp);
}

fn projectWorld(point: vec3f) -> Projected {
  let rotated = rotateWorld(point - vec3f(u.camera.x, u.camera.y, u.extra.x));
  let depth = max(170.0, u.space.y + rotated.z);
  let perspective = u.space.x / depth;
  let center = u.viewport.xy * 0.5;
  let screen = center + rotated.xy * u.viewport.z * perspective;
  return Projected(screen, perspective, depth);
}
`;

const nodeShader = `
${projectionWGSL}

struct VertexIn {
  @location(0) local: vec2f,
  @location(1) world: vec3f,
  @location(2) radius: f32,
  @location(3) color: vec4f,
  @location(4) kind: f32,
  @location(5) state: f32,
  @location(6) seed: f32,
  @location(7) tilt: f32
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec4f,
  @location(2) kind: f32,
  @location(3) state: f32,
  @location(4) seed: f32,
  @location(5) time: f32,
  @location(6) tilt: f32,
  @location(7) perspective: f32
};

@vertex
fn vs(input: VertexIn) -> VertexOut {
  let time = u.viewport.w;
  var world = input.world;
  if (input.kind < 0.5) {
    world = world + vec3f(
      sin(time * 0.16 + input.seed * 6.283) * 18.0,
      cos(time * 0.12 + input.seed * 5.1) * 12.0,
      sin(time * 0.09 + input.seed * 4.3) * 28.0
    );
  }
  let projected = projectWorld(world);
  var zoom = u.viewport.z;
  if (input.kind < 0.5) {
    zoom = 1.0;
  }
  let radius = input.radius * projected.perspective * zoom;
  let pos = projected.screen + input.local * radius;
  let clip = vec2f(pos.x / u.viewport.x * 2.0 - 1.0, 1.0 - pos.y / u.viewport.y * 2.0);
  var out: VertexOut;
  out.position = vec4f(clip, 0.0, 1.0);
  out.local = input.local;
  out.color = input.color;
  out.kind = input.kind;
  out.state = input.state;
  out.seed = input.seed;
  out.time = time;
  out.tilt = input.tilt;
  out.perspective = projected.perspective;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  if (input.kind > 3.5) {
    let c = cos(input.tilt);
    let s = sin(input.tilt);
    let local = vec2f(input.local.x * c - input.local.y * s, input.local.x * s + input.local.y * c);
    let ringPoint = vec2f(local.x, local.y * 2.65);
    let d = length(ringPoint);
    if (d < 0.63 || d > 1.08 || local.y > 0.18) {
      discard;
    }
    let band = exp(-abs(d - 0.84) * 23.0);
    let shimmer = 0.68 + sin(input.time * 2.1 + input.seed * 8.0 + local.x * 8.0) * 0.18;
    return vec4f(input.color.rgb * (0.74 + input.state * 0.35), band * input.color.a * shimmer);
  }

  let d = length(input.local);
  if (d > 1.0) {
    discard;
  }
  if (input.kind < 0.5) {
    let twinkle = 0.72 + sin(input.time * 1.8 + input.seed * 9.7) * 0.24;
    let alpha = (1.0 - smoothstep(0.16, 1.0, d)) * input.color.a * twinkle;
    return vec4f(input.color.rgb, alpha);
  }

  if (input.kind > 2.5) {
    let logHalo = smoothstep(3.08, 3.22, input.kind);
    let halo = 1.0 - smoothstep(0.08, 1.0, d);
    let core = 1.0 - smoothstep(0.0, 0.48, d);
    let pulse = 0.86 + sin(input.time * 2.2 + input.seed * 6.283) * 0.08;
    let selectedGlow = smoothstep(0.92, 1.0, input.state) * logHalo;
    let alpha = (halo * mix(0.62, 0.98, logHalo) + core * mix(0.2, 0.12, logHalo)) * input.color.a * pulse * (0.72 + input.state * 0.38);
    let color = mix(input.color.rgb, vec3f(1.0, 0.96, 0.86), selectedGlow * 0.28) * (0.74 + core * 0.24 + selectedGlow * 0.18);
    return vec4f(color, alpha);
  }

  if (input.kind > 0.5 && input.kind < 1.5) {
    let plasma = 0.5 + 0.5 * sin((input.local.x * 8.0 + input.local.y * 5.0) + input.time * 1.7 + input.seed * 5.2);
    let core = 1.0 - smoothstep(0.0, 0.26, d);
    let chroma = 1.0 - smoothstep(0.18, 0.92, d);
    let corona = 1.0 - smoothstep(0.38, 1.0, d);
    let pulse = 0.9 + sin(input.time * 2.7 + input.seed * 6.283) * 0.08;
    let alpha = min(0.9, input.color.a * pulse * (core * 0.82 + chroma * 0.38 + corona * 0.1));
    let whiteCore = vec3f(1.0, 0.96, 0.88) * (core * 0.42);
    let plasmaColor = input.color.rgb * (0.62 + plasma * 0.26) + vec3f(0.12, 0.08, 0.14) * corona;
    return vec4f(min(plasmaColor + whiteCore, vec3f(1.0)), alpha);
  }

  if (d > 1.0) {
    discard;
  }
  let z = sqrt(max(0.0, 1.0 - d * d));
  let normal = normalize(vec3f(input.local.x, input.local.y, z));
  let light = normalize(vec3f(-0.62, -0.42, 0.82));
  let diffuse = clamp(dot(normal, light), 0.0, 1.0);
  let rim = pow(1.0 - z, 2.2);
  let bands = 0.5 + 0.5 * sin((input.local.y * 13.0 + input.local.x * 2.2) + input.seed * 8.0 + input.time * 0.16);
  let terrain = 0.5 + 0.5 * sin(input.local.x * 19.0 + input.local.y * 11.0 + input.seed * 13.0);
  let lava = smoothstep(0.72, 0.98, sin(input.local.x * 15.0 - input.local.y * 17.0 + input.seed * 7.0) * 0.5 + 0.5);
  let colorBands = mix(input.color.rgb * (0.64 + bands * 0.36), input.color.rgb + vec3f(0.2, 0.16, 0.08), terrain * 0.2);
  let hot = vec3f(1.0, 0.33, 0.12) * lava * input.state * 0.26;
  let shade = colorBands * (0.24 + diffuse * 0.92) + vec3f(0.78, 0.9, 1.0) * rim * 0.17 + hot;
  let glow = (1.0 - smoothstep(0.72, 1.0, d)) * input.color.a;
  return vec4f(min(shade, vec3f(1.0)), glow);
}
`;

const lineShader = `
${projectionWGSL}

struct LineIn {
  @location(0) start: vec3f,
  @location(1) end: vec3f,
  @location(2) color: vec4f,
  @location(3) lineInfo: vec4f
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) along: f32,
  @location(2) side: f32,
  @location(3) state: f32,
  @location(4) seed: f32,
  @location(5) time: f32
};

fn lineCorner(index: u32) -> vec2f {
  var corner = vec2f(0.0, -1.0);
  if (index == 1u) {
    corner = vec2f(1.0, -1.0);
  }
  if (index == 2u) {
    corner = vec2f(1.0, 1.0);
  }
  if (index == 3u) {
    corner = vec2f(0.0, -1.0);
  }
  if (index == 4u) {
    corner = vec2f(1.0, 1.0);
  }
  if (index == 5u) {
    corner = vec2f(0.0, 1.0);
  }
  return corner;
}

@vertex
fn vs(input: LineIn, @builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  let a = projectWorld(input.start);
  let b = projectWorld(input.end);
  let corner = lineCorner(vertexIndex);
  let delta = b.screen - a.screen;
  let dir = normalize(delta + vec2f(0.0001, 0.0001));
  let normal = vec2f(-dir.y, dir.x);
  let width = input.lineInfo.x * mix(a.perspective, b.perspective, corner.x) * u.viewport.z;
  let screen = mix(a.screen, b.screen, corner.x) + normal * corner.y * width;
  let clip = vec2f(screen.x / u.viewport.x * 2.0 - 1.0, 1.0 - screen.y / u.viewport.y * 2.0);
  var out: VertexOut;
  out.position = vec4f(clip, 0.0, 1.0);
  out.color = input.color;
  out.along = corner.x;
  out.side = corner.y;
  out.state = input.lineInfo.y;
  out.seed = input.lineInfo.z;
  out.time = u.viewport.w;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let wave = fract(input.along * 3.4 - input.time * (0.58 + input.state * 0.32) + input.seed);
  let flow = smoothstep(0.70, 0.9, wave) * (1.0 - smoothstep(0.9, 1.0, wave));
  let core = 1.0 - smoothstep(0.2, 1.0, input.side);
  let alpha = min(1.0, input.color.a * (0.46 + core * 0.42) + flow * (0.1 + input.state * 0.55));
  let color = input.color.rgb + vec3f(0.32, 0.5, 0.62) * flow * (0.34 + input.state);
  return vec4f(color, alpha);
}
`;
</script>

<template>
  <div ref="wrap" class="canvas-wrap webgpu-wrap nebula-interactive-surface" :class="{ fullscreen }">
    <canvas
      ref="canvas"
      class="nebula-canvas webgpu-canvas"
      @pointerenter="updateNebulaCursor"
      @pointerleave="hideNebulaCursor"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @dblclick="onDoubleClick"
      @contextmenu.prevent
      @wheel="onWheel"
    ></canvas>
    <div
      class="nebula-star-cursor"
      :class="{ visible: nebulaCursor.visible }"
      :style="{ transform: `translate(${nebulaCursor.x}px, ${nebulaCursor.y}px) rotate(${nebulaCursor.angle}rad)` }"
    ></div>
    <slot name="overlay"></slot>

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

    <div v-if="!webgpuReady || webgpuError" class="webgpu-status">
      {{ webgpuError || webgpuMessage }}
    </div>
    <button
      class="webgpu-icon-toggle"
      type="button"
      :title="fullscreen ? '退出全屏' : '全屏'"
      :aria-label="fullscreen ? '退出全屏' : '全屏'"
      @click="toggleFullscreen"
    >
      <Minimize2 v-if="fullscreen" :size="16" />
      <Maximize2 v-else :size="16" />
    </button>
    <button class="webgpu-heat-toggle" :class="{ active: heatMode }" type="button" @click="heatMode = !heatMode">
      热力
    </button>
    <div class="webgpu-hud">WebGPU 3D 星系 · Shader 星云 · GPU 恒星/行星 · 空间能量线 · 左/右键旋转 · 中键平移</div>
  </div>
</template>
