<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Maximize2, Minimize2 } from 'lucide-vue-next';
import type { GraphData, LayoutMode, LogEntry } from '../types/domain';

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
  heatFlat: boolean;
}

const props = defineProps<{
  graph: GraphData;
  layoutMode: LayoutMode;
  activeTagIds: Set<number>;
  selectedLogId: number | null;
  priorityTagIds?: number[];
}>();

const emit = defineEmits<{
  tagToggle: [tagId: number];
  tagContext: [payload: { tagId: number; x: number; y: number; width: number; height: number }];
  logOpen: [logId: number];
  logInspect: [payload: { logId: number; x: number; y: number; width: number; height: number }];
  layoutDirty: [dirty: boolean];
}>();

const FOCAL_LENGTH = 740;
const VIEW_DISTANCE = 980;
const UNIFORM_BYTE_SIZE = 80;

const wrap = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const labels = ref<LabelItem[]>([]);
const webgpuReady = ref(false);
const webgpuMessage = ref('正在初始化 WebGPU...');
const webgpuError = ref('');
const heatMode = ref(false);
const fullscreen = ref(false);
const transform = reactive({ scale: 1, x: 0, y: 0 });
const camera = reactive({ yaw: 0, pitch: 0, panX: 0, panY: 0, panZ: 0 });
const nebulaCursor = reactive({ x: 0, y: 0, visible: false, angle: -0.2, target: 0 });

const tagPositions = new Map<number, LayoutPoint>();
const logPositions = new Map<number, LayoutPoint>();
const manualTagPositions = new Map<number, { x: number; y: number }>();
const manualLogPositions = new Map<number, { x: number; y: number }>();
const pickNodes: PickNode[] = [];
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

