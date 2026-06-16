<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  Map as MapIcon,
  FileText,
  Tags,
  Plus,
  Orbit,
  Clock,
  ArrowRight,
  Sparkles,
  Activity,
  Edit3,
  Trash2,
  Check,
  X
} from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useMapsStore } from '../stores/maps';
import { useUiStore } from '../stores/ui';
import type { LogEntry, NebulaMap } from '../types/domain';

const auth = useAuthStore();
const mapsStore = useMapsStore();
const ui = useUiStore();
const router = useRouter();

const creating = ref(false);
const recentMap = computed(() => {
  const rememberedId = mapsStore.activeMapId ?? Number(localStorage.getItem('nebula.lastActiveMapId'));
  const remembered = mapsStore.maps.find(map => map.id === rememberedId);
  if (remembered) return remembered;
  return [...mapsStore.maps].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0] ?? null;
});
const galaxyPreviewMaps = computed(() => mapsStore.maps.slice(0, Math.min(12, Math.max(3, mapsStore.maps.length))));

onMounted(async () => {
  await mapsStore.fetchMaps();
  if (recentMap.value) {
    await mapsStore.selectMap(recentMap.value.id);
  }
});

const accountStats = computed(() => {
  const graph = mapsStore.graph;
  return {
    maps: mapsStore.maps.length,
    logs: graph?.logs.length ?? 0,
    tags: graph?.tags.length ?? 0
  };
});

const statsScopeLabel = computed(() => {
  const name = mapsStore.graph?.map.name ?? recentMap.value?.name;
  return name ? `当前星图：${name}` : '当前星图';
});

async function createAndEnter() {
  creating.value = true;
  try {
    const map = await mapsStore.addMap('未命名星图', '');
    router.push(`/maps/${map.id}`);
  } catch {
    // error handled
  } finally {
    creating.value = false;
  }
}

function enterMap(id: number) {
  router.push(`/maps/${id}`);
}

function planetStyle(index: number, total: number, color?: string) {
  const count = Math.max(1, total);
  const angle = (index / count) * 360 + 18;
  const orbit = 36 + (index % 4) * 22;
  const size = 6 + (index % 3) * 2;
  const palette = ['#8cf0b4', '#b99cff', '#f7d774', '#ff8fa3', '#62d6ff'];
  return {
    '--angle': `${angle}deg`,
    '--orbit': `${orbit}px`,
    '--size': `${size}px`,
    '--planet-color': color ?? palette[index % palette.length],
    '--duration': `${12 + index * 1.4}s`
  };
}

