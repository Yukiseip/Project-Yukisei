<script setup lang="ts">
import type { ToolCallItem } from '../lib/desktop-tools'

import { errorMessageFrom } from '@moeru/std'
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import { useSpeechToText } from '../composables/speech-to-text'
import { useAvatarEmotions } from '../composables/use-avatar-emotions'
import {
  formatClipboardContext,
  formatSystemStatsContext,
  getToolDisplayInfo,
  sanitizeDisplayContent,
  shouldFetchClipboard,
  shouldFetchSystemStats,
} from '../lib/desktop-tools'
import { getDesktopApi } from '../lib/desktop-bridge'
import { renderMarkdown } from '../lib/markdown'
import { modelSupportsVision } from '../lib/ollama-capabilities'
import { useTextToSpeech } from '../lib/tts'
import { canCaptureScreen, captureScreen, defaultScreenPrompt, parseScreenCommand } from '../lib/vision'
import { canSearchWeb, executeWebSearch, extractSearchQuery, formatWebContext, shouldPerformWebSearch } from '../lib/web-search'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'

interface AttachedFile {
  name: string
  sizeFormatted: string
  type: 'image' | 'text'
  data?: string
  preview?: string
  content?: string
  ext?: string
}

const chat = useChatStore()
const settings = useSettingsStore()
const tts = useTextToSpeech()
const emotions = useAvatarEmotions()
const api = getDesktopApi()

const input = ref('')
const list = ref<HTMLElement>()
const fileInputRef = ref<HTMLInputElement>()
const isExpanded = ref(false)
const visionAvailable = canCaptureScreen()
const webAvailable = canSearchWeb()
const isVisionSupported = computed(() => modelSupportsVision(settings.model))
const capturing = ref(false)
const isSearchingWeb = ref(false)
const searchStatus = ref('')
const screenStatus = ref('')
const attachedFile = ref<AttachedFile | null>(null)
const visionError = ref('')
const voiceError = ref('')
const copiedEntryId = ref<number | null>(null)

const quickSuggestions = [
  { label: '⚡ ¿Cómo va mi PC?', prompt: '¿Cómo va el rendimiento y temperatura de mi PC ahora mismo?' },
  { label: '📸 Analiza mi pantalla', prompt: 'Analiza mi pantalla' },
  { label: '📂 ¿Qué hay en mi escritorio?', prompt: '¿Qué archivos o carpetas tengo en mi escritorio?' },
  { label: '🌐 Noticias de IA hoy', prompt: 'Busca en internet las noticias más recientes sobre inteligencia artificial' },
]

async function copyEntryText(entryId: number, rawText: string) {
  const clean = sanitizeDisplayContent(rawText)
  if (!clean)
    return
  try {
    await navigator.clipboard.writeText(clean)
    copiedEntryId.value = entryId
    setTimeout(() => {
      if (copiedEntryId.value === entryId)
        copiedEntryId.value = null
    }, 1800)
  }
  catch {}
}

function replayEntryVoice(rawText: string) {
  const clean = sanitizeDisplayContent(rawText)
  if (!clean)
    return
  tts.cancel()
  tts.pushChunk(`${clean}. `)
  tts.finishStream()
}

