<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import AuthPanel from '../AuthPanel.vue';

const auth = useAuthStore();
const router = useRouter();

onMounted(async () => {
  if (!auth.currentUser && !auth.checkingAuth) {
    await auth.checkAuth();
  }
});

function handleAuthenticated() {
  router.push('/');
}
</script>

<template>
  <AuthPanel v-if="!auth.checkingAuth && !auth.currentUser" @authenticated="handleAuthenticated" />
  <slot v-else-if="auth.currentUser" />
  <div v-else class="auth-loading">
    <div class="loading-spinner" />
  </div>
</template>

<style scoped>
.auth-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
}

.loading-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: #62d6ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
