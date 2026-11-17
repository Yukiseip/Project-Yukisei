<script setup lang="ts">
import type { AvatarPreset } from '../lib/avatar-presets'
import type { KvLayout } from '../lib/context-budget'
import type { OllamaModelSummary } from '../lib/ollama'
import type { MemoryCategory } from '../stores/memory'

import { errorMessageFrom } from '@moeru/std'
import { computed, onMounted, ref, watch } from 'vue'

import { useAudioDevices } from '../composables/use-audio-devices'
import { avatarPresets } from '../lib/avatar-presets'
import { bytesPerGb, contextForBudget, estimateTokens, kvBytes } from '../lib/context-budget'
import { deleteCustomModelZip, saveCustomModelZip } from '../lib/custom-model-storage'
import { getDesktopApi } from '../lib/desktop-bridge'
import { getOllamaKvLayout, listOllamaModels } from '../lib/ollama'
import { inspectModelCapabilities, modelSupportsReasoning, modelSupportsVision } from '../lib/ollama-capabilities'
import { neuralVoicePresets, useTextToSpeech } from '../lib/tts'
import { useMemoryStore } from '../stores/memory'
import { defaultSettings, useSettingsStore } from '../stores/settings'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'modelUpdated'): void
}>()

const api = getDesktopApi()

const activeTab = ref<'brain' | 'avatar' | 'stt' | 'tts' | 'memory' | 'persona'>('brain')

const settings = useSettingsStore()
const memoryStore = useMemoryStore()
const tts = useTextToSpeech()
const audioDevices = useAudioDevices()
const workersStatus = ref<WorkersStatus | null>(null)
const newMemoryFact = ref('')
const newMemoryCategory = ref<MemoryCategory>('usuario')

function submitNewMemory() {
  if (!newMemoryFact.value.trim())
    return
  memoryStore.addMemory(newMemoryFact.value, newMemoryCategory.value)
  newMemoryFact.value = ''
}

async function refreshWorkersStatus() {
  if (!api?.getWorkersStatus)
    return
  try {
    workersStatus.value = await api.getWorkersStatus()
  }
  catch {}
}
const models = ref<OllamaModelSummary[]>([])
const connectionStatus = ref<'connecting' | 'connected' | 'error'>('connecting')
const statusMessage = ref('Conectando a Ollama…')
const layout = ref<KvLayout>()
const gpu = ref<GpuInfo | null>(null)
const personaNote = ref('')
const autoFeedback = ref('')
const avatarUploadError = ref('')
const avatarUploadSuccess = ref('')

const safetyMarginGb = 2.5
const workBuffersGb = 1.0
const autoContextLimit = 32768

const currentModelSummary = computed(() => models.value.find(m => m.name === settings.model))
const modelSizeGb = computed(() => (currentModelSummary.value?.size ?? 0) / bytesPerGb)

const currentModelSupportsVision = computed(() => {
  return modelSupportsVision(settings.model)
})

const currentModelSupportsReasoning = computed(() => {
  return modelSupportsReasoning(settings.model)
})

const availableForContextGb = computed(() => {
  const free = settings.gpuVramGb - modelSizeGb.value - safetyMarginGb - workBuffersGb
  return Math.max(0.5, free)
})

const contextVramGb = computed(() => {
  if (!layout.value)
    return (settings.numCtx * 32768) / bytesPerGb
  return kvBytes(layout.value, settings.numCtx) / bytesPerGb
})

const capabilities = computed(() => {
  return inspectModelCapabilities(
    settings.model,
    currentModelSummary.value?.size ?? 0,
    contextVramGb.value * bytesPerGb,
    gpu.value?.totalMb ?? 0,
    gpu.value?.freeMb ?? 0,
  )
})

const personaTokens = computed(() => estimateTokens(settings.persona))
const approxMessages = computed(() => Math.max(0, Math.floor((settings.numCtx - personaTokens.value - 1024) / 110)))

async function checkConnection() {
  if (settings.ollamaUrl) {
    settings.ollamaUrl = settings.ollamaUrl.trim().replace(/\/v1\/?$/, '').replace(/\/api\/?$/, '')
  }

  connectionStatus.value = 'connecting'
  statusMessage.value = 'Buscando modelos en Ollama…'

  try {
    const list = await listOllamaModels(settings.ollamaUrl)
    models.value = list

    if (list.length === 0) {
      connectionStatus.value = 'connected'
      statusMessage.value = 'Conectado, pero no hay modelos descargados en Ollama.'
      return
    }

    connectionStatus.value = 'connected'
    statusMessage.value = `Conectado. ${list.length} modelo(s) disponible(s).`

    if (!list.some(m => m.name === settings.model)) {
      settings.model = list[0]!.name
    }

    await loadModelDetails()
  }
  catch (err) {
    models.value = []
    connectionStatus.value = 'error'
    statusMessage.value = `Error: ${errorMessageFrom(err) ?? 'No se pudo conectar a Ollama'}`
  }
}

async function loadModelDetails() {
  if (!settings.model)
    return

  try {
    layout.value = await getOllamaKvLayout(settings.ollamaUrl, settings.model)
  }
  catch {
    layout.value = undefined
  }

  if (settings.memoryMode === 'auto') {
    applyAutoSettings()
  }
}

async function detectGpu() {
  try {
    const info = await api?.getGpuInfo()
    if (info && info.totalMb > 0) {
      gpu.value = info
      settings.gpuVramGb = Math.round(info.totalMb / 1024)
    }
  }
  catch {
    gpu.value = null
  }
}

function applyAutoSettings() {
  if (!layout.value)
    return

  const tokens = contextForBudget(layout.value, availableForContextGb.value * bytesPerGb, autoContextLimit)
  settings.numCtx = tokens
  settings.maxMessages = Math.min(150, Math.max(40, approxMessages.value))
  settings.maxTokens = 2048
  settings.temperature = 0.35

  autoFeedback.value = `Optimizado: ${tokens.toLocaleString()} tokens (~${contextVramGb.value.toFixed(1)} GB VRAM), ${settings.maxMessages} mensajes.`
}