async function openExternalUrl(url: string) {
  if (!url)
    return
  if (api?.tools?.executeSafe) {
    try {
      await api.tools.executeSafe('open_app', { target: url })
      return
    }
    catch {}
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function handleBubbleClick(e: MouseEvent) {
  const target = (e.target as HTMLElement)?.closest?.('[data-external-url]') as HTMLElement | null
  if (target) {
    e.preventDefault()
    const url = target.getAttribute('data-external-url')
    if (url)
      void openExternalUrl(url)
  }
}

onMounted(() => {
  tts.loadVoices()
})

chat.onChunk((chunk) => {
  tts.pushChunk(chunk)

  const activeEntry = chat.entries[chat.entries.length - 1]
  const currentText = activeEntry?.role === 'assistant' ? activeEntry.content : chunk
  const emo = emotions.detectEmotion(currentText)
  if (emo) {
    emotions.setEmotion(emo)
  }
})
chat.onDone(() => {
  tts.finishStream()
})
chat.onStop(() => tts.cancel())

async function approveTool(tool: ToolCallItem) {
  if (!api?.tools)
    return
  tool.status = 'executing'
  try {
    const res = await api.tools.executeSensitive(tool.name, tool.args || {})
    tool.status = 'completed'
    tool.result = res.message
  }
  catch (err) {
    tool.status = 'error'
    tool.error = errorMessageFrom(err)
  }
}

function rejectTool(tool: ToolCallItem) {
  tool.status = 'rejected'
}

const speech = useSpeechToText({
  onTranscript(text, isFinal) {
    voiceError.value = ''
    if (isFinal) {
      screenStatus.value = ''

      // Voice trigger for screen capture:
      const screenCmd = visionAvailable ? parseScreenCommand(text) : null
      if (screenCmd?.matches) {
        if (screenCmd.isCommandOnly) {
          // Voice command was just "analiza mi pantalla", "ve mi monitor", "toma captura de lo que veo", etc.
          // Capture screen and attach it, keeping mic active so user can speak their comment
          void captureScreenToAttachment()
          if (!settings.autoSendVoice) {
            input.value = ''
          }
          return
        }
        else {
          // User spoke command AND question together: "mira mi pantalla y dime qué error tiene este código"
          void handleCombinedScreenSpeech(screenCmd.remainingPrompt)
          return
        }
      }

      if (settings.autoSendVoice) {
        input.value = ''
        void sendMessage(text)
      }
      else {
        input.value = text
      }
    }
  },
  onBargeIn() {
    // Interruption! Stop speech and generation immediately so user can speak
    stopCurrentGeneration()
  },
  isAssistantSpeaking: () => tts.isSpeaking.value || chat.busy,
  onError(err) {
    voiceError.value = err
  },
})

function stopCurrentGeneration() {
  tts.cancel()
  chat.stop()
  capturing.value = false
  isSearchingWeb.value = false
  searchStatus.value = ''
}

function toggleSound() {
  settings.ttsEnabled = !settings.ttsEnabled
  if (!settings.ttsEnabled)
    tts.cancel()
}

function clearChat() {
  stopCurrentGeneration()
  chat.clear()
}

function triggerFileInput() {
  fileInputRef.value?.click()
}

function handleFilePicked(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file)
    return

  const sizeFormatted = file.size > 1024 * 1024
    ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(file.size / 1024)} KB`

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

  if (file.type.startsWith('image/')) {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64Data = result.split(',')[1] ?? ''
      attachedFile.value = {
        name: file.name,
        sizeFormatted,
        type: 'image',
        data: base64Data,
        preview: result,
      }
    }
    reader.readAsDataURL(file)
  }
  else {
    const reader = new FileReader()
    reader.onload = () => {
      let text = (reader.result as string) || ''
      if (text.length > 20000) {
        text = `${text.slice(0, 20000)}\n\n[...Archivo truncado a los primeros 20.000 caracteres...]`
      }
      attachedFile.value = {
        name: file.name,
        sizeFormatted,
        type: 'text',
        content: text,
        ext,
      }
    }
    reader.readAsText(file)
  }

  target.value = ''
}

function clearAttachment() {
  attachedFile.value = null
  screenStatus.value = ''
}

/** Captures the screen and attaches it as a pending image without sending immediately. */
async function captureScreenToAttachment() {
  if (!visionAvailable)
    return

  if (!isVisionSupported.value) {
    visionError.value = `El modelo actual (${settings.model}) no soporta visión multimodal. Selecciona un modelo como gemma4:12b en Ajustes.`
    return
  }

  visionError.value = ''
  capturing.value = true
  screenStatus.value = 'Capturando pantalla…'
  try {
    const b64 = await captureScreen()
    attachedFile.value = {
      name: 'Captura de pantalla',
      sizeFormatted: 'Pantalla',
      type: 'image',
      data: b64,
      preview: `data:image/jpeg;base64,${b64}`,
    }
    screenStatus.value = 'Captura lista. Puedes hablar o escribir tu comentario.'
  }
  catch (caught) {
    visionError.value = errorMessageFrom(caught) ?? 'No pude capturar la pantalla.'
    screenStatus.value = ''
  }
  finally {
    capturing.value = false
  }
}

/** Handles spoken query that already contained both capture command and user question. */
async function handleCombinedScreenSpeech(prompt: string) {
  if (!visionAvailable || !isVisionSupported.value) {
    if (!isVisionSupported.value) {
      visionError.value = `El modelo actual (${settings.model}) no soporta visión. Respondiendo solo a tu consulta.`
    }
    await sendMessage(prompt)
    return
  }
  visionError.value = ''
  capturing.value = true
  try {
    let b64 = attachedFile.value?.type === 'image' ? attachedFile.value.data : undefined
    if (!b64) {
      b64 = await captureScreen()
    }
    attachedFile.value = null
    await sendMessage(prompt || defaultScreenPrompt, false, b64)
  }
  catch (caught) {
    visionError.value = errorMessageFrom(caught) ?? 'No pude capturar la pantalla.'
  }
  finally {
    capturing.value = false
  }
}

/** Sends the message with optional vision, attachments, or live web search context. */
async function sendMessage(text: string, forceLook = false, providedImage?: string) {
  tts.cancel()
  screenStatus.value = ''
  let image: string | undefined = providedImage
  let attachmentName: string | undefined
  let webSources: Array<{ title: string, url: string }> | undefined
  let promptContext: string | undefined

  // 1. Process attached user file (or previously captured screenshot)
  if (attachedFile.value) {
    attachmentName = attachedFile.value.name
    if (attachedFile.value.type === 'image') {
      image = attachedFile.value.data
    }
    else if (attachedFile.value.type === 'text') {
      const fileBlock = `[Archivo adjunto: ${attachedFile.value.name}]\n\`\`\`${attachedFile.value.ext || ''}\n${attachedFile.value.content}\n\`\`\``
      text = text.trim() ? `${fileBlock}\n\n${text}` : `${fileBlock}\n\nPor favor analiza o resume este archivo adjunto.`
    }
    attachedFile.value = null
  }

  // 2. Fallback screen capture if forceLook or explicit screen command in text without prior attachment
  if (!image && visionAvailable) {
    const screenCmd = parseScreenCommand(text)
    if (forceLook || screenCmd.matches) {
      visionError.value = ''
      capturing.value = true
      try {
        image = await captureScreen()
        if (screenCmd.matches) {
          text = screenCmd.remainingPrompt || defaultScreenPrompt
        }
      }
      catch (caught) {
        visionError.value = errorMessageFrom(caught) ?? 'No pude capturar la pantalla.'
      }
      finally {
        capturing.value = false
      }
    }
  }

  // 3. Process web search ONLY if intelligent trigger matches or user explicitly wants search
  if (webAvailable && shouldPerformWebSearch(text, settings.webSearchEnabled)) {
    isSearchingWeb.value = true
    const query = extractSearchQuery(text)
    searchStatus.value = `Investigando: "${query.slice(0, 24)}..."`
    try {
      const results = await executeWebSearch(query, settings.webSearchMaxResults)
      if (results.length > 0) {
        webSources = results.map(r => ({ title: r.title, url: r.url }))
        // IMPORTANT: webContext goes into promptContext so it NEVER pollutes user's chat bubble!
        promptContext = formatWebContext(query, results)
      }
    }
    catch (err) {
      console.warn('[chat] Web search error:', err)
    }
    finally {
      isSearchingWeb.value = false
      searchStatus.value = ''
    }
  }

  // 4. Pre-fetch real system stats if user is asking about PC performance / hardware
  if (settings.desktopToolsEnabled && shouldFetchSystemStats(text) && api?.tools) {
    try {
      const stats = await api.tools.getSystemStats()
      const statsContext = formatSystemStatsContext(stats)
      promptContext = promptContext ? `${promptContext}\n\n${statsContext}` : statsContext
    }
    catch (err) {
      console.warn('[chat] Could not read system stats:', err)
    }
  }

  // 5. Pre-fetch Windows clipboard if user is asking about clipboard contents
  if (settings.desktopToolsEnabled && shouldFetchClipboard(text) && api?.tools?.readClipboard) {
    try {
      const clipText = await api.tools.readClipboard()
      const clipContext = formatClipboardContext(clipText)
      promptContext = promptContext ? `${promptContext}\n\n${clipContext}` : clipContext
    }
    catch (err) {
      console.warn('[chat] Could not read clipboard:', err)
    }
  }

  emotions.setEmotion('think')
  await chat.send(text, { image, attachmentName, webSources, promptContext })
}

