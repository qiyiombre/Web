<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Orbit,
  FileText,
  Sparkles,
  Settings,
  Home,
  LogOut
} from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { useMapsStore } from '../../stores/maps';
import { useUiStore } from '../../stores/ui';
import { THEME_OPTIONS } from '../../constants/themes';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const mapsStore = useMapsStore();
const ui = useUiStore();

const currentMapId = computed(() => {
  const routeMapId = Number(route.params.id);
  if (Number.isFinite(routeMapId) && routeMapId > 0) return routeMapId;
  if (mapsStore.activeMapId) return mapsStore.activeMapId;
  const storedMapId = Number(localStorage.getItem('nebula.lastActiveMapId'));
  return Number.isFinite(storedMapId) && storedMapId > 0 ? storedMapId : null;
});
const userInitials = computed(() => {
  const username = auth.currentUser?.username.trim() ?? '';
  if (!username) return '--';
  const words = username.match(/[A-Za-z0-9]+/g);
  if (words && words.length > 1) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return username.replace(/\s+/g, '').slice(0, 2).toUpperCase();
});

const navItems = computed(() => {
  const items = [
    { to: '/', label: '首页', icon: Home },
  ];
  if (currentMapId.value) {
    items.push(
      { to: `/maps/${currentMapId.value}`, label: '星图', icon: Orbit },
      { to: `/maps/${currentMapId.value}/logs`, label: '日志', icon: FileText },
      { to: `/maps/${currentMapId.value}/insights`, label: '洞察', icon: Sparkles },
    );
  }
  items.push({ to: '/settings', label: '设置', icon: Settings });
  return items;
});

function isActive(to: string) {
  if (to === '/') return route.path === '/';
  return route.path.startsWith(to);
}

function closeUserMenuFromOutside() {
  if (ui.userMenuOpen) ui.closeUserMenu();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') ui.closeUserMenu();
}

async function handleLogout() {
  await auth.handleLogout();
  ui.closeUserMenu();
  router.push('/');
}

onMounted(() => {
  document.addEventListener('click', closeUserMenuFromOutside);
  document.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', closeUserMenuFromOutside);
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <header class="navbar">
    <div class="navbar-brand" @click="router.push('/')" role="button" tabindex="0">
      <span class="brand-mark">
        <Sparkles :size="16" />
      </span>
      <span class="brand-text">星云洞察</span>
    </div>

    <nav class="navbar-links">
      <router-link
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-link"
        :class="{ active: isActive(item.to) }"
      >
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="navbar-user" v-if="auth.currentUser">
      <div class="user-dropdown" @click.stop>
        <button class="user-pill" @click="ui.toggleUserMenu">
          <span class="user-initials small">{{ userInitials }}</span>
          <span>{{ auth.currentUser.username }}</span>
        </button>
        <div v-if="ui.userMenuOpen" class="user-menu-drop" role="dialog" aria-label="用户菜单">
          <div class="user-menu-head">
            <div class="user-avatar">
              {{ userInitials }}
            </div>
            <div>
              <strong>{{ auth.currentUser.username }}</strong>
            </div>
          </div>
          <div class="menu-theme-switcher" aria-label="主题切换">
            <small>主题</small>
            <div class="menu-theme-grid">
              <button
                v-for="theme in THEME_OPTIONS"
                :key="theme.id"
                type="button"
                class="menu-theme-dot"
                :class="{ active: auth.themeMode === theme.id }"
                :title="theme.label"
                @click="auth.setThemeMode(theme.id)"
              >
                <span
                  v-for="color in theme.swatches"
                  :key="color"
                  :style="{ background: color }"
                />
              </button>
            </div>
          </div>
          <button class="menu-item" @click="router.push('/settings'); ui.closeUserMenu()">
            <Settings :size="15" />
            设置
          </button>
          <button class="menu-item danger" @click="handleLogout">
            <LogOut :size="15" />
            退出登录
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.navbar {
  display: flex;
  align-items: center;
  gap: 0;
  height: 52px;
  padding: 0 20px;
  background: var(--nav-bg);
  border-bottom: 1px solid var(--panel-border);
  backdrop-filter: blur(12px);
  position: sticky;
  top: 0;
  z-index: 100;
  flex-shrink: 0;
}

.navbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  margin-right: 32px;
  flex-shrink: 0;
}

.brand-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  color: var(--app-bg);
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  box-shadow: 0 0 22px color-mix(in srgb, var(--accent-primary) 24%, transparent);
}

.brand-text {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-strong);
}

.navbar-links {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 13.5px;
  color: var(--text-muted);
  text-decoration: none;
  transition: all 0.15s;
}

.nav-link:hover {
  color: var(--text-strong);
  background: var(--control-bg);
}

.nav-link.active {
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 13%, transparent);
}

.navbar-user {
  flex-shrink: 0;
  margin-left: auto;
  position: relative;
}

.user-pill {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 14px;
  border-radius: 20px;
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  color: var(--text-strong);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.user-pill:hover {
  background: var(--control-bg-hover);
}

.user-initials {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 30%, transparent), color-mix(in srgb, var(--accent-secondary) 20%, transparent)),
    var(--control-bg);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 24%, var(--control-border));
  color: color-mix(in srgb, var(--accent-primary) 78%, var(--text-strong));
  font-weight: 800;
  letter-spacing: 0;
}

.user-initials.small {
  width: 22px;
  height: 22px;
  font-size: 10px;
}

.user-menu-drop {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  min-width: 244px;
  background: var(--panel-bg-strong);
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  padding: 8px;
  box-shadow: 0 12px 32px var(--shadow-strong);
  z-index: 200;
}

.user-menu-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 12px;
  border-bottom: 1px solid var(--panel-border);
  margin-bottom: 4px;
}

.user-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 30%, transparent), color-mix(in srgb, var(--accent-secondary) 20%, transparent)),
    var(--control-bg);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 24%, var(--control-border));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-strong);
  background: transparent;
  cursor: pointer;
  border: none;
}

.menu-item:hover {
  background: var(--control-bg);
}

.menu-item.danger {
  color: var(--danger);
}

.menu-item.danger:hover {
  background: color-mix(in srgb, var(--danger) 13%, transparent);
}

.menu-theme-switcher {
  padding: 8px 8px 10px;
  border-bottom: 1px solid var(--panel-border);
  margin-bottom: 4px;
}

.menu-theme-switcher small {
  display: block;
  margin: 0 2px 7px;
  color: var(--text-muted);
  font-size: 11px;
}

.menu-theme-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}

.menu-theme-dot {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  height: 28px;
  padding: 4px;
  border-radius: 9px;
  border: 1px solid var(--control-border);
  background: var(--control-bg);
  cursor: pointer;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.menu-theme-dot span {
  border-radius: 999px;
}

.menu-theme-dot:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-primary) 38%, var(--control-border));
}

.menu-theme-dot.active {
  border-color: color-mix(in srgb, var(--accent-primary) 70%, var(--control-border));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary) 16%, transparent);
}
</style>