function selectAutoMode() {
  settings.memoryMode = 'auto'
  applyAutoSettings()
}

function selectManualPreset(preset: 'gaming' | 'balanced' | 'deep') {
  settings.memoryMode = 'manual'
  if (!layout.value)
    return

  if (preset === 'gaming') {
    settings.numCtx = Math.min(8192, layout.value.maxContext)
    settings.maxMessages = 40
    settings.maxTokens = 1024
  }
  else if (preset === 'balanced') {
    settings.numCtx = Math.min(16384, layout.value.maxContext)
    settings.maxMessages = 80
    settings.maxTokens = 2048
  }
  else {
    settings.numCtx = Math.min(32768, layout.value.maxContext)
    settings.maxMessages = 150
    settings.maxTokens = 2048
  }
}

async function loadPersona(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return

  const text = (await file.text()).trim()
  input.value = ''
  if (!text) {
    personaNote.value = 'El archivo está vacío.'
    return
  }

  settings.persona = text
  settings.personaName = file.name
  personaNote.value = ''
}

async function handleAvatarZipPicked(event: Event) {
  avatarUploadError.value = ''
  avatarUploadSuccess.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return

  if (!file.name.toLowerCase().endsWith('.zip')) {
    avatarUploadError.value = 'El archivo debe ser un archivo comprimido .zip que contenga el modelo Live2D.'
    input.value = ''
    return
  }

  try {
    await saveCustomModelZip(file)
    settings.customModelName = file.name
    avatarUploadSuccess.value = `¡Modelo "${file.name}" cargado exitosamente!`
    emit('modelUpdated')
  }
  catch (err) {
    avatarUploadError.value = errorMessageFrom(err) ?? 'Error al guardar el modelo.'
  }
  finally {
    input.value = ''
  }
}

async function resetToDefaultAvatar() {
  await deleteCustomModelZip()
  settings.customModelName = ''
  avatarUploadSuccess.value = 'Modelo oficial (Hiyori) restablecido.'
  avatarUploadError.value = ''
  emit('modelUpdated')
}

const isApplyingPreset = ref(false)

async function selectPreset(preset: AvatarPreset) {
  avatarUploadError.value = ''
  avatarUploadSuccess.value = ''

  if (!preset.path) {
    await resetToDefaultAvatar()
    if (preset.initialFraming) {
      applyFraming(preset.initialFraming.scale, preset.initialFraming.offsetY, preset.initialFraming.offsetX)
    }
    return
  }

  isApplyingPreset.value = true
  try {
    const res = await fetch(preset.path)
    if (!res.ok)
      throw new Error(`No se pudo cargar el archivo: ${res.statusText}`)
    const blob = await res.blob()
    await saveCustomModelZip(blob)
    settings.customModelName = preset.name
    if (preset.initialFraming) {
      applyFraming(preset.initialFraming.scale, preset.initialFraming.offsetY, preset.initialFraming.offsetX)
    }
    avatarUploadSuccess.value = `¡Modelo "${preset.name}" activado correctamente!`
    emit('modelUpdated')
  }
  catch (err) {
    avatarUploadError.value = errorMessageFrom(err) ?? 'Error al activar el modelo.'
  }
  finally {
    isApplyingPreset.value = false
  }
}

function applyFraming(scale: number, y: number, x = 0) {
  settings.avatarScale = scale
  settings.avatarOffsetY = y
  settings.avatarOffsetX = x
}

function resetFraming() {
  applyFraming(0.85, -12, 0)
}

function setWindowSize(width: number, height: number) {
  settings.windowWidth = width
  settings.windowHeight = height
  if (api?.windowControl?.setSize) {
    void api.windowControl.setSize(width, height)
  }
}

function toggleMicTest() {
  if (audioDevices.isTestingMic.value) {
    audioDevices.stopMicMeter()
  }
  else {
    void audioDevices.startMicMeter(settings.audioInputDeviceId, settings.micGain)
  }
}

watch(() => settings.model, loadModelDetails)
watch(() => settings.gpuVramGb, () => {
  if (settings.memoryMode === 'auto')
    applyAutoSettings()
})
watch(activeTab, (tab) => {
  if (tab === 'stt' || tab === 'tts') {
    void audioDevices.loadDevices()
  }
  if (tab !== 'stt') {
    audioDevices.stopMicMeter()
  }
})
watch(() => [settings.audioInputDeviceId, settings.micGain], () => {
  if (audioDevices.isTestingMic.value) {
    void audioDevices.startMicMeter(settings.audioInputDeviceId, settings.micGain)
  }
})

onMounted(async () => {
  await Promise.all([
    detectGpu(),
    checkConnection(),
    refreshWorkersStatus(),
    tts.loadVoices(),
    audioDevices.loadDevices(),
  ])
})
</script>