async function lookAtScreen() {
  await captureScreenToAttachment()
}

async function submit() {
  const text = input.value
  input.value = ''
  await sendMessage(text)
}

// Auto-scroll message list when expanded
watch(() => chat.entries.map(entry => entry.content.length + entry.thinking.length), async () => {
  if (isExpanded.value) {
    await nextTick()
    list.value?.scrollTo({ top: list.value.scrollHeight, behavior: 'smooth' })
  }
})

// Active assistant entry for compact HUD card
const lastAssistantEntry = ref<typeof chat.entries[0]>()
watch(() => chat.entries, (entries) => {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role === 'assistant') {
      lastAssistantEntry.value = entries[i]
      return
    }
  }
  lastAssistantEntry.value = undefined
}, { deep: true, immediate: true })
</script>

<template>
  <div class="chat-container" :class="{ 'is-expanded': isExpanded }">
    <!-- EXPANDED DRAWER: Full Conversation History -->
    <div v-if="isExpanded" class="history-card">
      <div class="drawer-header">
        <div class="title-group">
          <span class="drawer-title">Conversación</span>
          <span v-if="chat.entries.length" class="count-pill">{{ chat.entries.length }} mensajes</span>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="action-btn"
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
            class="action-btn"
            :disabled="!chat.entries.length"
            title="Nueva conversación"
            @click="clearChat"
          >
            <svg viewBox="0 0 24 24" class="svg-icon">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          <button
            type="button"
            class="action-btn"
            title="Minimizar a modo compacto"
            @click="isExpanded = false"
          >
            <svg viewBox="0 0 24 24" class="svg-icon">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      <div ref="list" class="message-feed" @click="handleBubbleClick">
        <div v-if="!chat.entries.length" class="empty-state-box">
          <p class="empty-state">
            Conversa con Yukisei por voz o texto, o prueba una acción rápida:
          </p>
          <div class="suggestion-grid">
            <button
              v-for="item in quickSuggestions"
              :key="item.label"
              type="button"
              class="suggestion-chip"
              :disabled="chat.busy"
              @click="sendMessage(item.prompt)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
        <div
          v-for="(entry, entryIdx) in chat.entries"
          :key="entry.id"
          class="chat-bubble"
          :class="entry.role"
        >
          <span v-if="entry.hasImage" class="meta-tag">
            <svg viewBox="0 0 24 24" class="mini-icon">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
            Imagen
          </span>
          <span v-if="entry.attachmentName" class="meta-tag attachment">
            <svg viewBox="0 0 24 24" class="mini-icon">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            {{ entry.attachmentName }}
          </span>
          <details v-if="entry.webSources?.length" class="web-sources-block">
            <summary class="sources-summary">
              <svg viewBox="0 0 24 24" class="mini-icon">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              {{ entry.webSources.length }} fuente(s) web consultada(s)
            </summary>
            <div class="sources-dropdown">
              <button
                v-for="(src, idx) in entry.webSources"
                :key="idx"
                type="button"
                class="source-item clickable"
                :title="`Abrir en navegador: ${src.url}`"
                @click="openExternalUrl(src.url)"
              >
                <span class="source-num">{{ idx + 1 }}</span>
                <span class="source-text">{{ src.title || src.url }}</span>
                <span class="source-ext">↗</span>
              </button>
            </div>
          </details>
          <details v-if="entry.thinking" class="thinking-block">
            <summary>Razonamiento</summary>
            <div class="thinking-content">
              {{ entry.thinking }}
            </div>
          </details>
          <div
            v-if="sanitizeDisplayContent(entry.content)"
            class="bubble-text markdown-body"
            v-html="renderMarkdown(entry.content)"
          />
          <div v-else-if="chat.busy && entry.role === 'assistant'" class="bubble-text thinking-dots">
            Pensando…
          </div>

          <div v-if="entry.memoriesSaved?.length" class="memory-saved-list">
            <div v-for="(mem, mIdx) in entry.memoriesSaved" :key="mIdx" class="memory-pill">
              <span>🧠 Recuerdo guardado: {{ mem }}</span>
            </div>
          </div>
          <!-- Tool Calls inside expanded chat bubble -->
          <div v-if="entry.toolCalls?.length" class="tool-calls-container">
            <div
              v-for="tool in entry.toolCalls"
              :key="tool.id"
              class="tool-card"
              :class="{
                'tool-sensitive': tool.isSensitive,
                'tool-pending': tool.status === 'pending',
                'tool-executing': tool.status === 'executing',
                'tool-completed': tool.status === 'completed',
                'tool-rejected': tool.status === 'rejected',
                'tool-error': tool.status === 'error',
              }"
            >
              <template v-if="tool.isSensitive && tool.status === 'pending'">
                <div class="tool-confirm-header">
                  <span class="tool-warn-icon">⚠️</span>
                  <span class="tool-confirm-title">Yukisei solicita permiso</span>
                </div>
                <div class="tool-confirm-desc">
                  <span class="tool-action-name">{{ getToolDisplayInfo(tool.name, tool.args).title }}</span>
                  <p class="tool-detail">
                    {{ getToolDisplayInfo(tool.name, tool.args).description }}
                  </p>
                </div>
                <div class="tool-confirm-actions">
                  <button
                    type="button"
                    class="tool-btn tool-btn-confirm"
                    @click="approveTool(tool)"
                  >
                    ✓ Permitir
                  </button>
                  <button
                    type="button"
                    class="tool-btn tool-btn-cancel"
                    @click="rejectTool(tool)"
                  >
                    ✕ Cancelar
                  </button>
                </div>
              </template>
              <template v-else-if="tool.status === 'executing'">
                <div class="tool-pill executing">
                  <span class="indicator-dot spin" />
                  <span>Ejecutando: {{ getToolDisplayInfo(tool.name, tool.args).title }}…</span>
                </div>
              </template>
              <template v-else-if="tool.status === 'completed'">
                <div class="tool-pill completed">
                  <span class="tool-check">✓</span>
                  <span>{{ tool.result || getToolDisplayInfo(tool.name, tool.args).title }}</span>
                </div>
              </template>
              <template v-else-if="tool.status === 'rejected'">
                <div class="tool-pill rejected">
                  <span>✕ Cancelado por ti</span>
                </div>
              </template>
              <template v-else-if="tool.status === 'error'">
                <div class="tool-pill error" :title="tool.error">
                  <span>⚠️ {{ tool.error || 'Error' }}</span>
                </div>
              </template>
            </div>
          </div>

          <!-- Assistant Message Footer: Telemetry & Actions -->
          <div v-if="entry.role === 'assistant' && entry.content && (!chat.busy || entryIdx < chat.entries.length - 1)" class="bubble-footer">
            <span v-if="entry.metrics" class="telemetry-badge" :title="`${entry.metrics.totalTokens} tokens en ${(entry.metrics.durationMs / 1000).toFixed(1)}s`">
              ⚡ {{ entry.metrics.tokensPerSec }} tok/s · {{ (entry.metrics.durationMs / 1000).toFixed(1) }}s
            </span>
            <div class="bubble-actions">
              <button
                type="button"
                class="msg-action-btn"
                :title="copiedEntryId === entry.id ? '¡Copiado!' : 'Copiar respuesta'"
                @click="copyEntryText(entry.id, entry.content)"
              >
                {{ copiedEntryId === entry.id ? '✓ Copiado' : 'Copiar' }}
              </button>
              <button
                type="button"
                class="msg-action-btn"
                title="Escuchar con voz de Yukisei"
                @click="replayEntryVoice(entry.content)"
              >
                🔊 Voz
              </button>
              <button
                v-if="entryIdx === chat.entries.length - 1"
                type="button"
                class="msg-action-btn"
                :disabled="chat.busy"
                title="Regenerar esta respuesta"
                @click="chat.regenerateLast()"
              >
                ↻ Regenerar
              </button>
            </div>
          </div>
        </div>
        <p v-if="chat.error" class="error-banner">
          {{ chat.error }}
        </p>
      </div>
    </div>

    <!-- COMPACT HUD: Floating Response Card (only shows latest response unobtrusively) -->
    <div
      v-else-if="lastAssistantEntry && (chat.busy || lastAssistantEntry.content)"
      class="compact-speech-card"
    >
      <div class="speech-header">
        <span class="speech-author">Yukisei</span>
        <button
          type="button"
          class="expand-pill"
          title="Ver historial completo"
          @click="isExpanded = true"
        >
          Historial
          <svg viewBox="0 0 24 24" class="mini-icon">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
      </div>
      <details v-if="lastAssistantEntry.thinking" class="thinking-block compact">
        <summary>Razonamiento</summary>
        <div class="thinking-content">
          {{ lastAssistantEntry.thinking }}
        </div>
      </details>
      <details v-if="lastAssistantEntry.webSources?.length" class="web-sources-block compact">
        <summary class="sources-summary">
          <svg viewBox="0 0 24 24" class="mini-icon">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          {{ lastAssistantEntry.webSources.length }} fuente(s) web consultada(s)
        </summary>
        <div class="sources-dropdown">
          <button
            v-for="(src, idx) in lastAssistantEntry.webSources"
            :key="idx"
            type="button"
            class="source-item clickable"
            :title="`Abrir en navegador: ${src.url}`"
            @click="openExternalUrl(src.url)"
          >
            <span class="source-num">{{ idx + 1 }}</span>
            <span class="source-text">{{ src.title || src.url }}</span>
            <span class="source-ext">↗</span>
          </button>
        </div>
      </details>
      <div
        v-if="sanitizeDisplayContent(lastAssistantEntry.content)"
        class="speech-body markdown-body"
        @click="handleBubbleClick"
        v-html="renderMarkdown(lastAssistantEntry.content)"
      />
      <div v-else-if="chat.busy" class="speech-body thinking-dots">
        Pensando…
      </div>
      <div v-if="lastAssistantEntry.memoriesSaved?.length" class="memory-saved-list">
        <div v-for="(mem, mIdx) in lastAssistantEntry.memoriesSaved" :key="mIdx" class="memory-pill">
          <span>🧠 Recuerdo guardado: {{ mem }}</span>
        </div>
      </div>

      <!-- Tool Calls (Compact HUD) -->
      <div v-if="lastAssistantEntry.toolCalls?.length" class="tool-calls-container">
        <div
          v-for="tool in lastAssistantEntry.toolCalls"
          :key="tool.id"
          class="tool-card"
          :class="{
            'tool-sensitive': tool.isSensitive,
            'tool-pending': tool.status === 'pending',
            'tool-executing': tool.status === 'executing',
            'tool-completed': tool.status === 'completed',
            'tool-rejected': tool.status === 'rejected',
            'tool-error': tool.status === 'error',
          }"
        >
          <!-- Sensitive Confirmation Card -->
          <template v-if="tool.isSensitive && tool.status === 'pending'">
            <div class="tool-confirm-header">
              <span class="tool-warn-icon">⚠️</span>
              <span class="tool-confirm-title">Yukisei solicita permiso</span>
            </div>
            <div class="tool-confirm-desc">
              <span class="tool-action-name">{{ getToolDisplayInfo(tool.name, tool.args).title }}</span>
              <p class="tool-detail">
                {{ getToolDisplayInfo(tool.name, tool.args).description }}
              </p>
            </div>
            <div class="tool-confirm-actions">
              <button
                type="button"
                class="tool-btn tool-btn-confirm"
                @click="approveTool(tool)"
              >
                ✓ Permitir
              </button>
              <button
                type="button"
                class="tool-btn tool-btn-cancel"
                @click="rejectTool(tool)"
              >
                ✕ Cancelar
              </button>
            </div>
          </template>

          <template v-else-if="tool.status === 'executing'">
            <div class="tool-pill executing">
              <span class="indicator-dot spin" />
              <span>Ejecutando: {{ getToolDisplayInfo(tool.name, tool.args).title }}…</span>
            </div>
          </template>

          <template v-else-if="tool.status === 'completed'">
            <div class="tool-pill completed">
              <span class="tool-check">✓</span>
              <span>{{ tool.result || getToolDisplayInfo(tool.name, tool.args).title }}</span>
            </div>
          </template>

          <template v-else-if="tool.status === 'rejected'">
            <div class="tool-pill rejected">
              <span>✕ Acción cancelada por ti</span>
            </div>
          </template>

          <template v-else-if="tool.status === 'error'">
            <div class="tool-pill error" :title="tool.error">
              <span>⚠️ {{ tool.error || 'Error al ejecutar' }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- STATUS BANNER (Voice activity, transcription, screen capture, web search) -->
    <div v-if="screenStatus" class="status-indicator live">
      <span class="indicator-dot pulse" />
      <span class="indicator-text">
        {{ screenStatus }}
      </span>
    </div>
    <div v-else-if="isSearchingWeb" class="status-indicator busy web-active">
      <span class="indicator-dot spin" />
      <span class="indicator-text">
        {{ searchStatus || 'Investigando en la red…' }}
      </span>
    </div>
    <div v-else-if="speech.isListening.value" class="status-indicator live">
      <span class="indicator-dot pulse" />
      <span class="indicator-text">
        <template v-if="speech.silenceCountdown.value > 0">
          Enviando en <b>{{ speech.silenceCountdown.value }}s</b>
        </template>
        <template v-else-if="speech.isSpeaking.value">
          Escuchando… <span class="audio-wave" :style="{ width: `${speech.audioLevel.value}%` }" />
        </template>
        <template v-else-if="tts.isSpeaking.value">
          Yukisei hablando (puedes interrumpir)…
        </template>
        <template v-else>
          Conversación continua activa (te escucho)
        </template>
      </span>
    </div>
    <div v-else-if="speech.isTranscribing.value || capturing" class="status-indicator busy">
      <span class="indicator-dot spin" />
      <span class="indicator-text">
        {{ capturing ? 'Capturando pantalla…' : 'Transcribiendo con Whisper…' }}
      </span>
    </div>
    <div v-else-if="voiceError || visionError" class="status-indicator error">
      <span>{{ voiceError || visionError }}</span>
    </div>

    <!-- ATTACHMENT PREVIEW PILL -->
    <div v-if="attachedFile" class="attachment-preview-bar">
      <div class="attachment-chip">
        <img v-if="attachedFile.type === 'image'" :src="attachedFile.preview" class="chip-thumb" alt="Vista previa">
        <svg v-else viewBox="0 0 24 24" class="chip-file-icon">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <div class="chip-labels">
          <span class="chip-name" :title="attachedFile.name">{{ attachedFile.name }}</span>
          <span class="chip-size">{{ attachedFile.sizeFormatted }}</span>
        </div>
        <button type="button" class="chip-remove-btn" title="Quitar archivo" @click="clearAttachment">
          ✕
        </button>
      </div>
    </div>

    <!-- FLOATING COMPOSER DOCK (Ultra-sleek frosted capsule) -->
    <form class="dock-composer" @submit.prevent="submit">
      <input
        ref="fileInputRef"
        type="file"
        accept="image/*,.txt,.md,.json,.csv,.py,.js,.ts,.html,.css,.log,.yaml,.yml,.sql"
        style="display: none"
        @change="handleFilePicked"
      >

      <button
        v-if="visionAvailable"
        type="button"
        class="dock-btn"
        :class="{
          active: attachedFile?.type === 'image' && attachedFile.name === 'Captura de pantalla',
          disabled: !isVisionSupported,
        }"
        :disabled="chat.busy || capturing"
        :title="isVisionSupported ? 'Capturar pantalla para adjuntar a tu consulta' : `Visión no soportada en ${settings.model} (selecciona gemma4:12b en Ajustes)`"
        @click="lookAtScreen"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </button>

      <button
        type="button"
        class="dock-btn attachment-btn"
        :class="{ active: Boolean(attachedFile) }"
        :disabled="chat.busy || capturing"
        title="Adjuntar archivo o imagen (código, texto, capturas)"
        @click="triggerFileInput"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      <button
        v-if="webAvailable"
        type="button"
        class="dock-btn web-btn"
        :class="{ active: settings.webSearchEnabled }"
        :title="settings.webSearchEnabled ? 'Investigación en la red activa (clic para desactivar)' : 'Investigación en la red inactiva (clic para activar)'"
        @click="settings.webSearchEnabled = !settings.webSearchEnabled"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      </button>

      <button
        type="button"
        class="dock-btn mic-btn"
        :class="{ active: speech.isListening.value }"
        :title="speech.isListening.value ? 'Modo conversación continuo activo (clic para silenciar)' : 'Iniciar conversación continua por voz'"
        @click="voiceError = ''; speech.toggle()"
      >
        <svg v-if="!speech.isListening.value" viewBox="0 0 24 24" class="svg-icon">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
        <svg v-else viewBox="0 0 24 24" class="svg-icon stop">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>

      <input
        v-model="input"
        class="dock-input"
        :placeholder="attachedFile ? 'Escribe o di tu comentario sobre la captura…' : (speech.isListening.value ? 'Grabando audio…' : 'Escribe o presiona el micrófono…')"
        :disabled="chat.busy || speech.isTranscribing.value || capturing"
      >

      <button
        v-if="!chat.busy && (input.trim() || attachedFile)"
        type="submit"
        class="dock-btn send-btn"
        title="Enviar mensaje"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
      <button
        v-else-if="chat.busy"
        type="button"
        class="dock-btn stop-btn"
        title="Detener respuesta"
        @click="stopCurrentGeneration"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>
      <button
        v-else-if="!isExpanded && chat.entries.length"
        type="button"
        class="dock-btn history-toggle"
        title="Abrir historial"
        @click="isExpanded = true"
      >
        <svg viewBox="0 0 24 24" class="svg-icon">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
    </form>
  </div>
