<script setup lang="ts">
import type { AvatarEmotion } from './composables/use-avatar-emotions'

import { Live2DScene, useL2dViewControl } from '@proj-airi/stage-ui-live2d'
import { useSettingsLive2d } from '@proj-airi/stage-ui-live2d/composables/live2d'
import { useLive2dParams } from '@proj-airi/stage-ui-live2d/stores'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import ChatPanel from './components/chat-panel.vue'
import SettingsPanel from './components/settings-panel.vue'

import { emotionMetadata, useAvatarEmotions } from './composables/use-avatar-emotions'
import { loadCustomModelZip, saveCustomModelZip } from './lib/custom-model-storage'
import { getDesktopApi } from './lib/desktop-bridge'
import { useTextToSpeech } from './lib/tts'
import { useChatStore } from './stores/chat'
import { useSettingsStore } from './stores/settings'

const defaultModelUrl = './avatars/hiyori_free_zh.zip'

const showSettings = ref(false)
const isChatVisible = ref(true)

const api = getDesktopApi()

const tts = useTextToSpeech()
const chat = useChatStore()
const settings = useSettingsStore()
const emotions = useAvatarEmotions()
const live2dSettings = useSettingsLive2d()
const live2dStore = useLive2dParams()
live2dSettings.live2dShadowEnabled = false

// Synchronize character scaling and framing from settings to Live2D
const { scale: l2dScale, position: l2dPos } = useL2dViewControl()
watch(() => settings.avatarScale, (val) => {
  l2dScale.value = val
}, { immediate: true })

watch(() => settings.avatarOffsetY, (val) => {
  l2dPos.value.y = val
}, { immediate: true })

watch(() => settings.avatarOffsetX, (val) => {
  l2dPos.value.x = val
}, { immediate: true })

// Window box size synchronization
watch(() => [settings.windowWidth, settings.windowHeight], ([w, h]) => {
  if (api?.windowControl?.setSize && w && h) {
    void api.windowControl.setSize(w, h)
  }
})

// Direct canvas manipulation (Wheel zoom & Right-click / Shift+Drag pan)
const isPanning = ref(false)
let panStartX = 0
let panStartY = 0
let initialOffsetX = 0
let initialOffsetY = 0

function handleStageWheel(e: WheelEvent) {
  const delta = e.deltaY < 0 ? 0.05 : -0.05
  const nextScale = Math.round((settings.avatarScale + delta) * 100) / 100
  settings.avatarScale = Math.max(0.2, Math.min(2.5, nextScale))
}

function handleStageMouseDown(e: MouseEvent) {
  if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
    e.preventDefault()
    isPanning.value = true
    panStartX = e.clientX
    panStartY = e.clientY
    initialOffsetX = settings.avatarOffsetX
    initialOffsetY = settings.avatarOffsetY

    window.addEventListener('mousemove', handleStageMouseMove)
    window.addEventListener('mouseup', handleStageMouseUp)
  }
}

function handleStageMouseMove(e: MouseEvent) {
  if (!isPanning.value)
    return
  const dx = e.clientX - panStartX
  const dy = e.clientY - panStartY

  const deltaXPercent = (dx / window.innerWidth) * 100
  const deltaYPercent = (dy / window.innerHeight) * 100

  const newX = Math.round(initialOffsetX + deltaXPercent)
  const newY = Math.round(initialOffsetY - deltaYPercent)

  settings.avatarOffsetX = Math.max(-60, Math.min(60, newX))
  settings.avatarOffsetY = Math.max(-45, Math.min(45, newY))
}

function handleStageMouseUp() {
  if (isPanning.value) {
    isPanning.value = false
    window.removeEventListener('mousemove', handleStageMouseMove)
    window.removeEventListener('mouseup', handleStageMouseUp)
  }
}

function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
}

// Custom Live2D Model handling
const customModelBlobUrl = ref<string | null>(null)
const modelRevision = ref(Date.now())
const activeModelSrc = computed(() => customModelBlobUrl.value || defaultModelUrl)
const activeModelId = computed(() => {
  if (!customModelBlobUrl.value)
    return 'yukisei-default'
  const safeName = (settings.customModelName || 'custom').replace(/[^\w-]/g, '_')
  return `custom-${safeName}-${modelRevision.value}`
})

async function reloadCustomModel() {
  modelRevision.value = Date.now()
  const blob = await loadCustomModelZip()
  if (blob) {
    if (customModelBlobUrl.value) {
      URL.revokeObjectURL(customModelBlobUrl.value)
    }
    customModelBlobUrl.value = URL.createObjectURL(blob)
  }
  else if (customModelBlobUrl.value) {
    URL.revokeObjectURL(customModelBlobUrl.value)
    customModelBlobUrl.value = null
  }
}