<template>
  <div class="settings-sheet">
    <!-- SHEET HEADER -->
    <div class="sheet-header">
      <div class="title-group">
        <h3 class="sheet-title">
          Ajustes
        </h3>
        <span class="status-pill" :class="connectionStatus">
          <span class="dot" />
          {{ connectionStatus === 'connected' ? 'Ollama' : connectionStatus === 'connecting' ? 'Buscando' : 'Sin Ollama' }}
        </span>
        <span
          v-if="workersStatus"
          class="status-pill"
          :class="workersStatus.whisperReady ? 'connected' : 'connecting'"
          title="Estado del motor de reconocimiento de voz Faster-Whisper (CPU)"
        >
          <span class="dot" />
          Whisper
        </span>
        <span
          v-if="workersStatus"
          class="status-pill"
          :class="workersStatus.ttsReady ? 'connected' : 'connecting'"
          title="Estado del motor de síntesis de voz neural Edge-TTS"
        >
          <span class="dot" />
          Edge-TTS
        </span>
      </div>
      <button type="button" class="close-btn" title="Cerrar ajustes" @click="emit('close')">
        <svg viewBox="0 0 24 24" class="svg-icon">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <!-- CATEGORY TABS -->
    <div class="nav-tabs">
      <button
        type="button"
        class="tab-link"
        :class="{ active: activeTab === 'brain' }"
        @click="activeTab = 'brain'"
      >
        Cerebro
      </button>
      <button
        type="button"
        class="tab-link"
        :class="{ active: activeTab === 'avatar' }"
        @click="activeTab = 'avatar'"
      >
        Avatar
      </button>
      <button
        type="button"
        class="tab-link"
        :class="{ active: activeTab === 'stt' }"
        @click="activeTab = 'stt'"
      >
        Oído
      </button>
      <button
        type="button"
        class="tab-link"
        :class="{ active: activeTab === 'tts' }"
        @click="activeTab = 'tts'"
      >
        Voz
      </button>
      <button
        type="button"
        class="tab-link"
        :class="{ active: activeTab === 'memory' }"
        @click="activeTab = 'memory'"
      >
        Memoria ({{ memoryStore.items.length }})
      </button>
      <button
        type="button"
        class="tab-link"
        :class="{ active: activeTab === 'persona' }"
        @click="activeTab = 'persona'"
      >
        Personalidad
      </button>
    </div>

    <!-- TAB CONTENTS -->
    <div class="sheet-content">
      <!-- 1. CEREBRO / IA Y VRAM -->
      <div v-show="activeTab === 'brain'" class="tab-panel">
        <div class="field-group">
          <label class="field-label">Servidor Ollama</label>
          <div class="input-row">
            <input v-model="settings.ollamaUrl" class="text-input" placeholder="http://127.0.0.1:11434" @change="checkConnection">
            <button type="button" class="btn-secondary" @click="checkConnection">
              Verificar
            </button>
          </div>
          <span class="field-hint" :class="{ error: connectionStatus === 'error' }">
            {{ statusMessage }}
          </span>
        </div>

        <div class="field-group">
          <label class="field-label">Modelo activo</label>
          <select v-model="settings.model" class="select-input" :disabled="models.length === 0">
            <option v-if="models.length === 0" :value="settings.model">
              {{ settings.model }} (sin conexión)
            </option>
            <option v-for="m in models" :key="m.name" :value="m.name">
              {{ m.name }} — {{ (m.size / bytesPerGb).toFixed(1) }} GB
            </option>
          </select>

          <!-- MODEL CAPABILITIES BADGES -->
          <div class="capability-badges-row">
            <span
              class="capability-tag"
              :class="{ supported: currentModelSupportsVision, unsupported: !currentModelSupportsVision }"
              :title="currentModelSupportsVision ? 'Este modelo puede ver tu pantalla y analizar imágenes' : 'Este modelo solo procesa texto. La visión estará desactivada.'"
            >
              {{ currentModelSupportsVision ? '👁️ Visión multimodal' : '⚠️ Sin visión (solo texto)' }}
            </span>
            <span
              v-if="currentModelSupportsReasoning"
              class="capability-tag supported"
              title="Soporta proceso de razonamiento y etiquetas de pensamiento"
            >
              🧠 Razonamiento nativo
            </span>
          </div>

          <p v-if="!currentModelSupportsVision" class="warning-callout">
            Aviso: Este modelo no soporta visión multimodal. La captura de pantalla y el análisis de imágenes estarán desactivados mientras esté seleccionado.
          </p>
        </div>

        <div class="field-group toggle-row">
          <div>
            <div class="field-label-bold">
              Modo razonamiento
            </div>
            <div class="field-hint">
              Muestra el proceso de pensamiento del modelo
            </div>
          </div>
          <input v-model="settings.think" type="checkbox" class="toggle-switch">
        </div>

        <!-- VRAM METER CARD (100% REAL) -->
        <div class="glass-card vram-box" :class="capabilities.fitsInVram">
          <div class="vram-top">
            <span class="card-caption">Memoria gráfica real (GPU)</span>
            <span class="vram-digits">{{ capabilities.totalRequiredGb.toFixed(1) }} / {{ settings.gpuVramGb }} GB</span>
          </div>
          <div class="meter-track">
            <div class="meter-bar" :style="{ width: `${Math.min(100, Math.round((capabilities.totalRequiredGb / settings.gpuVramGb) * 100))}%` }" />
          </div>
          <div class="vram-foot">
            <span>{{ capabilities.summaryText }}</span>
          </div>
        </div>

        <!-- PRESETS -->
        <div class="field-group">
          <label class="field-label">Perfil de memoria de conversación</label>
          <div class="preset-segmented">
            <button
              type="button"
              class="segment-btn"
              :class="{ active: settings.memoryMode === 'auto' }"
              @click="selectAutoMode"
            >
              Auto
            </button>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: settings.memoryMode === 'manual' && settings.numCtx <= 8192 }"
              @click="selectManualPreset('gaming')"
            >
              Juegos (8k)
            </button>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: settings.memoryMode === 'manual' && settings.numCtx > 8192 && settings.numCtx <= 16384 }"
              @click="selectManualPreset('balanced')"
            >
              Equilibrado
            </button>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: settings.memoryMode === 'manual' && settings.numCtx > 16384 }"
              @click="selectManualPreset('deep')"
            >
              Profundo
            </button>
          </div>
          <span v-if="settings.memoryMode === 'auto'" class="field-hint">
            {{ autoFeedback || 'Calculando configuración recomendada...' }}
          </span>
        </div>

        <div class="field-group">
          <div class="slider-header">
            <label class="field-label">Temperatura (creatividad)</label>
            <span class="slider-val">{{ settings.temperature.toFixed(2) }}</span>
          </div>
          <input v-model.number="settings.temperature" type="range" min="0.1" max="1.0" step="0.05" class="range-slider">
          <span class="field-hint">0.35 recomendado para exactitud e ingenio sin inventar datos.</span>
        </div>

        <div class="field-group toggle-row">
          <div>
            <div class="field-label-bold">
              Investigación en la red (Web Search)
            </div>
            <div class="field-hint">
              Permite a Yukisei consultar datos actualizados en internet
            </div>
          </div>
          <input v-model="settings.webSearchEnabled" type="checkbox" class="toggle-switch">
        </div>

        <div v-if="settings.webSearchEnabled" class="field-group">
          <div class="slider-header">
            <label class="field-label">Fuentes web por consulta</label>
            <span class="slider-val">{{ settings.webSearchMaxResults }}</span>
          </div>
          <input v-model.number="settings.webSearchMaxResults" type="range" min="1" max="6" step="1" class="range-slider">
          <span class="field-hint">Páginas seguras consultadas para contrastar información en tiempo real.</span>
        </div>

        <div class="field-group toggle-row">
          <div>
            <div class="field-label-bold">
              Control de escritorio (Desktop Tool Calling)
            </div>
            <div class="field-hint">
              Permite a Yukisei controlar volumen, música, abrir apps y gestionar archivos con tu permiso
            </div>
          </div>
          <input v-model="settings.desktopToolsEnabled" type="checkbox" class="toggle-switch">
        </div>
      </div>

      <!-- 2. AVATAR / MODELO LIVE2D -->
      <div v-show="activeTab === 'avatar'" class="tab-panel">
        <!-- DIMENSIONES DE LA VENTANA (CAJA) -->
        <div class="field-group">
          <div class="slider-header">
            <label class="field-label-bold">Tamaño de la ventana (Caja)</label>
            <span class="slider-val">{{ settings.windowWidth }} × {{ settings.windowHeight }} px</span>
          </div>

          <div class="preset-segmented">
            <button
              type="button"
              class="segment-btn"
              :class="{ active: settings.windowWidth === 440 && settings.windowHeight === 740 }"
              @click="setWindowSize(440, 740)"
            >
              Compacto
            </button>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: settings.windowWidth === 520 && settings.windowHeight === 790 }"
              @click="setWindowSize(520, 790)"
            >
              Estándar
            </button>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: settings.windowWidth === 640 && settings.windowHeight === 850 }"
              @click="setWindowSize(640, 850)"
            >
              Amplio
            </button>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: settings.windowWidth === 760 && settings.windowHeight === 920 }"
              @click="setWindowSize(760, 920)"
            >
              Extra amplio
            </button>
          </div>

          <div class="slider-grid" style="margin-top: 6px;">
            <div>
              <div class="slider-header">
                <span class="field-label">Ancho (px)</span>
                <span class="slider-val">{{ settings.windowWidth }}</span>
              </div>
              <input
                v-model.number="settings.windowWidth"
                type="range"
                min="360"
                max="900"
                step="10"
                class="range-slider"
                @input="setWindowSize(settings.windowWidth, settings.windowHeight)"
              >
            </div>
            <div>
              <div class="slider-header">
                <span class="field-label">Alto (px)</span>
                <span class="slider-val">{{ settings.windowHeight }}</span>
              </div>
              <input
                v-model.number="settings.windowHeight"
                type="range"
                min="500"
                max="1100"
                step="10"
                class="range-slider"
                @input="setWindowSize(settings.windowWidth, settings.windowHeight)"
              >
            </div>
          </div>
          <span class="field-hint">
            Amplía la caja si tu modelo tiene accesorios o elementos anchos para evitar que se corten los bordes.
          </span>
        </div>

        <div class="group-separator" />

        <!-- ENCUADRE Y ESCALA -->
        <div class="field-group">
          <div class="slider-header">
            <label class="field-label-bold">Escala del personaje (Zoom)</label>
            <span class="slider-val">{{ Math.round(settings.avatarScale * 100) }}%</span>
          </div>
          <input
            v-model.number="settings.avatarScale"
            type="range"
            min="0.2"
            max="2.5"
            step="0.05"
            class="range-slider"
          >
        </div>

        <div class="slider-grid">
          <div class="field-group">
            <div class="slider-header">
              <label class="field-label">Posición Y (Vertical)</label>
              <span class="slider-val">{{ settings.avatarOffsetY }}%</span>
            </div>
            <input
              v-model.number="settings.avatarOffsetY"
              type="range"
              min="-45"
              max="45"
              step="1"
              class="range-slider"
            >
            <div class="slider-range-subtext">
              <span>Bajar (Más margen superior)</span>
              <span>Subir</span>
            </div>
          </div>

          <div class="field-group">
            <div class="slider-header">
              <label class="field-label">Posición X (Horizontal)</label>
              <span class="slider-val">{{ settings.avatarOffsetX }}%</span>
            </div>
            <input
              v-model.number="settings.avatarOffsetX"
              type="range"
              min="-60"
              max="60"
              step="1"
              class="range-slider"
            >
            <div class="slider-range-subtext">
              <span>Izquierda</span>
              <span>Derecha</span>
            </div>
          </div>
        </div>

        <!-- BOTONES DE ENCUADRE RÁPIDO -->
        <div class="field-group">
          <label class="field-label">Encuadre rápido</label>
          <div class="framing-buttons-grid">
            <button
              type="button"
              class="btn-secondary"
              title="Primer plano de la cabeza y expresión"
              @click="applyFraming(0.95, -8, 0)"
            >
              👤 Busto
            </button>
            <button
              type="button"
              class="btn-secondary"
              title="Encuadre medio con margen superior elevado"
              @click="applyFraming(0.85, -14, 0)"
            >
              👗 Medio
            </button>
            <button
              type="button"
              class="btn-secondary"
              title="Vista amplia"
              @click="applyFraming(0.55, 12, 0)"
            >
              🧍 Amplio
            </button>
            <button
              type="button"
              class="btn-secondary"
              title="Centrar como estaba antes con margen superior"
              @click="resetFraming"
            >
              🎯 Centrar
            </button>
          </div>
          <span class="field-hint">
            💡 Tip: Usa la rueda del ratón sobre Yukisei para hacer zoom, o clic derecho / Shift+Arrastrar para moverla libremente.
          </span>
        </div>

        <!-- CARGAR MODELO PERSONALIZADO -->
        <div class="group-separator" />

        <!-- MODELO ACTIVO Y ACCIONES -->
        <div class="field-group">
          <label class="field-label-bold">Modelo Live2D en uso</label>
          <div class="active-model-box">
            <span class="model-badge-icon">✨</span>
            <span class="model-badge-name">{{ settings.customModelName || 'Hiyori Oficial (Por defecto)' }}</span>
          </div>

          <div class="actions-row">
            <label class="btn-primary file-upload-label">
              <span>📁 Cargar otro .zip</span>
              <input type="file" accept=".zip" style="display: none" @change="handleAvatarZipPicked">
            </label>
            <button
              v-if="settings.customModelName"
              type="button"
              class="btn-secondary"
              @click="resetToDefaultAvatar"
            >
              Restablecer oficial
            </button>
          </div>

          <p v-if="avatarUploadSuccess" class="callout-success">
            {{ avatarUploadSuccess }}
          </p>
          <p v-if="avatarUploadError" class="callout-error">
            {{ avatarUploadError }}
          </p>
        </div>

        <!-- GALERÍA DE AVATARES PREDEFINIDOS -->
        <div class="field-group">
          <div class="slider-header">
            <label class="field-label-bold">Galería de avatares listos para probar</label>
            <span v-if="isApplyingPreset" class="badge-loading">Cargando...</span>
          </div>

          <div class="preset-avatar-grid">
            <button
              v-for="preset in avatarPresets"
              :key="preset.id"
              type="button"
              class="avatar-card"
              :class="{ active: (settings.customModelName === preset.name) || (!settings.customModelName && !preset.path) }"
              :disabled="isApplyingPreset"
              @click="selectPreset(preset)"
            >
              <div class="avatar-card-top">
                <span class="avatar-badge">{{ preset.badge }}</span>
              </div>
              <div class="avatar-card-name">
                {{ preset.name }}
              </div>
              <div class="avatar-card-sub">
                {{ preset.subtitle }}
              </div>
            </button>
          </div>
          <span class="field-hint">
            Haz clic en cualquiera para cambiarlo al instante. También puedes arrastrar cualquier archivo .zip desde tu explorador sobre Yukisei.
          </span>
        </div>

        <!-- GUÍA DE REQUISITOS -->
        <details class="guide-details">
          <summary class="guide-summary">
            <span>ℹ️ ¿Qué requisitos debe tener un modelo Live2D?</span>
          </summary>
          <div class="guide-body">
            <p class="guide-lead">
              Para que un modelo gesticule, hable y sincronice la boca al igual que Hiyori, el archivo <code>.zip</code> debe incluir:
            </p>
            <ul class="guide-list">
              <li><b>Formato compatible:</b> Live2D Cubism 3, 4 o 5 con su archivo <code>.model3.json</code>, el archivo <code>.moc3</code> y texturas en PNG.</li>
              <li><b>Sincronización labial (Lip Sync):</b> Parámetro <code>ParamMouthOpenY</code> (de 0 a 1) para modular los labios al hablar.</li>
              <li><b>Expresiones y sonrisas:</b> Parámetros <code>ParamMouthForm</code> (-1 a 1) y <code>ParamCheek</code> (sonrojo de 0 a 1).</li>
              <li><b>Inclinación de cabeza y cuerpo:</b> Parámetros <code>ParamAngleX</code>, <code>ParamAngleY</code>, <code>ParamAngleZ</code> y <code>ParamBodyAngleX</code>.</li>
              <li><b>Gesticulaciones automáticas:</b> Grupo de animaciones <code>Idle</code> o <code>Tap</code> configuradas en el <code>model3.json</code>.</li>
            </ul>
          </div>
        </details>
      </div>

      <!-- 3. OÍDO / SPEECH TO TEXT -->
      <div v-show="activeTab === 'stt'" class="tab-panel">
        <div class="field-group">
          <label class="field-label">Motor de transcripción</label>
          <select v-model="settings.sttProvider" class="select-input">
            <option value="local-whisper">
              Faster-Whisper local (CPU int8 · 0 VRAM · Offline)
            </option>
            <option value="whisper-api">
              API remota compatible con OpenAI / Groq
            </option>
          </select>
        </div>

        <!-- DISPOSITIVO DE ENTRADA (MICRÓFONO) -->
        <div class="field-group">
          <div class="slider-header">
            <label class="field-label-bold">Dispositivo de entrada (Micrófono)</label>
            <button
              type="button"
              class="refresh-dev-btn"
              title="Actualizar lista de dispositivos"
              @click="audioDevices.loadDevices"
            >
              🔄
            </button>
          </div>
          <select v-model="settings.audioInputDeviceId" class="select-input">
            <option value="">
              Por defecto del sistema
            </option>
            <option v-for="dev in audioDevices.audioInputs.value" :key="dev.deviceId" :value="dev.deviceId">
              {{ dev.label }}
            </option>
          </select>
          <span class="field-hint">Selecciona el micrófono físico con el que hablas a Yukisei.</span>
        </div>

        <!-- PRUEBA EN VIVO DE MICRÓFONO CON MEDIDOR VU -->
        <div class="field-group mic-test-card">
          <div class="mic-test-header">
            <span class="field-label-bold">Comprobación de señal de voz</span>
            <button
              type="button"
              class="mic-test-toggle-btn"
              :class="{ active: audioDevices.isTestingMic.value }"
              @click="toggleMicTest"
            >
              {{ audioDevices.isTestingMic.value ? '⏹️ Detener prueba' : '🎙️ Probar micrófono en vivo' }}
            </button>
          </div>
          <div v-if="audioDevices.isTestingMic.value" class="meter-wrapper">
            <div class="meter-track">
              <div
                class="meter-fill"
                :class="{
                  active: audioDevices.micMeterLevel.value > 15,
                  loud: audioDevices.micMeterLevel.value > 65,
                }"
                :style="{ width: `${audioDevices.micMeterLevel.value}%` }"
              />
            </div>
            <div class="meter-labels">
              <span class="meter-status">
                {{ audioDevices.micMeterLevel.value > 15 ? '🟢 Voz detectada' : '⚪ Silencio / Habla al micrófono...' }}
              </span>
              <span class="meter-num">{{ audioDevices.micMeterLevel.value }}%</span>
            </div>
          </div>
          <span class="field-hint">
            Habla normal. Si la barra verde sube cuando hablas, Yukisei te escuchará perfectamente.
          </span>
        </div>

        <div class="field-group">
          <div class="slider-header">
            <label class="field-label">Sensibilidad del micrófono (VAD)</label>
            <span class="slider-val">{{ settings.micSensitivity }}%</span>
          </div>
          <input v-model.number="settings.micSensitivity" type="range" min="1" max="100" step="1" class="range-slider">
          <span class="field-hint">
            {{ settings.micSensitivity > 65 ? 'Alta: capta susurros y voces lejanas.' : settings.micSensitivity < 35 ? 'Baja: filtra ruidos de teclado, clics y ventiladores.' : 'Equilibrada para conversación normal.' }}
          </span>
        </div>

        <div class="field-group">
          <div class="slider-header">
            <label class="field-label">Volumen / Ganancia de entrada</label>
            <span class="slider-val">{{ Math.round(settings.micGain * 100) }}%</span>
          </div>
          <input v-model.number="settings.micGain" type="range" min="0.2" max="3.0" step="0.1" class="range-slider">
          <span class="field-hint">Amplifica digitalmente la señal de audio antes del análisis.</span>
        </div>

        <div class="field-group toggle-row">
          <div>
            <div class="field-label-bold">
              Envío automático (manos libres)
            </div>
            <div class="field-hint">
              Envía el mensaje tras detectar silencio continuo
            </div>
          </div>
          <input v-model="settings.autoSendVoice" type="checkbox" class="toggle-switch">
        </div>

        <div v-if="settings.autoSendVoice" class="field-group">
          <div class="slider-header">
            <label class="field-label">Tiempo de silencio para enviar</label>
            <span class="slider-val">{{ settings.silenceTimeoutSeconds }}s</span>
          </div>
          <input v-model.number="settings.silenceTimeoutSeconds" type="range" min="2" max="10" step="1" class="range-slider">
          <span class="field-hint">Pausa requerida para disparar el envío automático.</span>
        </div>

        <div v-if="settings.sttProvider === 'whisper-api'" class="glass-card">
          <div class="field-group">
            <label class="field-label">URL del servicio</label>
            <input v-model="settings.whisperUrl" class="text-input" placeholder="https://api.groq.com/openai/v1">
          </div>
          <div class="field-group">
            <label class="field-label">Clave API</label>
            <input v-model="settings.whisperApiKey" type="password" class="text-input" placeholder="gsk_...">
          </div>
        </div>
      </div>

      <!-- 3. VOZ / TEXT TO SPEECH -->
      <div v-show="activeTab === 'tts'" class="tab-panel">
        <div class="field-group toggle-row">
          <div>
            <div class="field-label-bold">
              Voz hablada de Yukisei
            </div>
            <div class="field-hint">
              Respuestas leídas con síntesis de voz
            </div>
          </div>
          <input v-model="settings.ttsEnabled" type="checkbox" class="toggle-switch">
        </div>

        <template v-if="settings.ttsEnabled">
          <div class="field-group">
            <label class="field-label">Motor de voz</label>
            <select v-model="settings.ttsProvider" class="select-input">
              <option value="neural">
                Voz Neural Anime (Edge TTS · Femenina fluida)
              </option>
              <option value="player2">
                Player 2 (Servidor local puerto 4315)
              </option>
              <option value="browser">
                Sintetizador de Windows
              </option>
            </select>
          </div>

          <!-- DISPOSITIVO DE SALIDA (ALTAVOCES / AURICULARES) -->
          <div class="field-group">
            <div class="slider-header">
              <label class="field-label-bold">Dispositivo de salida (Altavoces / Auriculares)</label>
              <button
                type="button"
                class="test-sound-btn"
                title="Probar sonido en este dispositivo"
                @click="audioDevices.testAudioOutput(settings.audioOutputDeviceId)"
              >
                🔊 Probar sonido
              </button>
            </div>
            <select v-model="settings.audioOutputDeviceId" class="select-input">
              <option value="">
                Por defecto del sistema
              </option>
              <option v-for="dev in audioDevices.audioOutputs.value" :key="dev.deviceId" :value="dev.deviceId">
                {{ dev.label }}
              </option>
            </select>
            <span class="field-hint">Selecciona tus auriculares o altavoces preferidos para escuchar a Yukisei.</span>
          </div>

          <div v-if="settings.ttsProvider === 'neural'" class="field-group">
            <label class="field-label">Voz recomendada</label>
            <select v-model="settings.neuralVoice" class="select-input">
              <option v-for="v in neuralVoicePresets" :key="v.id" :value="v.id">
                {{ v.name }}
              </option>
            </select>

            <label class="field-label" style="margin-top: 10px;">Tono (Pitch)</label>
            <select v-model="settings.neuralPitch" class="select-input">
              <option value="+12Hz">
                Anime alegre (+12Hz)
              </option>
              <option value="+8Hz">
                Dulce y serena (+8Hz · Recomendada)
              </option>
              <option value="+4Hz">
                Natural suave (+4Hz)
              </option>
              <option value="+0Hz">
                Estándar neutra (+0Hz)
              </option>
            </select>
          </div>

          <div class="slider-grid">
            <div class="field-group">
              <div class="slider-header">
                <label class="field-label">Velocidad</label>
                <span class="slider-val">{{ settings.ttsSpeed.toFixed(2) }}x</span>
              </div>
              <input v-model.number="settings.ttsSpeed" type="range" min="0.8" max="1.5" step="0.05" class="range-slider">
            </div>

            <div class="field-group">
              <div class="slider-header">
                <label class="field-label">Volumen</label>
                <span class="slider-val">{{ Math.round(settings.ttsVolume * 100) }}%</span>
              </div>
              <input v-model.number="settings.ttsVolume" type="range" min="0.1" max="1.0" step="0.05" class="range-slider">
            </div>
          </div>

          <button
            type="button"
            class="btn-secondary full-width"
            :disabled="tts.isSpeaking.value"
            @click="tts.testVoice()"
          >
            {{ tts.isSpeaking.value ? 'Reproduciendo audio…' : 'Probar muestra de voz' }}
          </button>
        </template>
      </div>

      <!-- 4. PERSONALIDAD -->
      <div v-show="activeTab === 'persona'" class="tab-panel">
        <div class="glass-card">
          <div class="card-caption">
            Perfil cargado
          </div>
          <div class="persona-name">
            {{ settings.personaName }}
          </div>
          <div class="field-hint">
            {{ settings.persona.length.toLocaleString() }} caracteres (≈ {{ personaTokens.toLocaleString() }} tokens)
          </div>
        </div>

        <div class="persona-actions">
          <label class="btn-secondary file-btn">
            Cargar archivo .md
            <input type="file" accept=".md,.markdown,.txt" hidden @change="loadPersona">
          </label>

          <button
            v-if="settings.persona !== defaultSettings.persona"
            type="button"
            class="btn-secondary"
            @click="settings.reset(['persona', 'personaName'])"
          >
            Restaurar predeterminada
          </button>
        </div>

        <details class="prompt-preview">
          <summary>Ver instrucciones del prompt</summary>
          <pre class="prompt-text">{{ settings.persona }}</pre>
        </details>
      </div>

      <!-- 6. MEMORIA A LARGO PLAZO -->
      <div v-show="activeTab === 'memory'" class="tab-panel">
        <div class="toggle-card">
          <div>
            <div class="field-label-bold">
              🧠 Aprendizaje automático de recuerdos
            </div>
            <div class="field-hint">
              Yukisei detecta y recuerda datos importantes sobre ti (nombre, gustos, proyectos y preferencias) entre sesiones, incluso cuando limpias el chat.
            </div>
          </div>
          <label class="switch">
            <input v-model="settings.autoMemoryEnabled" type="checkbox">
            <span class="slider-toggle" />
          </label>
        </div>

        <form class="field-group" @submit.prevent="submitNewMemory">
          <label class="field-label">Añadir recuerdo manualmente</label>
          <div class="input-row">
            <select v-model="newMemoryCategory" class="select-input memory-cat-select">
              <option value="usuario">
                Usuario
              </option>
              <option value="preferencia">
                Preferencia
              </option>
              <option value="proyecto">
                Proyecto
              </option>
              <option value="nota">
                Nota
              </option>
            </select>
            <input
              v-model="newMemoryFact"
              class="text-input"
              placeholder="Ej: Me llamo Alex y uso Windows 11 con RTX 4070..."
            >
            <button type="submit" class="btn-secondary">
              Guardar
            </button>
          </div>
        </form>

        <div class="field-group">
          <div class="slider-header">
            <label class="field-label">Recuerdos guardados ({{ memoryStore.items.length }})</label>
            <button
              v-if="memoryStore.items.length > 0"
              type="button"
              class="text-btn danger-text"
              @click="memoryStore.clearMemories()"
            >
              Borrar todos
            </button>
          </div>

          <div v-if="memoryStore.items.length === 0" class="memory-empty">
            Aún no hay recuerdos guardados. Conversa con Yukisei o añade uno arriba.
          </div>

          <div v-else class="memory-list">
            <div v-for="item in memoryStore.items" :key="item.id" class="memory-row">
              <span class="memory-badge" :class="item.category">{{ item.category }}</span>
              <span class="memory-fact">{{ item.fact }}</span>
              <button
                type="button"
                class="memory-del-btn"
                title="Eliminar este recuerdo"
                @click="memoryStore.removeMemory(item.id)"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-sheet {
  display: flex;
  flex-direction: column;
  height: 480px;
  max-height: 65vh;
  border-radius: 20px;
  background: var(--bg-glass-elevated);
  backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid var(--border-glass);
  box-shadow: 0 16px 36px -10px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  overflow: hidden;
  animation: sheetIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  color: var(--text-primary);
}