</template>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: 100%;
  gap: 8px;
  pointer-events: auto;
}

/* EXPANDED DRAWER */
.history-card {
  display: flex;
  flex-direction: column;
  height: 380px;
  max-height: 52vh;
  border-radius: 20px;
  background: var(--bg-glass-elevated);
  backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid var(--border-glass);
  box-shadow: 0 16px 36px -10px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  overflow: hidden;
  animation: slideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-glass);
}

.title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drawer-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.count-pill {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10px;
  color: var(--text-muted);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.action-btn.active {
  color: #818cf8;
}

.action-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.message-feed {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty-state {
  margin: auto;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
}

.chat-bubble {
  max-width: 86%;
  padding: 8px 12px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.45;
  word-break: break-word;
}

.chat-bubble.user {
  align-self: flex-end;
  background: var(--accent-iris);
  color: white;
  border-bottom-right-radius: 4px;
}

.chat-bubble.assistant {
  align-self: flex-start;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
}

.meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #93c5fd;
  margin-bottom: 4px;
}

.thinking-block {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-muted);
  border-left: 2px solid rgba(129, 140, 248, 0.4);
  padding-left: 6px;
}

.thinking-block summary {
  cursor: pointer;
  user-select: none;
  opacity: 0.8;
}

.thinking-content {
  margin-top: 4px;
  font-family: ui-monospace, monospace;
  font-size: 10px;
  opacity: 0.75;
  white-space: pre-wrap;
  max-height: 90px;
  overflow-y: auto;
}