function requestDeleteMap(map: NebulaMap) {
  ui.showConfirm(
    '删除星云图',
    `确定删除「${map.name}」吗？里面的日志、标签、领域大类都会一起删除。`,
    '删除',
    async () => {
      await mapsStore.removeMap(map.id);
      if (mapsStore.renamingMapId === map.id) mapsStore.cancelRenameMap();
      ui.showNotice('星云图已删除');
    }
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
  return d.toLocaleDateString('zh-CN');
}
</script>

<template>
  <div class="home-page stardust-page stardust-page--dense">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-content">
        <h1 class="hero-title">
          <Sparkles :size="32" class="hero-icon" />
          星云洞察
        </h1>
        <p class="hero-subtitle">个人日志知识图谱 — 将你的思考、学习和生活连接成星系</p>
        <div class="hero-actions">
          <button class="cta-button" :disabled="creating" @click="createAndEnter">
            <Plus :size="18" />
            {{ creating ? '创建中...' : '新建星图' }}
          </button>
          <button
            v-if="recentMap"
            class="secondary-button"
            @click="enterMap(recentMap.id)"
          >
            <ArrowRight :size="16" />
            继续「{{ recentMap.name }}」
          </button>
        </div>
      </div>
      <div class="hero-visual">
        <div class="hero-galaxy">
          <div class="galaxy-core" />
          <div class="galaxy-ring r1" />
          <div class="galaxy-ring r2" />
          <div class="galaxy-ring r3" />
          <span
            v-for="(map, index) in galaxyPreviewMaps"
            :key="map.id"
            class="galaxy-planet"
            :style="planetStyle(index, galaxyPreviewMaps.length)"
            :title="map.name"
          />
        </div>
      </div>
    </section>

    <!-- Stats -->
    <section class="stats-row">
      <div class="stat-card">
        <div class="stat-icon maps">
          <MapIcon :size="22" />
        </div>
        <div class="stat-body">
          <span class="stat-num">{{ mapsStore.maps.length }}</span>
          <span class="stat-label">星图</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon logs">
          <FileText :size="22" />
        </div>
        <div class="stat-body">
          <span class="stat-num">{{ accountStats.logs }}</span>
          <span class="stat-label">当前星图日志</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon tags">
          <Tags :size="22" />
        </div>
        <div class="stat-body">
          <span class="stat-num">{{ accountStats.tags }}</span>
          <span class="stat-label">当前星图标签</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon activity">
          <Activity :size="22" />
        </div>
        <div class="stat-body">
          <span class="stat-num">{{ auth.currentUser?.username ?? '' }}</span>
          <span class="stat-label">当前用户</span>
        </div>
      </div>
    </section>
    <p v-if="mapsStore.maps.length > 0" class="stats-note">
      {{ statsScopeLabel }}。标签数按去重后的标签节点统计；高低频才统计标签在日志中的使用次数。
    </p>

    <!-- Map Grid -->
    <section class="section">
      <div class="section-head">
        <h2>我的星图</h2>
        <button class="text-button" :disabled="creating" @click="createAndEnter">
          <Plus :size="15" />
          新建
        </button>
      </div>

      <div v-if="mapsStore.maps.length === 0 && !mapsStore.loading" class="empty-state">
        <Orbit :size="48" class="empty-icon" />
        <h3>还没有星云图</h3>
        <p>创建你的第一个星云图，开始记录日志吧</p>
        <button class="cta-button" :disabled="creating" @click="createAndEnter">
          <Plus :size="18" />
          创建第一个星图
        </button>
      </div>

      <div v-else class="map-grid">
        <div
          v-for="map in mapsStore.maps"
          :key="map.id"
        >
          <form
            v-if="mapsStore.renamingMapId === map.id && mapsStore.renameLocation === 'list'"
            class="map-rename-card"
            @submit.prevent="mapsStore.saveRenameMap(map.id)"
            @click.stop
          >
            <input v-model="mapsStore.renameDraft" @keydown.escape.prevent="mapsStore.cancelRenameMap()" />
            <button class="icon-button" :disabled="mapsStore.renameSaving"><Check :size="15" /></button>
            <button class="icon-button" type="button" @click="mapsStore.cancelRenameMap"><X :size="15" /></button>
          </form>
          <div v-else class="map-card" @click="enterMap(map.id)">
            <div class="map-card-preview">
              <div class="mini-orbit">
                <Orbit :size="32" />
              </div>
            </div>
            <div class="map-card-body">
              <h3>{{ map.name }}</h3>
              <p>{{ map.description || '无描述' }}</p>
              <div class="map-card-meta">
                <span><Clock :size="13" /> {{ formatTime(map.createdAt) }}</span>
              </div>
            </div>
            <div class="map-card-actions" @click.stop>
              <button class="icon-button sm" title="重命名" @click="mapsStore.startRenameMap(map.id, 'list')"><Edit3 :size="14" /></button>
              <button class="icon-button sm danger" title="删除" @click="requestDeleteMap(map)"><Trash2 :size="14" /></button>
            </div>
            <div class="map-card-arrow">
              <ArrowRight :size="18" />
            </div>
          </div>
        </div>

        <!-- New map card -->
        <button class="map-card new-map-card" :disabled="creating" @click="createAndEnter">
          <Plus :size="36" />
          <span>新建星图</span>
        </button>
      </div>
    </section>

    <!-- Recent Activity (placeholder) -->
    <section v-if="recentMap" class="section">
      <div class="section-head">
        <h2>快速开始</h2>
      </div>
      <div class="quick-tips">
        <div class="tip-card" @click="enterMap(recentMap.id)">
          <Sparkles :size="22" />
          <div>
            <strong>进入星图</strong>
            <p>进入「{{ recentMap.name }}」，查看标签星云和知识连接</p>
          </div>
        </div>
        <div class="tip-card" @click="router.push(`/maps/${recentMap.id}/logs`)">
          <FileText :size="22" />
          <div>
            <strong>写日志</strong>
            <p>写入「{{ recentMap.name }}」，记录今天的思考和收获</p>
          </div>
        </div>
        <div class="tip-card" @click="router.push(`/maps/${recentMap.id}/insights`)">
          <Activity :size="22" />
          <div>
            <strong>查看洞察</strong>
            <p>查看「{{ recentMap.name }}」的学习趋势和标签关系</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="home-footer">
      <p>🌌 星云洞察 — 让每一个想法，都在知识宇宙中闪耀</p>
    </footer>
  </div>
</template>

<style scoped>
.home-page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: 60px;
}