@keyframes sheetIn {
  from { opacity: 0; transform: translateY(16px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-glass);
}

.title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sheet-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted);
}

.status-pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}

.status-pill.connected {
  color: #34d399;
  background: rgba(16, 185, 129, 0.12);
}

.status-pill.connected .dot {
  background: var(--emerald-live);
}

.status-pill.error {
  color: #fb7185;
}

.status-pill.error .dot {
  background: var(--rose-stop);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

/* NAV TABS */
.nav-tabs {
  display: flex;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-glass);
  background: rgba(0, 0, 0, 0.15);
  gap: 4px;
}

.tab-link {
  flex: 1;
  padding: 6px 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-link:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.05);
}

.tab-link.active {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.12);
  font-weight: 600;
}

/* CONTENT & FIELDS */
.sheet-content {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}

.tab-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 12px;
  color: var(--text-muted);
}

.field-label-bold {
  font-size: 13px;
  font-weight: 500;
}

.field-hint {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.35;
}

.field-hint.error {
  color: #fb7185;
}

.text-input,
.select-input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-glass);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}

.text-input:focus,
.select-input:focus {
  border-color: var(--border-glass-focus);
}

.select-input option {
  background: #141823;
  color: #f8fafc;
}

.input-row {
  display: flex;
  gap: 6px;
}