const isDraggingZip = ref(false)

async function handleFileDrop(e: DragEvent) {
  e.preventDefault()
  isDraggingZip.value = false
  const file = e.dataTransfer?.files?.[0]
  if (!file)
    return

  if (file.name.toLowerCase().endsWith('.zip')) {
    await saveCustomModelZip(file)
    settings.customModelName = file.name
    await reloadCustomModel()
  }
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
    isDraggingZip.value = true
  }
}

function handleDragLeave(e: DragEvent) {
  e.preventDefault()
  isDraggingZip.value = false
}

// Window control: Always on top, minimize to tray, close
const isAlwaysOnTop = ref(settings.alwaysOnTop)
const showEmotionPicker = ref(false)
const gpuBadge = ref<{ tempC: number, usedGb: string } | null>(null)
let gpuPollTimer: ReturnType<typeof setInterval> | undefined

async function refreshGpuBadge() {
  if (!api?.getGpuInfo)
    return
  try {
    const info = await api.getGpuInfo()
    if (info && info.totalMb > 0) {
      const usedGb = ((info.totalMb - info.freeMb) / 1024).toFixed(1)
      gpuBadge.value = {
        tempC: info.tempC || 0,
        usedGb,
      }
    }
  }
  catch {}
}

function selectEmotion(emo: AvatarEmotion) {
  emotions.setEmotion(emo, 8000)
  showEmotionPicker.value = false
}

async function toggleAlwaysOnTop() {
  if (api?.windowControl?.toggleAlwaysOnTop) {
    const state = await api.windowControl.toggleAlwaysOnTop()
    isAlwaysOnTop.value = state
    settings.alwaysOnTop = state
  }
}

async function minimizeToTray() {
  if (api?.windowControl?.hide) {
    await api.windowControl.hide()
  }
}

async function closeApp() {
  if (api?.windowControl?.close) {
    await api.windowControl.close()
  }
}

onMounted(async () => {
  await reloadCustomModel()
  void refreshGpuBadge()
  gpuPollTimer = setInterval(refreshGpuBadge, 6000)

  if (api?.windowControl?.setSize && settings.windowWidth && settings.windowHeight) {
    void api.windowControl.setSize(settings.windowWidth, settings.windowHeight)
  }

  if (api?.onAppAction) {
    api.onAppAction((action) => {
      if (action === 'clear-chat') {
        chat.clear()
        tts.cancel()
      }
      else if (action === 'open-settings') {
        showSettings.value = true
      }
      else if (action === 'toggle-sound') {
        toggleSound()
      }
    })
  }
})

const mouthOpen = ref(0)
let lipSyncAnim: number | undefined
let speakingMotionTimer: ReturnType<typeof setInterval> | undefined

function playSpeakingMotion() {
  const available = live2dStore.availableMotions || []
  const speakMotions = available.filter(m => m.motionName === 'Speak')
  if (speakMotions.length > 0) {
    const idx = Math.floor(Math.random() * speakMotions.length)
    live2dStore.currentMotion = { group: 'Speak', index: idx }
    return
  }

  const tapMotions = available.filter(m => m.motionName === 'Tap' || m.motionName === 'Tap@Body')
  if (tapMotions.length > 0) {
    const selected = tapMotions[Math.floor(Math.random() * tapMotions.length)]
    if (selected) {
      live2dStore.currentMotion = { group: selected.motionName, index: selected.motionIndex }
      return
    }
  }

  const otherMotions = available.filter(m => !m.motionName.toLowerCase().includes('idle'))
  if (otherMotions.length > 0) {
    const selected = otherMotions[Math.floor(Math.random() * otherMotions.length)]
    if (selected) {
      live2dStore.currentMotion = { group: selected.motionName, index: selected.motionIndex }
    }
  }
}

function returnToIdleMotion() {
  live2dStore.currentMotion = { group: 'Idle', index: 0 }
}

// Dynamic Lip Sync & Talking Motions: animates mouth and natural gestures while AI speaks
watch(() => tts.isSpeaking.value, (speaking) => {
  if (speaking) {
    playSpeakingMotion()
    speakingMotionTimer = setInterval(playSpeakingMotion, 3200)

    const startTime = performance.now()
    const loop = (now: number) => {
      const elapsed = (now - startTime) / 1000
      const wave = Math.sin(elapsed * 16) * 0.35 + Math.sin(elapsed * 6) * 0.2 + 0.35
      mouthOpen.value = Math.max(0.05, Math.min(0.9, wave))
      lipSyncAnim = requestAnimationFrame(loop)
    }
    lipSyncAnim = requestAnimationFrame(loop)
  }
  else {
    if (speakingMotionTimer) {
      clearInterval(speakingMotionTimer)
      speakingMotionTimer = undefined
    }
    returnToIdleMotion()

    if (lipSyncAnim) {
      cancelAnimationFrame(lipSyncAnim)
      lipSyncAnim = undefined
    }
    mouthOpen.value = 0
  }
})