const priorityRankByTagId = computed(() => {
  const ids = props.priorityTagIds ?? [];
  return new Map(ids.map((id, index) => [id, index]));
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
let postPipeline: any = null;
let postBindGroupLayout: any = null;
let postBindGroup: any = null;
let postSampler: any = null;
let sceneTexture: any = null;
let sceneView: any = null;
let sceneTextureWidth = 0;
let sceneTextureHeight = 0;
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
let pendingFitAllFrontView = true;
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
  } else if (pendingFitAllFrontView) {
    pendingFitAllFrontView = !fitAllTagsFrontView();
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
  () => [props.graph.map.id, props.layoutMode],
  () => {
    pendingFitAllFrontView = true;
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
  () => {
    updateLabels();
  },
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
    size: UNIFORM_BYTE_SIZE,
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
  postBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: shaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: shaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: shaderStage.FRAGMENT, buffer: { type: 'uniform' } }
    ]
  });
  const postPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [postBindGroupLayout] });
  postSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear'
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
  postPipeline = await createPipeline('WebGPU bloom postprocess', {
    layout: postPipelineLayout,
    vertex: {
      module: await createShaderModule('WebGPU bloom shader', postShader),
      entryPoint: 'vs'
    },
    fragment: {
      module: await createShaderModule('WebGPU bloom shader', postShader),
      entryPoint: 'fs',
      targets: [{ format }]
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
  ensureSceneTarget(canvas.value.width, canvas.value.height);
  updateLabels();
}

function ensureSceneTarget(width: number, height: number) {
  if (!device || !postBindGroupLayout || !postSampler || !format) {
    return;
  }
  if (sceneTexture && sceneTextureWidth === width && sceneTextureHeight === height) {
    return;
  }
  sceneTexture?.destroy?.();
  const textureUsage = (globalThis as any).GPUTextureUsage;
  sceneTexture = device.createTexture({
    size: { width, height },
    format,
    usage: textureUsage.RENDER_ATTACHMENT | textureUsage.TEXTURE_BINDING
  });
  sceneView = sceneTexture.createView();
  postBindGroup = device.createBindGroup({
    layout: postBindGroupLayout,
    entries: [
      { binding: 0, resource: postSampler },
      { binding: 1, resource: sceneView },
      { binding: 2, resource: { buffer: uniformBuffer } }
    ]
  });
  sceneTextureWidth = width;
  sceneTextureHeight = height;
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
    tagGroups: (props.graph.tagGroups ?? []).map((group) => ({ ...group, tagIds: [...group.tagIds] })),
    layoutMode: props.layoutMode,
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
  const cursorVisible = nebulaCursor.visible ? 1 : 0;
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
      0,
      nebulaCursor.x,
      nebulaCursor.y,
      cursorVisible,
      nebulaCursor.target
    ])
  );

  device.pushErrorScope?.('validation');
  try {
    ensureSceneTarget(canvas.value.width, canvas.value.height);
    if (!sceneView || !postPipeline || !postBindGroup) {
      return;
    }
    const encoder = device.createCommandEncoder();
    const outputView = context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: sceneView,
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

    const postPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: outputView,
          clearValue: { r: 0.01, g: 0.018, b: 0.034, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });
    postPass.setPipeline(postPipeline);
    postPass.setBindGroup(0, postBindGroup);
    postPass.draw(3);
    postPass.end();
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
    if (!isTagVisible(tag.id)) {
      continue;
    }
    const heat = heatState(tag.id);
    const heatPower = heatIntensity(tag.id);
    const color = heatMode.value ? heatColor(heat, heatPower) : hexToRgb(tag.color);
    const active = props.activeTagIds.has(tag.id);
    const relatedToSelected = isTagRelatedToSelectedLog(tag.id);
    const related =
      !hasActiveRelationMode() ||
      active ||
      relatedToSelected ||
      props.graph.logs.some((log) => isLogHighlighted(log) && log.tags.some((item) => item.id === tag.id));
    const flatHeat = heatMode.value && heat === 'flat';
    const state = heatMode.value ? (flatHeat ? 0.28 : 1) : active || relatedToSelected ? 1 : related ? 0.62 : 0.18;
    const depth = 0.92 + seeded(tag.id + 2200) * 0.22;
    const priority = tagPriority(tag.id);
    const priorityScale = hasTagPriority() ? 0.88 + priority * 0.36 : 1;
    const priorityAlpha = hasTagPriority() ? 0.72 + priority * 0.36 : 1;
    const activeScale = active || relatedToSelected ? 1.22 : related ? 1 : 0.92;
    const coreRadius = point.r * 1.38 * depth * activeScale * priorityScale;
    const world = tagPoint3D(tag.id, point);
    pushNodeInstance(
      nodeRows,
      world,
      coreRadius * (active || relatedToSelected ? 1.44 : 1.12),
      3,
      color,
      (flatHeat ? (active || relatedToSelected ? 0.08 : related ? 0.035 : 0.018) : active || relatedToSelected ? 0.18 : related ? 0.06 : 0.025) * priorityAlpha,
      state,
      seeded(tag.id + 700),
      0
    );
    pushNodeInstance(
      nodeRows,
      world,
      coreRadius * (active || relatedToSelected ? 1.82 : 1.48),
      1,
      color,
      (flatHeat ? (active || relatedToSelected ? 0.56 : related ? 0.38 : 0.24) : active || relatedToSelected ? 1 : related ? 0.92 : 0.46) * priorityAlpha,
      state,
      seeded(tag.id + 800),
      0
    );
  }

  for (const log of props.graph.logs) {
    const point = logPositions.get(log.id);
    if (!point) {
      continue;
    }
    if (!isLogVisible(log)) {
      continue;
    }
    const selected = props.selectedLogId === log.id;
    const highlighted = isLogHighlighted(log);
    const muted = props.activeTagIds.size === 0 && hasActiveRelationMode() && !selected && !highlighted;
    const state = selected ? 1 : highlighted ? 0.92 : muted ? 0.08 : 0.38;
    const radius = selected ? 15.2 : highlighted ? 14.4 : 8.8;
    const haloAlpha = selected ? 0.76 : highlighted ? 0.68 : muted ? 0.035 : 0.24;
    const ringAlpha = selected ? 0.96 : highlighted ? 0.9 : muted ? 0.045 : 0.34;
    const coreAlpha = selected ? 1 : highlighted ? 1 : muted ? 0.28 : 0.72;
    const logColor = logVisualRgb(log);
    const world = logPoint3D(log, point);
    const seed = seeded(log.id + 1900);
    const tilt = seeded(log.id + 341) * 1.1 - 0.55;
    pushNodeInstance(
      nodeRows,
      world,
      radius * (selected ? 3.55 : highlighted ? 3.35 : 2.28),
      3.32,
      mixColor(logColor, { r: 0.46, g: 0.92, b: 1 }, 0.32),
      haloAlpha,
      state,
      seeded(log.id + 2110),
      tilt
    );
    pushNodeInstance(
      nodeRows,
      world,
      radius * (selected ? 2.72 : highlighted ? 2.54 : 1.66),
      4.15,
      mixColor(logColor, { r: 0.98, g: 0.28, b: 0.92 }, 0.36),
      ringAlpha,
      state,
      seeded(log.id + 1600),
      tilt
    );
    pushNodeInstance(nodeRows, world, radius * (selected || highlighted ? 1.08 : 0.78), 2, mixColor(logColor, { r: 0.86, g: 0.98, b: 1 }, 0.28), coreAlpha, state, seed, tilt);
  }
  nodeCount = Math.max(0, nodeRows.length / 12 - starCount);
  writeDynamicBuffer('node', new Float32Array(nodeRows), 48);

  const lineRows: number[] = [];
  if (hasActiveRelationMode()) {
    for (const edge of props.graph.edges) {
      const tagPoint = tagPositions.get(edge.tagId);
      const logPoint = logPositions.get(edge.logId);
      const logEntry = props.graph.logs.find((item) => item.id === edge.logId);
      if (!tagPoint || !logPoint || !logEntry) {
        continue;
      }
      const relation = relationFlowState(edge.tagId, logEntry);
      if (!relation.visible) {
        continue;
      }
      const tagMeta = props.graph.tags.find((item) => item.id === edge.tagId);
      const tagColor = tagMeta ? hexToRgb(tagMeta.color) : { r: 0.38, g: 0.84, b: 1 };
      const neonColor = edgeNeonColor(tagColor);
      const color = [
        neonColor.r,
        neonColor.g,
        neonColor.b,
        relation.selected ? 0.8 : 0.64
      ];
      pushLineInstance(
        lineRows,
        tagPoint3D(edge.tagId, tagPoint),
        logPoint3D(logEntry, logPoint),
        color,
        relation.selected ? 6.4 : 4.6,
        relation.selected ? 1 : 0.72,
        seeded(edge.tagId * 31 + edge.logId)
      );
    }
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

function isLogVisible(log: LogEntry) {
  const tagModeActive = props.activeTagIds.size > 0;
  const logModeActive = props.selectedLogId !== null;
  if (!tagModeActive && !logModeActive) {
    return true;
  }
  const visibleByTags = tagModeActive && isLogHighlighted(log);
  const visibleBySelectedLog = logModeActive && props.selectedLogId === log.id;
  return visibleByTags || visibleBySelectedLog;
}

function isTagVisible(tagId: number) {
  const tagModeActive = props.activeTagIds.size > 0;
  const logModeActive = props.selectedLogId !== null;
  if (!tagModeActive && !logModeActive) {
    return true;
  }
  const visibleByTags =
    tagModeActive &&
    (props.activeTagIds.has(tagId) ||
      props.graph.logs.some((log) => isLogHighlighted(log) && log.tags.some((tag) => tag.id === tagId)));
  const visibleBySelectedLog = logModeActive && isTagRelatedToSelectedLog(tagId);
  return visibleByTags || visibleBySelectedLog;
}

function hasActiveRelationMode() {
  return props.activeTagIds.size > 0 || props.selectedLogId !== null;
}

function isTagRelatedToSelectedLog(tagId: number) {
  const selectedLog = props.graph.logs.find((log) => log.id === props.selectedLogId);
  return Boolean(selectedLog?.tags.some((tag) => tag.id === tagId));
}

function relationFlowState(tagId: number, log: LogEntry) {
  const selected = props.selectedLogId === log.id;
  const active = props.activeTagIds.has(tagId) && isLogHighlighted(log);
  return { visible: (selected && isLogVisible(log) && isTagVisible(tagId)) || active, selected };
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
  const cursor = canvasPointFromPointer(event);
  const picked = pickNodeAt(cursor.x, cursor.y);
  const canDragNode = event.button === 0;
  if (canDragNode && picked?.kind === 'tag') {
    dragSnapshot = captureManualPositions();
    const current = tagPositions.get(picked.id);
    dragWorldZ = tagDepth(picked.id);
    const point = screenToWorldAtDepth(cursor.x, cursor.y, dragWorldZ);
    dragMode = 'tag';
    dragTagId = picked.id;
    dragTagOffset = {
      x: (current?.x ?? point.x) - point.x,
      y: (current?.y ?? point.y) - point.y
    };
  } else if (canDragNode && picked?.kind === 'log') {
    dragSnapshot = captureManualPositions();
    const current = logPositions.get(picked.id);
    const log = props.graph.logs.find((item) => item.id === picked.id);
    dragWorldZ = log && current ? logPoint3D(log, current).z : 0;
    const point = screenToWorldAtDepth(cursor.x, cursor.y, dragWorldZ);
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
    const cursor = canvasPointFromPointer(event);
    const point = screenToWorldAtDepth(cursor.x, cursor.y, dragWorldZ);
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
    const cursor = canvasPointFromPointer(event);
    const point = screenToWorldAtDepth(cursor.x, cursor.y, dragWorldZ);
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
    orbitCameraByScreenDelta(dx, dy);
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
  if (button !== 0 && button !== 2) {
    return;
  }
  const cursor = canvasPointFromPointer(event);
  const picked = pickNodeAt(cursor.x, cursor.y);
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

function onLabelPointerDown(tagId: number, event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  updateNebulaCursor(event);
  cameraTarget = null;
  isDragging = true;
  dragMode = event.button === 1 ? 'pan' : 'tag';
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
  if (event.button === 0) {
    dragSnapshot = captureManualPositions();
    const cursor = canvasPointFromPointer(event);
    const current = tagPositions.get(tagId);
    dragWorldZ = tagDepth(tagId);
    const point = screenToWorldAtDepth(cursor.x, cursor.y, dragWorldZ);
    dragMode = 'tag';
    dragTagId = tagId;
    dragTagOffset = {
      x: (current?.x ?? point.x) - point.x,
      y: (current?.y ?? point.y) - point.y
    };
  }
  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
}

function onLabelPointerUp(tagId: number, event: PointerEvent, cancelled = false) {
  event.preventDefault();
  event.stopPropagation();
  updateNebulaCursor(event);
  (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
  const button = dragButton;
  const didMove = moved;
  isDragging = false;
  dragMode = null;
  dragTagId = null;
  dragLogId = null;
  dragWorldZ = 0;
  dragButton = 0;
  if (!cancelled && !didMove && button === 0) {
    emit('tagToggle', tagId);
  } else if (!cancelled && didMove && button === 0) {
    pushLayoutHistory(dragSnapshot);
    emit('layoutDirty', true);
    requestLayout();
  }
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  if (isDragging || performance.now() - lastPanInteractionAt < 220) {
    return;
  }
  cameraTarget = null;
  const wheelDelta = normalizeWheelDelta(event);
  const zoom = clamp(Math.exp(-wheelDelta * 0.0012), 0.76, 1.32);
  transform.scale = Math.min(2.55, Math.max(0.42, transform.scale * zoom));
  updateLabels();
}

function panCameraByScreenDelta(dx: number, dy: number) {
  const focus = worldFocusAtCanvasCenter();
  const depth = focus ? projectWorldToScreen(focus).depth : VIEW_DISTANCE;
  const delta = cameraPanDeltaForScreenShift(dx, dy, transform.scale, depth);
  camera.panX += delta.x;
  camera.panY += delta.y;
  camera.panZ += delta.z;
}

function orbitCameraByScreenDelta(dx: number, dy: number) {
  camera.yaw += dx * 0.004;
  camera.pitch = clamp(camera.pitch + dy * 0.003, -0.82, 0.58);
}

function worldFocusAtCanvasCenter(): Point3D | null {
  if (!canvas.value) {
    return null;
  }
  return { x: camera.panX, y: camera.panY, z: camera.panZ };
}

function normalizeWheelDelta(event: WheelEvent) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * 240;
  }
  return event.deltaY;
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
  const point = canvasPointFromPointer(event);
  const dx = point.x - nebulaCursor.x;
  const dy = point.y - nebulaCursor.y;
  if (Math.abs(dx) + Math.abs(dy) > 1) {
    nebulaCursor.angle = Math.atan2(dy, dx);
  }
  nebulaCursor.x = point.x;
  nebulaCursor.y = point.y;
  nebulaCursor.target = pickNodeAt(point.x, point.y) ? 1 : 0;
  nebulaCursor.visible = true;
}

function canvasPointFromPointer(event: PointerEvent | MouseEvent) {
  if (!canvas.value) {
    return { x: 'offsetX' in event ? event.offsetX : 0, y: 'offsetY' in event ? event.offsetY : 0 };
  }
  const rect = canvas.value.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function hideNebulaCursor() {
  nebulaCursor.visible = false;
  nebulaCursor.target = 0;
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

function inspectTagLabel(tagId: number, event: MouseEvent) {
  const rect = canvas.value?.getBoundingClientRect();
  emit('tagContext', {
    tagId,
    x: rect ? event.clientX - rect.left : event.clientX,
    y: rect ? event.clientY - rect.top : event.clientY,
    width: rect?.width ?? window.innerWidth,
    height: rect?.height ?? window.innerHeight
  });
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

function focusLog(logId: number) {
  if (!canvas.value) {
    return null;
  }
  const point = logPositions.get(logId);
  const log = props.graph.logs.find((item) => item.id === logId);
  if (!point || !log) {
    requestLayout();
    return null;
  }
  const rect = canvas.value.getBoundingClientRect();
  const nextScale = Math.max(transform.scale, 1.2);
  const world = logPoint3D(log, point);
  const base = projectWorldToScreen(world, nextScale);
  const delta = cameraPanDeltaForScreenShift(rect.width / 2 - base.x, rect.height / 2 - base.y, nextScale, base.depth);
  cameraTarget = null;
  transform.scale = nextScale;
  camera.panX += delta.x;
  camera.panY += delta.y;
  camera.panZ += delta.z;
  updateLabels();
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
    if (!isTagVisible(tag.id)) {
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
        color: heatMode.value ? heatLabelColor(heat, heatIntensity(tag.id)) : tag.color,
        active,
        heat,
        heatFlat: heatMode.value && heat === 'flat'
      });
    }
  }

  for (const log of props.graph.logs) {
    const point = logPositions.get(log.id);
    if (!point) {
      continue;
    }
    if (!isLogVisible(log)) {
      continue;
    }
    const screen = projectWorldToScreen(logPoint3D(log, point));
    const selected = props.selectedLogId === log.id;
    const highlighted = isLogHighlighted(log);
    const radius = Math.max(15, (highlighted || selected ? 13 : 10) * transform.scale * screen.perspective);
    if (screen.x > -90 && screen.x < rect.width + 90 && screen.y > -90 && screen.y < rect.height + 90) {
      pickNodes.push({ kind: 'log', id: log.id, x: screen.x, y: screen.y, r: radius + 8 });
    }
  }

  labels.value = nextLabels;
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
  pendingFitAllFrontView = true;
  requestLayout();
}

function refreshLayout() {
  pendingFitAllFrontView = true;
  requestLayout();
  updateLabels();
}

function worldToScreen(x: number, y: number) {
  return projectWorldToScreen({ x, y, z: 0 });
}

function fitAllTagsFrontView() {
  if (!canvas.value || tagPositions.size === 0) {
    if (tagPositions.size === 0) {
      cameraTarget = null;
      transform.scale = 1;
      camera.yaw = 0;
      camera.pitch = 0;
      camera.panX = 0;
      camera.panY = 0;
      camera.panZ = 0;
    }
    return Boolean(canvas.value);
  }

  const rect = canvas.value.getBoundingClientRect();
  const points = [...tagPositions.values()];
  const minX = Math.min(...points.map((point) => point.x - point.r * 2.2));
  const maxX = Math.max(...points.map((point) => point.x + point.r * 2.2));
  const minY = Math.min(...points.map((point) => point.y - point.r * 3.1));
  const maxY = Math.max(...points.map((point) => point.y + point.r * 3.4));
  const worldWidth = Math.max(1, maxX - minX);
  const worldHeight = Math.max(1, maxY - minY);
  const projection = FOCAL_LENGTH / VIEW_DISTANCE;
  const availableWidth = Math.max(240, rect.width - 128);
  const availableHeight = Math.max(180, rect.height - 112);
  const nextScale = Math.min(1.18, Math.max(0.38, Math.min(availableWidth / (worldWidth * projection), availableHeight / (worldHeight * projection))));

  cameraTarget = null;
  transform.scale = nextScale;
  camera.yaw = 0;
  camera.pitch = 0;
  camera.panX = (minX + maxX) / 2;
  camera.panY = (minY + maxY) / 2;
  camera.panZ = 0;
  return true;
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

function hasTagPriority() {
  return (props.priorityTagIds?.length ?? 0) > 1;
}

function tagPriority(tagId: number) {
  const total = props.priorityTagIds?.length ?? 0;
  if (total <= 1) {
    return 0.5;
  }
  const rank = priorityRankByTagId.value.get(tagId);
  if (rank === undefined) {
    return 0;
  }
  return 1 - rank / Math.max(1, total - 1);
}

function tagDepth(tagId: number) {
  const priorityDepth = hasTagPriority() ? (0.5 - tagPriority(tagId)) * 420 : 0;
  return (seeded(tagId + 4321) - 0.5) * 320 + priorityDepth;
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

function heatIntensity(tagId: number) {
  const item = tagTrendById.value.get(tagId);
  if (!item) {
    return 0;
  }
  const delta = item.current - item.previous;
  if (!(delta > 0 || (item.previous > 0 && delta < 0))) {
    return 0;
  }
  const absoluteDelta = Math.abs(delta);
  if (absoluteDelta >= 4) {
    return 1;
  }
  if (absoluteDelta >= 2) {
    return 0.66;
  }
  return 0.32;
}

function heatColor(heat: 'up' | 'down' | 'flat', intensity = 0) {
  const power = 0.32 + intensity * 0.68;
  if (heat === 'up') {
    return mixColor({ r: 1, g: 0.76, b: 0.54 }, { r: 1, g: 0.24, b: 0.08 }, power);
  }
  if (heat === 'down') {
    return mixColor({ r: 0.58, g: 0.84, b: 1 }, { r: 0.04, g: 0.34, b: 1 }, power);
  }
  return { r: 0.9, g: 0.95, b: 1 };
}

function heatLabelColor(heat: 'up' | 'down' | 'flat', intensity = 0) {
  if (heat === 'flat') {
    return 'rgba(232, 243, 255, 0.56)';
  }
  return rgbToCss(heatColor(heat, intensity));
}

function rgbToCss(color: { r: number; g: number; b: number }) {
  return `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
}

function edgeNeonColor(color: { r: number; g: number; b: number }) {
  const maxChannel = Math.max(color.r, color.g, color.b, 0.001);
  const boost = Math.max(1, 0.92 / maxChannel);
  return {
    r: clamp(color.r * boost, 0, 1),
    g: clamp(color.g * boost, 0, 1),
    b: clamp(color.b * boost, 0, 1)
  };
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
  let backgroundZoom = clamp(1.0 + (u.viewport.z - 1.0) * 0.18, 0.86, 1.28);
  let viewPan = vec2f(u.camera.x, -u.camera.y) / max(1.0, u.space.y) * 0.72;
  let screen = ((input.uv * 2.0 - vec2f(1.0)) * vec2f(aspect, 1.0) + viewPan) / backgroundZoom;
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

  let starSky = (sky - vec2f(0.5)) / backgroundZoom + vec2f(0.5);
  let uvTiny = starSky * vec2f(520.0, 220.0);
  let uvFine = starSky * vec2f(340.0, 148.0);
  let uvBright = starSky * vec2f(150.0, 68.0) + vec2f(time * 0.0012, 0.0);
  let starTiny = softStar(uvTiny, 520.0, 0.955, 0.09, 0.46);
  let starFine = softStar(uvFine, 340.0, 0.965, 0.12, 0.76);
  let starBright = softStar(uvBright, 150.0, 0.982, 0.16, 0.95);
  let starColor = vec3f(0.95, 0.98, 1.0) * (starTiny + starFine + starBright) + vec3f(1.0, 0.86, 0.64) * starBright * 0.12;
  let vignette = 1.0 - smoothstep(0.72, 1.34, length(screen));
  let color = (deep + cyan + violet + amber) * (0.86 + vignette * 0.14) + starColor;
  return vec4f(min(color, vec3f(1.0)), 1.0);
}
`;

const postShader = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
};

@group(0) @binding(0) var sceneSampler: sampler;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;

struct PostUniforms {
  viewport: vec4f,
  camera: vec4f,
  space: vec4f,
  extra: vec4f,
  cursor: vec4f
};

@group(0) @binding(2) var<uniform> u: PostUniforms;

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(3.0, 1.0),
    vec2f(-1.0, 1.0)
  );
  let p = pos[vertexIndex];
  var out: VertexOut;
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = p * vec2f(0.5, -0.5) + vec2f(0.5);
  return out;
}

fn sampleScene(uv: vec2f) -> vec3f {
  return textureSample(sceneTexture, sceneSampler, clamp(uv, vec2f(0.0), vec2f(1.0))).rgb;
}

fn brightPart(color: vec3f) -> vec3f {
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  let factor = smoothstep(0.25, 0.86, luma);
  return color * factor;
}

fn ringMask(distance: f32, radius: f32, width: f32) -> f32 {
  return 1.0 - smoothstep(width * 0.36, width, abs(distance - radius));
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  let dims = textureDimensions(sceneTexture);
  let texel = 1.0 / vec2f(f32(dims.x), f32(dims.y));
  let center = sampleScene(input.uv);
  var bloom = brightPart(center) * 0.28;
  bloom += brightPart(sampleScene(input.uv + texel * vec2f(1.5, 0.0))) * 0.11;
  bloom += brightPart(sampleScene(input.uv + texel * vec2f(-1.5, 0.0))) * 0.11;
  bloom += brightPart(sampleScene(input.uv + texel * vec2f(0.0, 1.5))) * 0.11;
  bloom += brightPart(sampleScene(input.uv + texel * vec2f(0.0, -1.5))) * 0.11;
  bloom += brightPart(sampleScene(input.uv + texel * vec2f(2.4, 2.4))) * 0.07;
  bloom += brightPart(sampleScene(input.uv + texel * vec2f(-2.4, 2.4))) * 0.07;
  bloom += brightPart(sampleScene(input.uv + texel * vec2f(2.4, -2.4))) * 0.07;
  bloom += brightPart(sampleScene(input.uv + texel * vec2f(-2.4, -2.4))) * 0.07;
  var color = center * 0.96 + bloom * 0.52;
  let cursorVisible = clamp(u.cursor.z, 0.0, 1.0);
  let cursorTarget = clamp(u.cursor.w, 0.0, 1.0);
  let pixel = input.uv * max(u.viewport.xy, vec2f(1.0));
  let delta = pixel - u.cursor.xy;
  let d = length(delta);
  let ringPulse = 0.5 + 0.5 * sin(u.viewport.w * 2.2);
  let ring = ringMask(d, 8.4 + ringPulse * 0.45 + cursorTarget * 0.9, 0.95) * (0.28 + cursorTarget * 0.16)
    + ringMask(d, 14.2 + cursorTarget * 1.2, 1.35) * cursorTarget * 0.12;
  let ax = abs(delta.x);
  let ay = abs(delta.y);
  let tickX = (1.0 - smoothstep(0.8, 2.0, ay)) * smoothstep(5.2, 6.4, ax) * (1.0 - smoothstep(10.2, 11.7, ax));
  let tickY = (1.0 - smoothstep(0.8, 2.0, ax)) * smoothstep(5.2, 6.4, ay) * (1.0 - smoothstep(10.2, 11.7, ay));
  let ticks = (tickX + tickY) * (0.28 + cursorTarget * 0.18);
  let core = exp(-d * 0.4) * 0.22 + (1.0 - smoothstep(0.0, 2.0, d)) * (0.52 + cursorTarget * 0.18);
  let targetAura = exp(-d * 0.12) * cursorTarget * 0.08;
  let probeCyan = vec3f(0.02, 0.95, 1.0);
  let probeMagenta = vec3f(1.0, 0.22, 0.92);
  let probeWhite = vec3f(1.0, 0.96, 0.82);
  let probeColor = mix(probeCyan, probeMagenta, ringPulse * 0.12 + cursorTarget * 0.18);
  color += cursorVisible * (probeColor * (ring + ticks + targetAura) + probeWhite * core);
  let vignette = 1.0 - smoothstep(0.58, 1.25, length(input.uv - vec2f(0.5)));
  let graded = pow(min(color, vec3f(1.0)), vec3f(0.94));
  return vec4f(min(graded * (0.96 + vignette * 0.05), vec3f(1.0)), 1.0);
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
    let diskPoint = vec2f(local.x * 0.88, local.y * 1.42);
    let d = length(diskPoint);
    if (d > 1.0) {
      discard;
    }
    let angle = atan2(diskPoint.y, diskPoint.x);
    let spiralPhase = angle * 2.0 + d * 8.6 - input.time * 0.78 + input.seed * 6.283;
    let spiral = 0.5 + 0.5 * sin(spiralPhase);
    let arms = smoothstep(0.62, 0.98, spiral) * smoothstep(0.05, 0.18, d) * (1.0 - smoothstep(0.76, 1.0, d));
    let opposite = smoothstep(0.68, 0.99, 0.5 + 0.5 * sin(spiralPhase + 3.14159)) * smoothstep(0.08, 0.24, d) * (1.0 - smoothstep(0.64, 0.98, d));
    let diskGlow = (1.0 - smoothstep(0.14, 1.0, d)) * 0.24;
    let rim = exp(-abs(d - 0.72) * 10.0) * 0.18;
    let wake = smoothstep(0.78, 0.12, abs(local.y)) * smoothstep(0.88, -0.45, local.x) * (1.0 - smoothstep(0.54, 1.08, d)) * 0.22;
    let spark = exp(-length(vec2f(local.x - 0.3, local.y * 1.65)) * 8.0) * 0.34;
    let dust = smoothstep(0.82, 0.99, 0.5 + 0.5 * sin(angle * 9.0 + d * 17.0 + input.seed * 12.0)) * (1.0 - smoothstep(0.2, 0.98, d)) * 0.12;
    let shimmer = 0.88 + sin(input.time * 2.0 + input.seed * 6.0 + angle * 2.0) * 0.1;
    let alpha = (arms * 1.08 + opposite * 0.7 + diskGlow + rim + wake + spark + dust * 1.24) * input.color.a * shimmer * (0.72 + input.state * 0.42);
    let cyan = vec3f(0.04, 0.96, 1.0);
    let magenta = vec3f(1.0, 0.22, 0.9);
    let violet = vec3f(0.52, 0.34, 1.0);
    let armColor = mix(cyan, magenta, smoothstep(0.12, 0.92, d));
    let color = mix(input.color.rgb, mix(armColor, violet, opposite * 0.32), 0.7 + input.state * 0.14);
    return vec4f(min(color + vec3f(1.0, 0.86, 0.98) * (dust * 0.2 + spark * 0.36), vec3f(1.0)), min(1.0, alpha));
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
    let logHalo = smoothstep(3.08, 3.28, input.kind);
    let angle = atan2(input.local.y, input.local.x);
    let spiral = 0.5 + 0.5 * sin(angle * 3.0 + d * 10.5 - input.time * 0.8 + input.seed * 6.283);
    let arms = smoothstep(0.62, 0.98, spiral) * (1.0 - smoothstep(0.12, 0.94, d)) * logHalo;
    let halo = 1.0 - smoothstep(0.08, 1.0, d);
    let inner = 1.0 - smoothstep(0.0, 0.4, d);
    let pulse = 0.88 + sin(input.time * 1.9 + input.seed * 6.283) * 0.08;
    let selectedGlow = smoothstep(0.92, 1.0, input.state) * logHalo;
    let flare = exp(-abs(input.local.y) * 5.2) * (1.0 - smoothstep(0.3, 1.0, abs(input.local.x))) * 0.24 * logHalo;
    let alpha = (halo * mix(0.36, 0.78, logHalo) + arms * 0.56 + flare + inner * mix(0.1, 0.24, logHalo)) * input.color.a * pulse * (0.68 + input.state * 0.42);
    let dream = mix(vec3f(0.08, 0.9, 1.0), vec3f(0.98, 0.2, 0.88), spiral);
    let color = mix(input.color.rgb, dream, logHalo * (0.34 + arms * 0.44 + selectedGlow * 0.14));
    return vec4f(min(color * (0.86 + selectedGlow * 0.2) + vec3f(1.0) * inner * selectedGlow * 0.18, vec3f(1.0)), min(1.0, alpha));
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

  let c = cos(input.tilt);
  let s = sin(input.tilt);
  let local = vec2f(input.local.x * c - input.local.y * s, input.local.x * s + input.local.y * c);
  let angle = atan2(local.y, local.x);
  let core = 1.0 - smoothstep(0.0, 0.32, d);
  let glow = 1.0 - smoothstep(0.16, 0.94, d);
  let ripple = exp(-abs(d - (0.5 + sin(input.time * 0.85 + input.seed * 6.283) * 0.035)) * 20.0);
  let swirl = 0.5 + 0.5 * sin(angle * 3.5 + d * 9.0 - input.time * 0.9 + input.seed * 7.0);
  let neon = mix(vec3f(0.1, 0.94, 1.0), vec3f(0.96, 0.24, 1.0), swirl);
  let alpha = (core * 1.0 + glow * 0.4 + ripple * 0.28) * input.color.a * (0.78 + input.state * 0.34);
  let color = mix(input.color.rgb, neon, 0.5 + ripple * 0.2) + vec3f(1.0, 0.98, 0.9) * core * 0.42;
  return vec4f(min(color, vec3f(1.0)), min(1.0, alpha));
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
  let fade = smoothstep(0.02, 0.16, input.along) * (1.0 - smoothstep(0.84, 0.99, input.along));
  let flow = input.along * (5.2 + input.state * 1.25) - input.time * (0.52 + input.state * 0.34) + input.seed;
  let wave = fract(flow);
  let bead = smoothstep(0.5, 0.68, wave) * (1.0 - smoothstep(0.68, 0.92, wave));
  let echoWave = fract(flow + 0.38);
  let echo = smoothstep(0.54, 0.72, echoWave) * (1.0 - smoothstep(0.72, 0.95, echoWave));
  let side = abs(input.side);
  let inner = 1.0 - smoothstep(0.02, 0.18, side);
  let core = 1.0 - smoothstep(0.06, 0.42, side);
  let halo = 1.0 - smoothstep(0.28, 1.0, side);
  let pulse = 0.88 + sin(input.time * 2.15 + input.seed * 6.283 + input.along * 4.4) * 0.08;
  let alpha = fade * input.color.a * (
    halo * 0.26 +
    core * (0.36 + input.state * 0.22) * pulse +
    bead * inner * (0.86 + input.state * 0.72) +
    echo * inner * (0.18 + input.state * 0.18)
  );
  if (alpha < 0.007) {
    discard;
  }
  let intensity = 0.68 + halo * 0.12 + core * 0.28 + bead * (0.62 + input.state * 0.4) + echo * 0.18;
  let color = min(input.color.rgb * intensity, vec3f(1.0));
  return vec4f(color, min(0.92, alpha));
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
      @contextmenu.prevent
      @wheel="onWheel"
    ></canvas>
    <slot name="overlay"></slot>

    <div class="webgpu-label-layer">
      <button
        v-for="label in labels"
        :key="label.id"
        class="webgpu-label"
        :class="{ active: label.active, up: label.heat === 'up', down: label.heat === 'down', heatFlat: label.heatFlat }"
        :style="{ left: `${label.x}px`, top: `${label.y}px`, '--label-color': label.color }"
        @pointerdown.stop="onLabelPointerDown(label.id, $event)"
        @pointermove.stop="onPointerMove"
        @pointerup.stop="onLabelPointerUp(label.id, $event)"
        @pointercancel.stop="onLabelPointerUp(label.id, $event, true)"
        @contextmenu.prevent.stop="inspectTagLabel(label.id, $event)"
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