.toggle-row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
}

.toggle-switch {
  width: 36px;
  height: 20px;
  accent-color: var(--accent-iris);
  cursor: pointer;
}

/* VRAM BOX */
.glass-card {
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-glass);
}

.vram-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.card-caption {
  font-size: 11px;
  color: var(--text-muted);
}

.vram-digits {
  font-size: 12px;
  font-weight: 600;
}

.meter-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  margin-bottom: 6px;
}

.meter-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent-iris);
  transition: width 0.3s ease;
}

.vram-box.tight .meter-bar {
  background: var(--amber-warn);
}

.vram-box.over .meter-bar {
  background: var(--rose-stop);
}

.vram-foot {
  font-size: 11px;
  color: var(--text-dim);
}

/* BUTTONS */
.btn-secondary {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-glass);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}

.btn-secondary.full-width {
  width: 100%;
}

.btn-secondary:disabled {
  opacity: 0.4;
  cursor: default;
}

/* PRESET SEGMENTED */
.preset-segmented {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.2);
}

.segment-btn {
  flex: 1;
  padding: 5px 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
}

.segment-btn.active {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
  font-weight: 600;
}

/* RANGE SLIDERS */
.slider-header {
  display: flex;
  justify-content: space-between;
}

.slider-val {
  font-size: 12px;
  font-weight: 600;
}

