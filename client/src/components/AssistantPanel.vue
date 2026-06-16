<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  Ban,
  Bot,
  Check,
  Loader2,
  Mic,
  Send,
  Sparkles,
  X
} from 'lucide-vue-next';
import { createLog, resolveAssistantIntent, transcribeAssistantAudio } from '../services/api';
import { useMapsStore } from '../stores/maps';
import { useUiStore } from '../stores/ui';
import type { AssistantIntent } from '../types/domain';

type AssistantMessage = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  intent?: AssistantIntent;
  error?: boolean;
};

const router = useRouter();
const mapsStore = useMapsStore();
const ui = useUiStore();

const open = ref(false);
const input = ref('');
const loading = ref(false);
const listening = ref(false);
const voiceUploading = ref(false);
const voiceStatus = ref('');
const voiceDiagnosticsOpen = ref(false);
const voiceLastError = ref('');
const microphonePermission = ref('unknown');
const pendingIntent = ref<AssistantIntent | null>(null);
const messages = ref<AssistantMessage[]>([]);
const messageList = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);
let nextMessageId = 1;
let mediaRecorder: MediaRecorder | null = null;
let voiceStream: MediaStream | null = null;
let voiceChunks: Blob[] = [];
let voiceTimeoutId: number | null = null;

const activeMapName = computed(() => mapsStore.graph?.map.name ?? mapsStore.maps.find(map => map.id === mapsStore.activeMapId)?.name ?? '当前星图');
const voiceSecureContext = computed(() => {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext || ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
});
const speechEngineName = computed(() => {
  if (typeof window === 'undefined') return '不可用';
  return speechSupported.value ? 'MediaRecorder + API' : '不支持录音';
});
const speechSupported = computed(() => {
  if (typeof window === 'undefined') return false;
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.MediaRecorder === 'function';
});
const quickCommands = computed(() => [
  `总结${activeMapName.value}`,
  '打开当前星图日志',
  '帮我搜索最近的项目记录'
]);

async function togglePanel() {
  open.value = !open.value;
  if (!open.value) {
    stopListening();
    return;
  }
  if (mapsStore.maps.length === 0) {
    await mapsStore.fetchMaps();
  }
  await updateMicrophonePermissionState();
  await nextTick();
  inputRef.value?.focus();
  scrollToBottom();
}

function closePanel() {
  open.value = false;
  pendingIntent.value = null;
  stopListening();
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  input.value = '';
  pendingIntent.value = null;
  messages.value.push({ id: nextMessageId++, role: 'user', text });
  loading.value = true;
  await scrollToBottom();

  try {
    const intent = await resolveAssistantIntent({
      message: text,
      currentMapId: mapsStore.activeMapId
    });
    messages.value.push({
      id: nextMessageId++,
      role: 'assistant',
      text: intent.reply,
      intent
    });
    if (intent.requiresConfirmation) {
      pendingIntent.value = intent;
    } else {
      await executeIntent(intent);
    }
  } catch (error: any) {
    messages.value.push({
      id: nextMessageId++,
      role: 'assistant',
      text: error.message ?? '助手暂时不可用，请稍后再试。',
      error: true
    });
  } finally {
    loading.value = false;
    await scrollToBottom();
  }
}

async function executeIntent(intent: AssistantIntent) {
  const mapId = normalizeMapId(intent.payload.mapId);
  switch (intent.action) {
    case 'open_home':
      await router.push({ name: 'home' });
      closePanel();
      break;
    case 'open_settings':
      await router.push({ name: 'settings' });
      closePanel();
      break;
    case 'open_map':
      if (mapId) {
        await ensureMapSelected(mapId);
        await router.push({ name: 'map', params: { id: String(mapId) } });
        closePanel();
      }
      break;
    case 'open_logs':
      if (mapId) {
        await ensureMapSelected(mapId);
        await router.push({ name: 'logs', params: { id: String(mapId) } });
        closePanel();
      }
      break;
    case 'open_insights':
      if (mapId) {
        await ensureMapSelected(mapId);
        await router.push({ name: 'insights', params: { id: String(mapId) } });
        closePanel();
      }
      break;
    case 'search_logs':
      if (mapId) {
        await ensureMapSelected(mapId);
        await router.push({
          name: 'logs',
          params: { id: String(mapId) },
          query: intent.payload.query ? { q: intent.payload.query } : {}
        });
        closePanel();
      }
      break;
    default:
      break;
  }
}

