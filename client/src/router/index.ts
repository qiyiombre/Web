import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../pages/HomePage.vue'),
      meta: { title: '星云洞察 — 首页' }
    },
    {
      path: '/maps/:id',
      name: 'map',
      component: () => import('../pages/MapPage.vue'),
      meta: { title: '星云图' }
    },
    {
      path: '/maps/:id/logs',
      name: 'logs',
      component: () => import('../pages/LogsPage.vue'),
      meta: { title: '日志' }
    },
    {
      path: '/maps/:id/insights',
      name: 'insights',
      component: () => import('../pages/InsightsPage.vue'),
      meta: { title: '洞察' }
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../pages/SettingsPage.vue'),
      meta: { title: '设置' }
    }
  ]
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (auth.checkingAuth) {
    await auth.checkAuth();
  }
  // Redirect to home if not authenticated
  if (!auth.currentUser && to.name !== 'home') {
    return { name: 'home' };
  }
});

router.afterEach((to) => {
  document.title = (to.meta.title as string) ?? '星云洞察';
});

export default router;