.range-slider {
  height: 4px;
  accent-color: var(--accent-iris);
  cursor: pointer;
  margin: 6px 0;
}

.slider-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

/* PERSONALITY */
.persona-name {
  font-size: 13px;
  font-weight: 600;
  margin: 2px 0;
}

.persona-actions {
  display: flex;
  gap: 8px;
}

.file-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.prompt-preview {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.prompt-preview summary {
  cursor: pointer;
  padding: 4px 0;
}

.prompt-text {
  margin-top: 6px;
  padding: 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.3);
  font-family: ui-monospace, monospace;
  font-size: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
  max-height: 150px;
  overflow-y: auto;
}

.svg-icon {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

/* CAPABILITIES */
.capability-badges-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.capability-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  user-select: none;
}

.capability-tag.supported {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.25);
}

.capability-tag.unsupported {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.25);
}

.warning-callout {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.2);
  color: #fbbf24;
  font-size: 11px;
  line-height: 1.4;
}

/* AVATAR TAB STYLES */
.slider-range-subtext {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-dim);
  margin-top: -2px;
}

.full-btn {
  width: 100%;
  padding: 7px 0;
  font-size: 12px;
}

.group-separator {
  height: 1px;
  background: var(--border-glass);
  margin: 14px 0;
}

.active-model-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-glass);
  margin: 6px 0 8px;
}

