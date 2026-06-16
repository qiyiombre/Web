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
import { useUiStore } from '../../stores/ui';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();

const mapId = computed(() => route.params.id as string | undefined);
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
  if (mapId.value) {
    items.push(
      { to: `/maps/${mapId.value}`, label: '星图', icon: Orbit },
      { to: `/maps/${mapId.value}/logs`, label: '日志', icon: FileText },
      { to: `/maps/${mapId.value}/insights`, label: '洞察', icon: Sparkles },
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
  background: rgba(10, 20, 36, 0.95);
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
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
  color: #08111f;
  background: linear-gradient(135deg, #62d6ff, #b99cff);
  box-shadow: 0 0 22px rgba(98, 214, 255, 0.22);
}

.brand-text {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #eef6ff;
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
  color: rgba(238, 246, 255, 0.6);
  text-decoration: none;
  transition: all 0.15s;
}

.nav-link:hover {
  color: #eef6ff;
  background: rgba(255, 255, 255, 0.06);
}

.nav-link.active {
  color: #62d6ff;
  background: rgba(98, 214, 255, 0.1);
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
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #eef6ff;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.user-pill:hover {
  background: rgba(255, 255, 255, 0.1);
}

.user-initials {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background:
    linear-gradient(135deg, rgba(98, 214, 255, 0.28), rgba(185, 156, 255, 0.2)),
    rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(98, 214, 255, 0.22);
  color: #97e6ff;
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
  min-width: 200px;
  background: #142130;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  z-index: 200;
}

.user-menu-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  margin-bottom: 4px;
}

.user-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background:
    linear-gradient(135deg, rgba(98, 214, 255, 0.28), rgba(185, 156, 255, 0.2)),
    rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(98, 214, 255, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #62d6ff;
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
  color: #eef6ff;
  background: transparent;
  cursor: pointer;
  border: none;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.menu-item.danger {
  color: #ff8fa3;
}

.menu-item.danger:hover {
  background: rgba(255, 143, 163, 0.1);
}
</style>