async function confirmCreateLog() {
  const intent = pendingIntent.value;
  if (!intent || intent.action !== 'create_log' || loading.value) return;
  const mapId = normalizeMapId(intent.payload.mapId);
  if (!mapId) {
    ui.showNotice('请先创建或选择一个星图');
    pendingIntent.value = null;
    return;
  }

  loading.value = true;
  try {
    const created = await createLog({
      mapId,
      title: intent.payload.title ?? '助手记录',
      content: intent.payload.content ?? '',
      tagNames: intent.payload.tagNames ?? []
    });
    await ensureMapSelected(mapId);
    await router.push({ name: 'logs', params: { id: String(mapId) }, query: { edit: String(created.id) } });
    pendingIntent.value = null;
    messages.value.push({
      id: nextMessageId++,
      role: 'assistant',
      text: '日志已创建，并已打开编辑状态，你可以继续微调。'
    });
    ui.showNotice('日志已由助手创建');
    closePanel();
  } catch (error: any) {
    messages.value.push({
      id: nextMessageId++,
      role: 'assistant',
      text: error.message ?? '创建日志失败',
      error: true
    });
  } finally {
    loading.value = false;
    await scrollToBottom();
  }
}

function cancelPending() {
  pendingIntent.value = null;
  messages.value.push({
    id: nextMessageId++,
    role: 'assistant',
    text: '已取消这次操作。'
  });
  scrollToBottom();
}

async function ensureMapSelected(mapId: number) {
  if (mapsStore.maps.length === 0) {
    await mapsStore.fetchMaps();
  }
  if (mapsStore.activeMapId !== mapId || mapsStore.graph?.map.id !== mapId) {
    await mapsStore.selectMap(mapId);
  }
}

function normalizeMapId(value: unknown) {
  const id = Number(value ?? mapsStore.activeMapId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function applyQuickCommand(text: string) {
  input.value = text;
  sendMessage();
}

async function toggleListening() {
  if (listening.value) {
    stopListening(true);
    return;
  }
  if (voiceUploading.value) return;
  voiceLastError.value = '';
  await updateMicrophonePermissionState();
  if (!speechSupported.value) {
    voiceLastError.value = 'unsupported';
    ui.showNotice('当前浏览器不支持录音上传');
    return;
  }
  const micReady = await requestMicrophonePermission();
  if (!micReady) return;

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    voiceChunks = [];
    mediaRecorder = new MediaRecorder(voiceStream, pickRecorderOptions());
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        voiceChunks.push(event.data);
      }
    };
    mediaRecorder.onerror = () => {
      voiceLastError.value = 'recording-error';
      ui.showNotice('录音失败，请检查麦克风设备');
      stopListening(false);
    };
    mediaRecorder.onstop = () => {
      void finishVoiceRecording(true);
    };
    mediaRecorder.start();
    listening.value = true;
    voiceStatus.value = '正在录音，再点一次结束';
    voiceTimeoutId = window.setTimeout(() => {
      if (!listening.value) return;
      voiceStatus.value = '录音已达到上限，正在转文字...';
      stopListening(true);
    }, 15000);
  } catch (error: any) {
    listening.value = false;
    mediaRecorder = null;
    cleanupVoiceStream();
    voiceLastError.value = error?.name ?? 'recording-start-failed';
    voiceStatus.value = '';
    ui.showNotice(getRecordingErrorMessage(error?.name));
  }
}

function stopListening(shouldTranscribe = false) {
  clearVoiceTimeout();
  if (!mediaRecorder) {
    cleanupVoiceStream();
    listening.value = false;
    if (!shouldTranscribe) voiceStatus.value = '';
    return;
  }
  const recorder = mediaRecorder;
  if (recorder.state !== 'inactive') {
    recorder.onstop = () => {
      void finishVoiceRecording(shouldTranscribe);
    };
    recorder.stop();
  } else {
    void finishVoiceRecording(shouldTranscribe);
  }
  listening.value = false;
}

function clearVoiceTimeout() {
  if (voiceTimeoutId === null) return;
  window.clearTimeout(voiceTimeoutId);
  voiceTimeoutId = null;
}