.model-badge-icon {
  font-size: 14px;
}

.model-badge-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.actions-row {
  display: flex;
  gap: 8px;
}

.file-upload-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
}

.callout-success {
  margin-top: 6px;
  font-size: 11px;
  color: #34d399;
}

.callout-error {
  margin-top: 6px;
  font-size: 11px;
  color: #fb7185;
}

.badge-loading {
  font-size: 11px;
  color: #a855f7;
  font-weight: 500;
}

.framing-buttons-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-top: 4px;
}

.preset-avatar-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 8px;
  max-height: 240px;
  overflow-y: auto;
  padding-right: 4px;
}

.avatar-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-glass);
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.avatar-card:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
}

.avatar-card.active {
  background: rgba(168, 85, 247, 0.16);
  border-color: rgba(168, 85, 247, 0.6);
  box-shadow: 0 0 12px rgba(168, 85, 247, 0.25);
}

.avatar-card:disabled {
  opacity: 0.5;
  cursor: wait;
}

.avatar-card-top {
  display: flex;
  width: 100%;
  margin-bottom: 4px;
}

.avatar-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-muted);
}

.avatar-card.active .avatar-badge {
  background: rgba(168, 85, 247, 0.3);
  color: #d8b4fe;
}

.avatar-card-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
}

.avatar-card-sub {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
  margin-top: 2px;
}