.home-page > * {
  position: relative;
  z-index: 1;
}

/* Hero */
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 48px 56px 40px;
  max-width: 1100px;
  margin: 0 auto;
  gap: 40px;
}

.hero-content {
  flex: 1;
}

.hero-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 36px;
  font-weight: 800;
  margin: 0 0 12px;
  background: linear-gradient(135deg, #62d6ff 0%, #b99cff 50%, #ff8fa3 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-icon {
  color: #62d6ff;
  -webkit-text-fill-color: initial;
}

.hero-subtitle {
  font-size: 16px;
  color: rgba(238, 246, 255, 0.55);
  margin: 0 0 28px;
  max-width: 440px;
  line-height: 1.6;
}

.hero-actions {
  display: flex;
  gap: 12px;
}

.cta-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 24px;
  border-radius: 10px;
  background: linear-gradient(135deg, #62d6ff, #3e9eca);
  color: #08111f;
  font-weight: 600;
  font-size: 14px;
  border: none;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}

.cta-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 24px rgba(98, 214, 255, 0.3);
}

.cta-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.secondary-button {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 20px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: #eef6ff;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  cursor: pointer;
  transition: background 0.15s;
}

.secondary-button:hover {
  background: rgba(255, 255, 255, 0.1);
}

/* Hero visual */
.hero-visual {
  flex-shrink: 0;
}

.hero-galaxy {
  position: relative;
  width: 210px;
  height: 210px;
  transform-style: preserve-3d;
}

.galaxy-core {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 24px;
  height: 24px;
  margin: -12px;
  border-radius: 50%;
  background: radial-gradient(circle, #f7d774, #8cf0b4 56%, rgba(185, 156, 255, 0.6));
  box-shadow: 0 0 44px rgba(247, 215, 116, 0.3), 0 0 70px rgba(140, 240, 180, 0.16);
}

.galaxy-ring {
  position: absolute;
  top: 50%;
  left: 50%;
  border-radius: 50%;
  border: 1px solid rgba(238, 246, 255, 0.09);
  transform: translate(-50%, -50%);
}

.r1 { width: 82px; height: 82px; animation: orbitBreath 8s ease-in-out infinite; }
.r2 { width: 138px; height: 138px; animation: orbitBreath 10s ease-in-out infinite reverse; }
.r3 { width: 196px; height: 196px; animation: orbitBreath 13s ease-in-out infinite; }
.r1::after, .r2::after, .r3::after {
  content: '';
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #97e0ff;
}
.r1::after { top: -3px; left: 50%; }
.r2::after { top: 50%; right: -3px; }
.r3::after { bottom: 15px; left: -3px; }

.galaxy-planet {
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--size);
  height: var(--size);
  margin: calc(var(--size) / -2);
  border-radius: 50%;
  background: var(--planet-color);
  box-shadow: 0 0 14px color-mix(in srgb, var(--planet-color) 65%, transparent);
  transform: rotate(var(--angle)) translateX(var(--orbit));
  transform-origin: center;
  animation: mapOrbit var(--duration) linear infinite;
}

/* Stats */
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  padding: 0 56px;
  max-width: 1100px;
  margin: 0 auto 12px;
}