async function finishVoiceRecording(shouldTranscribe: boolean) {
  const chunks = voiceChunks;
  voiceChunks = [];
  mediaRecorder = null;
  cleanupVoiceStream();
  listening.value = false;
  if (!shouldTranscribe) {
    voiceStatus.value = '';
    return;
  }

  const recordedType = chunks.find(chunk => chunk.type)?.type || 'audio/webm';
  const recordedAudio = new Blob(chunks, { type: recordedType });
  if (recordedAudio.size < 512) {
    voiceLastError.value = 'empty-recording';
    voiceStatus.value = '';
    ui.showNotice('录音太短，请重新说一遍');
    return;
  }

  voiceUploading.value = true;
  voiceStatus.value = '正在转文字...';
  try {
    const audio = await convertRecordingToWav(recordedAudio);
    const { text } = await transcribeAssistantAudio(audio);
    const transcript = text.trim();
    if (!transcript) {
      voiceLastError.value = 'empty-transcript';
      ui.showNotice('没有识别到文字，请重新录制');
      return;
    }
    input.value = `${input.value}${input.value ? ' ' : ''}${transcript}`.trim();
    voiceStatus.value = `已识别：${transcript}`;
    await nextTick();
    await sendMessage();
  } catch (error: any) {
    voiceLastError.value = 'transcribe-failed';
    voiceStatus.value = '';
    ui.showNotice(error.message ?? '语音转文字失败');
  } finally {
    voiceUploading.value = false;
  }
}

function cleanupVoiceStream() {
  voiceStream?.getTracks().forEach(track => track.stop());
  voiceStream = null;
}

async function convertRecordingToWav(audio: Blob) {
  const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor || typeof OfflineAudioContext === 'undefined') {
    throw new Error('当前浏览器无法转换录音格式，请换用 Chrome 或 Edge');
  }
  const sourceContext = new AudioContextCtor();
  const arrayBuffer = await audio.arrayBuffer();
  const decoded = await sourceContext.decodeAudioData(arrayBuffer);
  await sourceContext.close?.();

  const targetSampleRate = 16000;
  const frameCount = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
  const offline = new OfflineAudioContext(1, frameCount, targetSampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), targetSampleRate);
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function pickRecorderOptions() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type));
  return mimeType ? { mimeType } : undefined;
}

async function requestMicrophonePermission() {
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  if (!window.isSecureContext && !isLocalHost) {
    ui.showNotice('录音需要 HTTPS 或 localhost 环境');
    return false;
  }
  return true;
}

async function updateMicrophonePermissionState() {
  if (!navigator.permissions?.query) {
    microphonePermission.value = 'unsupported';
    return;
  }
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    microphonePermission.value = status.state;
    status.onchange = () => {
      microphonePermission.value = status.state;
    };
  } catch {
    microphonePermission.value = 'unknown';
  }
}

function getRecordingErrorMessage(errorName = '') {
  if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
    return '麦克风权限被拒绝，请在地址栏左侧允许麦克风';
  }
  if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
    return '没有检测到麦克风设备';
  }
  if (errorName === 'NotReadableError' || errorName === 'TrackStartError') {
    return '麦克风正被其他程序占用';
  }
  return '无法开始录音，请检查浏览器权限和系统输入设备';
}

async function scrollToBottom() {
  await nextTick();
  if (messageList.value) {
    messageList.value.scrollTop = messageList.value.scrollHeight;
  }
}

onBeforeUnmount(() => {
  stopListening();
});
</script>