.error-banner {
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(244, 63, 94, 0.15);
  border: 1px solid rgba(244, 63, 94, 0.3);
  color: #fca5a5;
  font-size: 12px;
}

/* COMPACT SPEECH CARD (Floating above avatar's legs, clean and readable) */
.compact-speech-card {
  padding: 10px 14px;
  border-radius: 16px;
  background: var(--bg-glass);
  backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid var(--border-glass);
  box-shadow: 0 10px 28px -6px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  animation: fadeIn 0.2s ease;
  max-height: 140px;
  overflow-y: auto;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.speech-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.speech-author {
  font-size: 11px;
  font-weight: 600;
  color: #a5b4fc;
}

.expand-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
}

.expand-pill:hover {
  background: rgba(255, 255, 255, 0.14);
  color: var(--text-primary);
}

.speech-body {
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* STATUS PILL (Recording & Processing) */
.status-indicator {
  display: inline-flex;
  align-items: center;
  align-self: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--bg-glass);
  backdrop-filter: blur(16px);
  border: 1px solid var(--border-glass);
  font-size: 11px;
  color: var(--text-primary);
}

.status-indicator.live {
  border-color: rgba(16, 185, 129, 0.35);
  box-shadow: 0 0 16px rgba(16, 185, 129, 0.2);
}