.stats-note {
  max-width: 1100px;
  margin: 0 auto 40px;
  padding: 0 56px;
  color: rgba(238, 246, 255, 0.38);
  font-size: 12px;
  line-height: 1.6;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.stat-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-icon.maps { background: rgba(98, 214, 255, 0.15); color: #62d6ff; }
.stat-icon.logs { background: rgba(140, 240, 180, 0.15); color: #8cf0b4; }
.stat-icon.tags { background: rgba(185, 156, 255, 0.15); color: #b99cff; }
.stat-icon.activity { background: rgba(255, 143, 163, 0.15); color: #ff8fa3; }

.stat-body {
  display: flex;
  flex-direction: column;
}

.stat-num {
  font-size: 22px;
  font-weight: 700;
  color: #eef6ff;
}

.stat-label {
  font-size: 12px;
  color: rgba(238, 246, 255, 0.45);
}

/* Sections */
.section {
  padding: 0 56px;
  max-width: 1100px;
  margin: 0 auto 36px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.section-head h2 {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
}

.text-button {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  color: #62d6ff;
  background: transparent;
  border: none;
  cursor: pointer;
}

.text-button:hover:not(:disabled) {
  background: rgba(98, 214, 255, 0.1);
}

/* Empty state */
.empty-state {
  text-align: center;
  padding: 56px 24px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px dashed rgba(255, 255, 255, 0.08);
}

.empty-icon {
  color: rgba(255, 255, 255, 0.15);
  margin-bottom: 16px;
}

.empty-state h3 {
  margin: 0 0 8px;
  font-size: 18px;
}

.empty-state p {
  color: rgba(238, 246, 255, 0.45);
  margin: 0 0 20px;
}

/* Map grid */
.map-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}

.map-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
}

.map-card:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(98, 214, 255, 0.25);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.map-card-preview {
  flex-shrink: 0;
}

.mini-orbit {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  background: rgba(98, 214, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #62d6ff;
}

.map-card-body {
  flex: 1;
  min-width: 0;
}

.map-card-body h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.map-card-body p {
  margin: 0 0 6px;
  font-size: 12px;
  color: rgba(238, 246, 255, 0.4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.map-card-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: rgba(238, 246, 255, 0.3);
}

.map-card-meta span {
  display: flex;
  align-items: center;
  gap: 4px;
}

.map-card-arrow {
  color: rgba(255, 255, 255, 0.2);
  flex-shrink: 0;
  transition: all 0.2s;
}

.map-card:hover .map-card-arrow {
  color: #62d6ff;
  transform: translateX(4px);
}

.map-card-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.map-card:hover .map-card-actions {
  opacity: 1;
}

.map-rename-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(98, 214, 255, 0.25);
}

.map-rename-card input {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #eef6ff;
  font-size: 14px;
}

.new-map-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  border-style: dashed;
  color: rgba(238, 246, 255, 0.3);
  background: transparent;
  font-size: 13px;
}

.new-map-card:hover {
  color: #62d6ff;
  border-color: rgba(98, 214, 255, 0.3);
}

/* Quick tips */
.quick-tips {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

.tip-card {
  display: flex;
  gap: 14px;
  padding: 18px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: background 0.15s;
  color: #62d6ff;
}

.tip-card:hover {
  background: rgba(255, 255, 255, 0.04);
}

.tip-card strong {
  display: block;
  font-size: 14px;
  color: #eef6ff;
  margin-bottom: 4px;
}

.tip-card p {
  margin: 0;
  font-size: 12px;
  color: rgba(238, 246, 255, 0.45);
}

/* Footer */
.home-footer {
  text-align: center;
  padding: 40px 20px;
  color: rgba(238, 246, 255, 0.2);
  font-size: 13px;
}

@keyframes mapOrbit {
  from { transform: rotate(var(--angle)) translateX(var(--orbit)); }
  to { transform: rotate(calc(var(--angle) + 360deg)) translateX(var(--orbit)); }
}

@keyframes orbitBreath {
  0%, 100% { opacity: 0.58; transform: translate(-50%, -50%) scale(1); }
  50% { opacity: 0.9; transform: translate(-50%, -50%) scale(1.035); }
}

@media (prefers-reduced-motion: reduce) {
  .home-page {
    animation: none;
  }
}

@media (max-width: 900px) {
  .hero {
    flex-direction: column;
    padding: 32px 24px;
    text-align: center;
  }
  .hero-actions {
    justify-content: center;
  }
  .stats-row {
    grid-template-columns: repeat(2, 1fr);
    padding: 0 24px;
  }
  .stats-note {
    padding: 0 24px;
  }
  .section {
    padding: 0 24px;
  }
  .quick-tips {
    grid-template-columns: 1fr;
  }
  .map-grid {
    grid-template-columns: 1fr;
  }
}
</style>
