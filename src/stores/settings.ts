import { defineStore } from 'pinia'
import { reactive, toRefs, watch } from 'vue'

import { defaultPersona, defaultPersonaName } from '../lib/persona'

const storageKey = 'yukisei:settings:v1'

export interface Settings {
  ollamaUrl: string
  model: string
  think: boolean
  /** Creativity of the answer. Low values give steadier and more exact answers. */
  temperature: number
  topP: number
  /** Maximum tokens in one answer. `0` means no limit. */
  maxTokens: number
  /** Auto picks the context from the free video memory. Manual uses `numCtx` as set. */
  memoryMode: 'auto' | 'manual'
  /** Context window in tokens. */
  numCtx: number
  /** Video memory in GB that the context window can use. */
  contextBudgetGb: number
  /** Total video memory of the graphics card in GB. */
  gpuVramGb: number
  repeatPenalty: number
  /** Most past messages that go to the model. Tokens limit it first. */
  maxMessages: number
  persona: string
  personaName: string
  /** Speech-to-text (Hearing) provider */
  sttProvider: 'local-whisper' | 'whisper-api'
  sttLang: string
  whisperUrl: string
  whisperApiKey: string
  autoSendVoice: boolean
  /** Seconds of silence before auto-stopping and sending. `0` disables auto-silence. */
  silenceTimeoutSeconds: number
  /** Microphone volume / digital gain (0.2x to 3.0x, default 1.0) */
  micGain: number
  /** Microphone VAD activation sensitivity (1 to 100, default 50) */
  micSensitivity: number
  /** Selected microphone device ID. Empty string means system default. */
  audioInputDeviceId: string
  /** Selected speaker/headphone device ID. Empty string means system default. */
  audioOutputDeviceId: string
  /** Web Search / Internet investigation enabled */
  webSearchEnabled: boolean
  /** Max search results to fetch from the web (1 to 6, default 4) */
  webSearchMaxResults: number
  /** Desktop Tool Calling / Control de escritorio (Windows hands) */
  desktopToolsEnabled: boolean
  /** Automatic Long-Term Memory learning enabled */
  autoMemoryEnabled: boolean
  /** Text-to-speech (Voice) settings */
  ttsEnabled: boolean
  ttsProvider: 'neural' | 'player2' | 'browser'
  neuralVoice: string
  neuralPitch: string
  player2Url: string
  player2Voice: string
  browserVoice: string
  ttsSpeed: number
  ttsVolume: number
  /** Live2D Avatar visual adjustments */
  avatarScale: number
  avatarOffsetY: number
  avatarOffsetX: number
  /** Window dimensions (la caja de visualización) */
  windowWidth: number
  windowHeight: number
  customModelName: string
  alwaysOnTop: boolean
}

export const defaultSettings: Settings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  model: 'gemma4:12b',
  think: false,
  temperature: 0.4,
  topP: 0.9,
  maxTokens: 0,
  memoryMode: 'auto',
  numCtx: 16384,
  contextBudgetGb: 4,
  gpuVramGb: 16,
  repeatPenalty: 1.1,
  maxMessages: 100,
  persona: defaultPersona,
  personaName: defaultPersonaName,
  sttProvider: 'local-whisper',
  sttLang: 'es-MX',
  whisperUrl: 'http://127.0.0.1:8000/v1',
  whisperApiKey: '',
  autoSendVoice: true,
  silenceTimeoutSeconds: 5,
  micGain: 1.0,
  micSensitivity: 50,
  audioInputDeviceId: '',
  audioOutputDeviceId: '',
  webSearchEnabled: false,
  webSearchMaxResults: 4,
  desktopToolsEnabled: true,
  autoMemoryEnabled: true,
  ttsEnabled: true,
  ttsProvider: 'neural',
  neuralVoice: 'es-MX-DaliaNeural',
  neuralPitch: '+8Hz',
  player2Url: 'http://127.0.0.1:4315',
  player2Voice: '',
  browserVoice: '',
  ttsSpeed: 1.15,
  ttsVolume: 1.0,
  avatarScale: 0.85,
  avatarOffsetY: -12,
  avatarOffsetX: 0,
  windowWidth: 520,
  windowHeight: 820,
  customModelName: '',
  alwaysOnTop: true,
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(storageKey) || localStorage.getItem('airi-mini:settings:v3') || localStorage.getItem('airi-mini:settings:v2')
    const parsed = (raw ? JSON.parse(raw) : {}) as Partial<Settings>
    if (!parsed.ttsProvider || parsed.ttsProvider === 'player2') {
      parsed.ttsProvider = 'neural'
    }
    if (!parsed.neuralVoice) {
      parsed.neuralVoice = 'es-MX-DaliaNeural'
    }
    if (!parsed.neuralPitch) {
      parsed.neuralPitch = '+8Hz'
    }
    if (!parsed.ttsSpeed || parsed.ttsSpeed === 1.0) {
      parsed.ttsSpeed = 1.15
    }
    // Restore preferred close-up framing with comfortable top headroom
    if (parsed.avatarScale !== undefined && parsed.avatarScale < 0.6) {
      parsed.avatarScale = 0.85
    }
    if (parsed.avatarOffsetY !== undefined && parsed.avatarOffsetY > 20) {
      parsed.avatarOffsetY = -12
    }
    if (parsed.windowHeight !== undefined && parsed.windowHeight < 800) {
      parsed.windowHeight = 820
    }
    // Always use the latest bundled persona if user hasn't switched to a custom persona
    if (!parsed.personaName || parsed.personaName === defaultPersonaName) {
      parsed.persona = defaultPersona
      parsed.personaName = defaultPersonaName
    }
    return { ...defaultSettings, ...parsed }
  }
  catch {
    return { ...defaultSettings }
  }
}

export const useSettingsStore = defineStore('yukisei-settings', () => {
  const state = reactive<Settings>(load())

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  watch(
    state,
    () => {
      if (saveTimer)
        clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        localStorage.setItem(storageKey, JSON.stringify(state))
      }, 200)
    },
    { deep: true },
  )

  function reset(keys: (keyof Settings)[]) {
    for (const key of keys)
      (state as Record<keyof Settings, unknown>)[key] = defaultSettings[key]
  }

  return { ...toRefs(state), reset }
})
