<script setup lang="ts">
import { computed, ref } from 'vue';
import { Eye, EyeOff, LogIn, Orbit, UserPlus } from 'lucide-vue-next';
import { login, register } from '../services/api';
import type { UserAccount } from '../types/domain';

const emit = defineEmits<{
  authenticated: [user: UserAccount];
}>();

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const showPassword = ref(false);
const showConfirmPassword = ref(false);
const loading = ref(false);
const error = ref('');

const title = computed(() => (mode.value === 'login' ? '登录星云洞察' : '注册星云洞察'));
const actionText = computed(() => (mode.value === 'login' ? '登录' : '注册'));

async function submit() {
  error.value = '';
  const cleanUsername = username.value.trim();
  if (!cleanUsername || !password.value) {
    error.value = '请输入用户名和密码。';
    return;
  }
  if (mode.value === 'register' && password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致。';
    return;
  }

  loading.value = true;
  try {
    const result =
      mode.value === 'login'
        ? await login(cleanUsername, password.value)
        : await register(cleanUsername, password.value);
    emit('authenticated', result.user);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '认证失败';
  } finally {
    loading.value = false;
  }
}

function switchMode(nextMode: 'login' | 'register') {
  mode.value = nextMode;
  error.value = '';
  confirmPassword.value = '';
  showPassword.value = false;
  showConfirmPassword.value = false;
}
</script>

<template>
  <main class="auth-shell">
    <section class="auth-card">
      <div class="auth-brand">
        <div class="brand-mark">
          <Orbit :size="26" />
        </div>
        <div>
          <h1>星云洞察</h1>
          <p>登录后，每个用户拥有独立的星云图、日志和标签。</p>
        </div>
      </div>

      <div class="auth-tabs" role="tablist" aria-label="登录注册切换">
        <button :class="{ active: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button :class="{ active: mode === 'register' }" @click="switchMode('register')">注册</button>
      </div>

      <form class="auth-form" @submit.prevent="submit">
        <h2>{{ title }}</h2>
        <label class="field">
          <span>用户名</span>
          <input v-model="username" autocomplete="username" placeholder="至少 3 个字符" />
        </label>
        <label class="field">
          <span>密码</span>
          <span class="password-input">
            <input
              v-model="password"
              :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
              :type="showPassword ? 'text' : 'password'"
              placeholder="至少 6 个字符"
            />
            <button
              class="password-toggle"
              type="button"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              :title="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <EyeOff v-if="showPassword" :size="18" />
              <Eye v-else :size="18" />
            </button>
          </span>
        </label>
        <label v-if="mode === 'register'" class="field">
          <span>确认密码</span>
          <span class="password-input">
            <input
              v-model="confirmPassword"
              autocomplete="new-password"
              :type="showConfirmPassword ? 'text' : 'password'"
              placeholder="再次输入密码"
            />
            <button
              class="password-toggle"
              type="button"
              :aria-label="showConfirmPassword ? '隐藏确认密码' : '显示确认密码'"
              :title="showConfirmPassword ? '隐藏确认密码' : '显示确认密码'"
              @click="showConfirmPassword = !showConfirmPassword"
            >
              <EyeOff v-if="showConfirmPassword" :size="18" />
              <Eye v-else :size="18" />
            </button>
          </span>
        </label>

        <p v-if="error" class="form-error">{{ error }}</p>

        <button class="primary-button wide" :disabled="loading" type="submit">
          <LogIn v-if="mode === 'login'" :size="17" />
          <UserPlus v-else :size="17" />
          {{ loading ? '处理中...' : actionText }}
        </button>
      </form>

      <p class="auth-footnote">可用账号demo / demo123456</p>
    </section>
  </main>
</template>