<template>
  <div class="assistant-dock" :class="{ open }">
    <button v-if="!open" class="assistant-fab" type="button" title="打开星云助手" @click="togglePanel">
      <Sparkles :size="18" />
      <span>助手</span>
    </button>

    <section v-else class="assistant-panel" role="dialog" aria-label="星云助手" @keydown.esc="closePanel">
      <header class="assistant-head">
        <div>
          <span class="assistant-kicker">DeepSeek 操作助手</span>
          <strong>星云助手</strong>
        </div>
        <button class="assistant-icon-button" type="button" title="关闭" @click="closePanel">
          <X :size="16" />
        </button>
      </header>

      <div ref="messageList" class="assistant-messages">
        <div v-if="messages.length === 0" class="assistant-empty">
          <Bot :size="28" />
          <p>可以用一句话打开页面、搜索日志、查看统计，或确认后新建日志。</p>
          <div class="assistant-quick-list">
            <button v-for="command in quickCommands" :key="command" type="button" @click="applyQuickCommand(command)">
              {{ command }}
            </button>
          </div>
        </div>

        <article
          v-for="message in messages"
          :key="message.id"
          class="assistant-message"
          :class="[message.role, { error: message.error }]"
        >
          <span class="message-avatar">
            <Bot v-if="message.role === 'assistant'" :size="14" />
            <span v-else>你</span>
          </span>
          <p>{{ message.text }}</p>
        </article>

        <article v-if="loading" class="assistant-message assistant loading-row">
          <span class="message-avatar"><Loader2 :size="14" class="spin" /></span>
          <p>正在理解你的指令...</p>
        </article>
      </div>

      <div v-if="pendingIntent" class="assistant-confirm">
        <div>
          <strong>需要确认</strong>
          <span>{{ pendingIntent.payload.title ?? '助手记录' }}</span>
        </div>
        <div class="assistant-confirm-actions">
          <button type="button" class="ghost-action" :disabled="loading" @click="cancelPending">
            <Ban :size="14" />
            取消
          </button>
          <button type="button" class="confirm-action" :disabled="loading" @click="confirmCreateLog">
            <Check :size="14" />
            写入日志
          </button>
        </div>
      </div>

      <footer class="assistant-compose">
        <textarea
          ref="inputRef"
          v-model="input"
          rows="2"
          placeholder="例如：帮我总结当前星图，或者搜索项目相关日志"
          @keydown.enter.exact.prevent="sendMessage"
        />
        <div class="assistant-compose-actions">
          <button
            class="assistant-icon-button"
            type="button"
            :class="{ active: listening }"
            :disabled="loading || voiceUploading"
            :title="listening ? '结束录音并转文字' : (speechSupported ? '录音输入' : '当前浏览器不支持录音')"
            @click="toggleListening"
          >
            <Mic :size="16" />
          </button>
          <button class="send-action" type="button" :disabled="loading || voiceUploading || !input.trim()" @click="sendMessage">
            <Send :size="15" />
          </button>
        </div>
        <p v-if="voiceStatus" class="assistant-voice-status">{{ voiceStatus }}</p>
        <div class="assistant-voice-diagnostics">
          <button type="button" @click="voiceDiagnosticsOpen = !voiceDiagnosticsOpen">
            {{ voiceDiagnosticsOpen ? '收起录音诊断' : '录音不能用？查看诊断' }}
          </button>
          <dl v-if="voiceDiagnosticsOpen">
            <div>
              <dt>录音方案</dt>
              <dd>{{ speechEngineName }}</dd>
            </div>
            <div>
              <dt>安全环境</dt>
              <dd>{{ voiceSecureContext ? '可用' : '不可用' }}</dd>
            </div>
            <div>
              <dt>麦克风权限</dt>
              <dd>{{ microphonePermission }}</dd>
            </div>
            <div>
              <dt>最近错误</dt>
              <dd>{{ voiceLastError || '无' }}</dd>
            </div>
          </dl>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.assistant-dock {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 420;
}

.assistant-fab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 16px;
  border: 1px solid rgba(98, 214, 255, 0.34);
  border-radius: 999px;
  background:
    radial-gradient(circle at 20% 10%, rgba(140, 240, 180, 0.25), transparent 35%),
    linear-gradient(135deg, rgba(16, 31, 52, 0.96), rgba(8, 17, 31, 0.96));
  color: #eef6ff;
  box-shadow: 0 14px 42px rgba(0, 0, 0, 0.35), 0 0 24px rgba(98, 214, 255, 0.16);
  cursor: pointer;
}

.assistant-fab span {
  font-size: 13px;
  font-weight: 800;
}

.assistant-panel {
  width: min(390px, calc(100vw - 32px));
  max-height: min(650px, calc(100vh - 44px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 18px;
  background:
    radial-gradient(circle at 14% 8%, rgba(98, 214, 255, 0.18), transparent 26%),
    radial-gradient(circle at 86% 20%, rgba(185, 156, 255, 0.13), transparent 30%),
    rgba(9, 18, 31, 0.96);
  box-shadow: 0 22px 70px rgba(0, 0, 0, 0.48), inset 0 0 0 1px rgba(98, 214, 255, 0.04);
  backdrop-filter: blur(18px);
}

.assistant-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.assistant-head strong,
.assistant-head span {
  display: block;
}

.assistant-head strong {
  margin-top: 3px;
  color: #eef6ff;
  font-size: 16px;
}

.assistant-kicker {
  color: rgba(98, 214, 255, 0.78);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0;
}

.assistant-icon-button,
.send-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(238, 246, 255, 0.72);
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
}

.assistant-icon-button:hover,
.send-action:hover:not(:disabled) {
  color: #eef6ff;
  border-color: rgba(98, 214, 255, 0.26);
  background: rgba(98, 214, 255, 0.12);
}

.assistant-icon-button.active {
  color: #08111f;
  border-color: transparent;
  background: #62d6ff;
}

.assistant-messages {
  flex: 1;
  min-height: 260px;
  overflow-y: auto;
  padding: 14px 14px 8px;
}

.assistant-empty {
  display: flex;
  min-height: 245px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: rgba(238, 246, 255, 0.48);
}

.assistant-empty svg {
  margin-bottom: 12px;
  color: rgba(98, 214, 255, 0.78);
}

.assistant-empty p {
  max-width: 260px;
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}

.assistant-quick-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 7px;
  margin-top: 16px;
}