// Adopt thoughtful expression while Ollama is generating/thinking
watch(() => chat.busy, (isBusy) => {
  if (isBusy && emotions.currentEmotion.value === 'neutral') {
    emotions.setEmotion('think', 15000)
  }
})

onUnmounted(() => {
  if (lipSyncAnim)
    cancelAnimationFrame(lipSyncAnim)
  if (speakingMotionTimer)
    clearInterval(speakingMotionTimer)
  if (gpuPollTimer)
    clearInterval(gpuPollTimer)
  window.removeEventListener('mousemove', handleStageMouseMove)
  window.removeEventListener('mouseup', handleStageMouseUp)
})

function toggleSound() {
  settings.ttsEnabled = !settings.ttsEnabled
  if (!settings.ttsEnabled)
    tts.cancel()
}
</script>

<template>
  <div
    class="avatar-root"
    :class="{ 'drop-active': isDraggingZip }"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleFileDrop"
  >
    <!-- DRAG & DROP ZIP OVERLAY -->
    <div v-if="isDraggingZip" class="drop-zone-overlay">
      <div class="drop-pill">
        ✨ Suelta aquí el modelo (.zip) para cargarlo
      </div>
    </div>
    <!-- TOP FLOATING CAPSULE (Drag region & quick controls) -->
    <header class="top-capsule">
      <div class="drag-grip" title="Arrastra aquí para mover la ventana">
        <svg viewBox="0 0 24 24" class="grip-icon">
          <circle cx="8" cy="7" r="1.5" />
          <circle cx="16" cy="7" r="1.5" />
          <circle cx="8" cy="12" r="1.5" />
          <circle cx="16" cy="12" r="1.5" />
          <circle cx="8" cy="17" r="1.5" />
          <circle cx="16" cy="17" r="1.5" />
        </svg>
      </div>

      <div class="emotion-menu-wrap">
        <button
          type="button"
          class="emotion-chip"
          :title="`Emoción: ${emotions.activeMeta.value.label} (clic para elegir expresión)`"
          @click="showEmotionPicker = !showEmotionPicker"
        >
          <span class="emotion-dot" :class="emotions.currentEmotion.value" />
          <span class="emotion-text">{{ emotions.activeMeta.value.label }}</span>
        </button>

        <div v-if="showEmotionPicker" class="emotion-popover">
          <button
            v-for="(meta, key) in emotionMetadata"
            :key="key"
            type="button"
            class="emotion-option"
            :class="{ active: emotions.currentEmotion.value === key }"
            @click="selectEmotion(key as AvatarEmotion)"
          >
            <span>{{ meta.icon }}</span>
            <span>{{ meta.label }}</span>
          </button>
        </div>
      </div>

      <div
        v-if="gpuBadge"
        class="gpu-pill"
        :title="`GPU: ${gpuBadge.tempC}°C · VRAM en uso: ${gpuBadge.usedGb} GB`"
      >
        <span class="gpu-temp" :class="{ warm: gpuBadge.tempC >= 75 }">{{ gpuBadge.tempC }}°C</span>
        <span class="gpu-sep">·</span>
        <span class="gpu-vram">{{ gpuBadge.usedGb }}G</span>
      </div>

      <button
        type="button"
        class="capsule-btn"
        :class="{ active: settings.ttsEnabled }"
        :title="settings.ttsEnabled ? 'Voz activada' : 'Voz silenciada'"
        @click="toggleSound"
      >
        <svg v-if="settings.ttsEnabled" viewBox="0 0 24 24" class="svg-icon">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
        <svg v-else viewBox="0 0 24 24" class="svg-icon">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      </button>

      <button
        type="button"
        class="capsule-btn"
        :class="{ active: isChatVisible }"
        title="Alternar barra de conversación"
        @click="isChatVisible = !isChatVisible"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      <button
        type="button"
        class="capsule-btn"
        :class="{ active: showSettings }"
        title="Ajustes de Yukisei"
        @click="showSettings = !showSettings"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <span class="capsule-divider" />

      <button
        type="button"
        class="capsule-btn"
        :class="{ active: isAlwaysOnTop }"
        :title="isAlwaysOnTop ? 'Siempre encima activo (clic para desfijar)' : 'Fijar ventana siempre encima'"
        @click="toggleAlwaysOnTop"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <line x1="12" y1="17" x2="12" y2="22" />
          <path d="M5 17h14v-2l-2-2V5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v8l-2 2v2z" />
        </svg>
      </button>

      <button
        type="button"
        class="capsule-btn"
        title="Minimizar a la bandeja del sistema"
        @click="minimizeToTray"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      <button
        type="button"
        class="capsule-btn close-btn-top"
        title="Cerrar Yukisei"
        @click="closeApp"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>

    <!-- LIVE2D CANVAS (Full stage, character fully visible) -->
    <div
      class="stage"
      :class="{ 'is-panning': isPanning }"
      title="Rueda del ratón: Zoom · Clic derecho o Shift+Arrastrar: Mover personaje"
      @wheel.prevent="handleStageWheel"
      @mousedown="handleStageMouseDown"
      @contextmenu="handleContextMenu"
    >
      <Live2DScene
        :key="activeModelSrc"
        :model-src="activeModelSrc"
        :model-id="activeModelId"
        :now-speaking="tts.isSpeaking.value"
        :mouth-open-size="mouthOpen"
      />
    </div>

    <!-- SETTINGS MODAL SHEET -->
    <div v-if="showSettings" class="settings-overlay">
      <SettingsPanel @close="showSettings = false" @model-updated="reloadCustomModel" />
    </div>

    <!-- BOTTOM FLOATING CHAT DOCK (Minimalist, unobtrusive HUD) -->
    <div v-show="isChatVisible && !showSettings" class="bottom-dock">
      <ChatPanel />
    </div>
  </div>