.indicator-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--emerald-live);
}

.indicator-dot.pulse {
  animation: pulseGlow 1.2s infinite ease-in-out;
}

@keyframes pulseGlow {
  0% { transform: scale(0.9); opacity: 0.6; }
  50% { transform: scale(1.3); opacity: 1; }
  100% { transform: scale(0.9); opacity: 0.6; }
}

.audio-wave {
  display: inline-block;
  height: 4px;
  min-width: 4px;
  max-width: 40px;
  background: var(--emerald-live);
  border-radius: 2px;
  vertical-align: middle;
  margin-left: 4px;
}

/* FLOATING DOCK COMPOSER */
.dock-composer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 18px;
  background: var(--bg-glass-elevated);
  backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid var(--border-glass);
  box-shadow: 0 10px 24px -4px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.dock-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.dock-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
}

.dock-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.mic-btn.active {
  background: var(--emerald-live);
  color: #0b0d13;
  box-shadow: 0 0 14px rgba(16, 185, 129, 0.4);
}

.attachment-btn.active {
  background: rgba(129, 140, 248, 0.25);
  color: #a5b4fc;
  border-color: rgba(129, 140, 248, 0.4);
}

.web-btn.active {
  background: rgba(56, 189, 248, 0.2);
  color: #38bdf8;
  border-color: rgba(56, 189, 248, 0.4);
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.3);
}