.assistant-quick-list button {
  min-height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(98, 214, 255, 0.18);
  background: rgba(98, 214, 255, 0.07);
  color: rgba(238, 246, 255, 0.78);
  font-size: 12px;
  cursor: pointer;
}

.assistant-message {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 8px;
  margin-bottom: 10px;
}

.assistant-message p {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  color: rgba(238, 246, 255, 0.78);
  background: rgba(255, 255, 255, 0.055);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
}

.assistant-message.user p {
  color: #08111f;
  background: #62d6ff;
}

.assistant-message.error p {
  color: #ffb6c3;
  background: rgba(255, 143, 163, 0.12);
}

.message-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-top: 4px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(238, 246, 255, 0.62);
  background: rgba(255, 255, 255, 0.045);
  font-size: 11px;
  font-weight: 800;
}

.assistant-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 14px 10px;
  padding: 11px;
  border-radius: 13px;
  border: 1px solid rgba(247, 215, 116, 0.24);
  background: rgba(247, 215, 116, 0.09);
}

.assistant-confirm strong,
.assistant-confirm span {
  display: block;
}

.assistant-confirm strong {
  color: #f7d774;
  font-size: 12px;
}

.assistant-confirm span {
  max-width: 160px;
  margin-top: 2px;
  overflow: hidden;
  color: rgba(238, 246, 255, 0.68);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-confirm-actions {
  display: flex;
  gap: 6px;
}

.ghost-action,
.confirm-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 750;
  cursor: pointer;
}

.ghost-action {
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.045);
  color: rgba(238, 246, 255, 0.62);
}

.confirm-action {
  border: 0;
  background: #f7d774;
  color: #08111f;
}

.assistant-compose {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.025);
}

.assistant-compose textarea {
  min-height: 44px;
  max-height: 118px;
  resize: vertical;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  padding: 10px 11px;
  outline: none;
  background: rgba(5, 12, 22, 0.62);
  color: #eef6ff;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
}

.assistant-compose textarea:focus {
  border-color: rgba(98, 214, 255, 0.36);
  box-shadow: 0 0 0 3px rgba(98, 214, 255, 0.08);
}

.assistant-compose-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.assistant-voice-status {
  grid-column: 1 / -1;
  margin: -2px 2px 0;
  color: rgba(98, 214, 255, 0.74);
  font-size: 12px;
  line-height: 1.45;
}

.assistant-voice-diagnostics {
  grid-column: 1 / -1;
  margin-top: -2px;
}

.assistant-voice-diagnostics > button {
  padding: 0;
  border: 0;
  background: transparent;
  color: rgba(238, 246, 255, 0.42);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.assistant-voice-diagnostics > button:hover {
  color: rgba(98, 214, 255, 0.82);
}

.assistant-voice-diagnostics dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  margin: 8px 0 0;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
}

.assistant-voice-diagnostics div {
  min-width: 0;
}

.assistant-voice-diagnostics dt,
.assistant-voice-diagnostics dd {
  margin: 0;
}

.assistant-voice-diagnostics dt {
  margin-bottom: 2px;
  color: rgba(238, 246, 255, 0.35);
  font-size: 11px;
}

.assistant-voice-diagnostics dd {
  overflow: hidden;
  color: rgba(238, 246, 255, 0.72);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.send-action {
  color: #08111f;
  border-color: transparent;
  background: #62d6ff;
}

.send-action:disabled,
.assistant-icon-button:disabled,
.ghost-action:disabled,
.confirm-action:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.spin {
  animation: assistantSpin 0.8s linear infinite;
}

@keyframes assistantSpin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .assistant-dock {
    right: 14px;
    bottom: 14px;
  }

  .assistant-panel {
    width: calc(100vw - 28px);
  }
}
</style>