</template>

<style scoped>
.avatar-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  transition: box-shadow 0.2s ease;
}

.avatar-root.drop-active {
  box-shadow: inset 0 0 0 3px rgba(168, 85, 247, 0.7);
}

.drop-zone-overlay {
  position: absolute;
  inset: 0;
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.65);
  backdrop-filter: blur(8px);
  pointer-events: none;
}

.drop-pill {
  padding: 12px 20px;
  background: linear-gradient(135deg, rgba(168, 85, 247, 0.9), rgba(59, 130, 246, 0.9));
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  border-radius: 999px;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
  letter-spacing: 0.2px;
}

.stage {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  cursor: default;
}

.stage.is-panning {
  cursor: grabbing;
}

/* TOP FLOATING CAPSULE */
.top-capsule {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: 999px;
  background: var(--bg-glass);
  backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid var(--border-glass);
  box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  opacity: 0.85;
  transition: opacity 0.2s ease;
  user-select: none;
}

.top-capsule:hover {
  opacity: 1;
}

.drag-grip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  cursor: grab;
  color: var(--text-dim);
  -webkit-app-region: drag;
  padding: 0 2px;
}

.grip-icon {
  width: 14px;
  height: 14px;
  fill: currentColor;
}

.emotion-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.emotion-chip:hover {
  background: rgba(255, 255, 255, 0.12);
}

.emotion-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #34d399;
}

.emotion-dot.happy { background: #f472b6; }
.emotion-dot.think { background: #818cf8; }
.emotion-dot.surprised { background: #fbbf24; }
.emotion-dot.awkward { background: #f87171; }
.emotion-dot.sad { background: #60a5fa; }
.emotion-dot.neutral { background: #34d399; }

.emotion-text {
  letter-spacing: -0.01em;
}

.emotion-menu-wrap {
  position: relative;
}

.emotion-popover {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 50;
  display: grid;
  grid-template-columns: repeat(2, minmax(92px, 1fr));
  gap: 4px;
  padding: 6px;
  border-radius: 14px;
  background: rgba(12, 13, 20, 0.94);
  backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.55);
}

.emotion-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.emotion-option:hover {
  background: rgba(255, 255, 255, 0.1);
}

.emotion-option.active {
  background: rgba(99, 102, 241, 0.22);
  border-color: rgba(129, 140, 248, 0.45);
  color: #c7d2fe;
}

.gpu-pill {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 10px;
  font-weight: 600;
  color: #94a3b8;
}

.gpu-temp {
  color: #34d399;
}

.gpu-temp.warm {
  color: #fbbf24;
}

.gpu-sep {
  opacity: 0.45;
}

.gpu-vram {
  color: #cbd5e1;
}

.capsule-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.capsule-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.capsule-btn.active {
  color: #a5b4fc;
}

.capsule-divider {
  width: 1px;
  height: 12px;
  background: var(--border-glass);
  margin: 0 1px;
}

.close-btn-top:hover {
  background: rgba(239, 68, 68, 0.2) !important;
  color: #f87171 !important;
}

/* SETTINGS MODAL OVERLAY */
.settings-overlay {
  position: absolute;
  right: 12px;
  bottom: 12px;
  left: 12px;
  z-index: 30;
  pointer-events: auto;
}

/* BOTTOM DOCK */
.bottom-dock {
  position: absolute;
  right: 12px;
  bottom: 12px;
  left: 12px;
  z-index: 15;
  pointer-events: none;
}

.svg-icon {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