.status-indicator.web-active {
  border-color: rgba(56, 189, 248, 0.4);
  box-shadow: 0 0 14px rgba(56, 189, 248, 0.2);
  color: #bae6fd;
}

/* ATTACHMENT PREVIEW BAR */
.attachment-preview-bar {
  display: flex;
  align-items: center;
  margin-bottom: 2px;
  animation: fadeIn 0.15s ease;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 6px;
  border-radius: 12px;
  background: var(--bg-glass-elevated);
  backdrop-filter: blur(20px);
  border: 1px solid var(--border-glass);
  box-shadow: 0 6px 16px -4px rgba(0, 0, 0, 0.4);
  max-width: 100%;
}

.chip-thumb {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  object-fit: cover;
}

.chip-file-icon {
  width: 16px;
  height: 16px;
  stroke: #a5b4fc;
  stroke-width: 2;
  fill: none;
}

.chip-labels {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  line-height: 1.2;
}

.chip-name {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.chip-size {
  font-size: 9px;
  color: var(--text-dim);
}

.chip-remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 4px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.chip-remove-btn:hover {
  background: rgba(244, 63, 94, 0.3);
  color: #fca5a5;
}

/* WEB SOURCES DETAILS */
.web-sources-block {
  margin: 6px 0;
  font-size: 11px;
  border-radius: 8px;
  background: rgba(56, 189, 248, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.2);
  overflow: hidden;
}

.web-sources-block.compact {
  margin-top: 4px;
}

.sources-summary {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  color: #7dd3fc;
  cursor: pointer;
  user-select: none;
  font-weight: 500;
}

.sources-dropdown {
  padding: 4px 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-top: 1px solid rgba(56, 189, 248, 0.15);
}

.source-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-primary);
  line-height: 1.3;
}