/* GUIDE DETAILS */
.guide-details {
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.15);
  border: 1px solid var(--border-glass);
  font-size: 11px;
}

.guide-summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text-muted);
  user-select: none;
}

.guide-summary:hover {
  color: var(--text-primary);
}

.guide-body {
  margin-top: 8px;
  color: var(--text-muted);
  line-height: 1.45;
}

.guide-lead {
  margin: 0 0 6px;
}

.guide-list {
  margin: 0;
  padding-left: 18px;
}

.guide-list li {
  margin-bottom: 4px;
}

.guide-list code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 4px;
  border-radius: 4px;
  color: #a5b4fc;
  font-family: ui-monospace, monospace;
}

/* AUDIO DEVICE SELECTION & VU METER */
.refresh-dev-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 4px;
  opacity: 0.7;
  transition: opacity 0.15s, transform 0.2s;
}

.refresh-dev-btn:hover {
  opacity: 1;
  transform: rotate(45deg);
}

.mic-test-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 10px 12px;
}

.mic-test-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mic-test-toggle-btn {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.35);
  color: #34d399;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mic-test-toggle-btn:hover {
  background: rgba(16, 185, 129, 0.25);
}

.mic-test-toggle-btn.active {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.4);
  color: #fca5a5;
}

.meter-wrapper {
  margin-top: 8px;
}

.meter-track {
  height: 10px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  width: 0%;
  background: #10b981;
  transition: width 0.05s ease-out;
  border-radius: 4px;
}

.meter-fill.loud {
  background: #f59e0b;
}

.meter-labels {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 4px;
}

.meter-status {
  font-weight: 500;
}

.meter-num {
  font-family: ui-monospace, monospace;
}

.test-sound-btn {
  background: rgba(99, 102, 241, 0.18);
  border: 1px solid rgba(99, 102, 241, 0.35);
  color: #a5b4fc;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.test-sound-btn:hover {
  background: rgba(99, 102, 241, 0.3);
}

/* Long-Term Memory Tab */
.memory-cat-select {
  width: 115px;
  flex-shrink: 0;
}

.memory-empty {
  padding: 18px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed rgba(255, 255, 255, 0.1);
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 210px;
  overflow-y: auto;
  padding-right: 2px;
}

.memory-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.memory-badge {
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  background: rgba(148, 163, 184, 0.2);
  color: #cbd5e1;
  flex-shrink: 0;
}

.memory-badge.usuario {
  background: rgba(99, 102, 241, 0.22);
  color: #c7d2fe;
}

.memory-badge.preferencia {
  background: rgba(236, 72, 153, 0.2);
  color: #fbcfe8;
}

.memory-badge.proyecto {
  background: rgba(16, 185, 129, 0.2);
  color: #a7f3d0;
}

.memory-fact {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.35;
}

.memory-del-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 5px;
  font-size: 11px;
  transition: all 0.15s ease;
}

.memory-del-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

.danger-text {
  color: #f87171 !important;
}
</style>