.source-num {
  color: #38bdf8;
  font-weight: 600;
  font-size: 9px;
}

.source-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
  color: var(--text-muted);
}

.meta-tag.attachment {
  color: #c4b5fd;
}

.send-btn {
  background: var(--accent-iris);
  color: white;
}

.send-btn:hover {
  background: var(--accent-iris-hover);
}

.stop-btn {
  background: var(--rose-stop);
  color: white;
}

.dock-input {
  flex: 1;
  height: 34px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  transition: all 0.18s ease;
}

.dock-input:focus {
  background: rgba(255, 255, 255, 0.09);
  border-color: var(--border-glass-focus);
}

.dock-input::placeholder {
  color: var(--text-dim);
}

/* SVG ICONS */
.svg-icon {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.svg-icon.stop {
  fill: currentColor;
}

.mini-icon {
  width: 12px;
  height: 12px;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
  vertical-align: middle;
}

/* DESKTOP TOOL CALLS & HUMAN-IN-THE-LOOP CARDS */
.tool-calls-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.tool-card.tool-sensitive {
  background: rgba(245, 158, 11, 0.09);
  border: 1px solid rgba(245, 158, 11, 0.32);
  border-radius: 10px;
  padding: 8px 10px;
  backdrop-filter: blur(8px);
}

.tool-confirm-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #fbbf24;
}

.tool-confirm-desc {
  margin: 4px 0 6px 0;
}

.tool-action-name {
  display: block;
  font-size: 11.5px;
  font-weight: 600;
  color: #f9fafb;
}

.tool-detail {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.72);
  margin: 2px 0 0 0;
  word-break: break-all;
}

.tool-confirm-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.tool-btn {
  border: none;
  cursor: pointer;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  transition: all 0.15s ease;
  user-select: none;
}

.tool-btn-confirm {
  background: #10b981;
  color: #ffffff;
}

.tool-btn-confirm:hover {
  background: #059669;
}

.tool-btn-cancel {
  background: rgba(255, 255, 255, 0.07);
  color: #fca5a5;
  border: 1px solid rgba(248, 113, 113, 0.3);
}

.tool-btn-cancel:hover {
  background: rgba(248, 113, 113, 0.16);
}

.tool-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  width: fit-content;
  max-width: 100%;
  word-break: break-all;
}

.tool-pill.completed {
  background: rgba(16, 185, 129, 0.12);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.28);
}

.tool-pill.rejected {
  background: rgba(239, 68, 68, 0.09);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.22);
}

.tool-pill.error {
  background: rgba(239, 68, 68, 0.14);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.35);
}

.tool-pill.executing {
  background: rgba(99, 102, 241, 0.15);
  color: #a5b4fc;
  border: 1px solid rgba(99, 102, 241, 0.3);
}

/* Empty state & Quick Suggestions */
.empty-state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px 8px;
}

.suggestion-grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}

.suggestion-chip {
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #e2e8f0;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.suggestion-chip:hover:not(:disabled) {
  background: rgba(99, 102, 241, 0.2);
  border-color: rgba(129, 140, 248, 0.45);
  color: #fff;
  transform: translateY(-1px);
}

/* Clickable web sources */
.source-item.clickable {
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.source-item.clickable:hover {
  background: rgba(56, 189, 248, 0.14);
}

.source-ext {
  margin-left: auto;
  font-size: 10px;
  color: #38bdf8;
  opacity: 0.8;
}

/* Markdown Typography inside Chat Bubbles */
.markdown-body :deep(.md-p) {
  margin: 0 0 6px 0;
}

.markdown-body :deep(.md-p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(.md-spacer) {
  height: 4px;
}

.markdown-body :deep(.md-h2),
.markdown-body :deep(.md-h3) {
  font-weight: 700;
  color: #f8fafc;
  margin: 6px 0 4px;
}

.markdown-body :deep(.md-list) {
  margin: 4px 0 6px 16px;
  padding: 0;
}

.markdown-body :deep(.md-list li) {
  margin-bottom: 3px;
}

.markdown-body :deep(.md-inline-code) {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11.5px;
  color: #e2e8f0;
}

.markdown-body :deep(.md-code-block) {
  margin: 6px 0;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(9, 11, 17, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.markdown-body :deep(.md-code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 10px;
  background: rgba(255, 255, 255, 0.05);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: #94a3b8;
}

.markdown-body :deep(.md-code-block pre) {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.45;
  color: #e2e8f0;
}

.markdown-body :deep(.md-link) {
  color: #38bdf8;
  text-decoration: underline;
  cursor: pointer;
}

/* Memory Saved Pill */
.memory-saved-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.memory-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(168, 85, 247, 0.14);
  border: 1px solid rgba(168, 85, 247, 0.3);
  color: #d8b4fe;
  font-size: 10.5px;
  font-weight: 500;
}

/* Message Footer: Telemetry & Actions */
.bubble-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.telemetry-badge {
  font-size: 10px;
  color: var(--text-dim);
  font-weight: 500;
}

.bubble-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.msg-action-btn {
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.msg-action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
}
</style>
