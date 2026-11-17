/// <reference types="vite/client" />

interface GpuInfo {
  name: string
  totalMb: number
  freeMb: number
  tempC?: number
}

interface WorkersStatus {
  whisperReady: boolean
  whisperRunning: boolean
  ttsReady: boolean
  ttsRunning: boolean
}

interface OllamaChunkData {
  content: string
  thinking: string
}

interface Player2Voice {
  id: string
  name: string
  language?: string
  gender?: string
}

interface SystemStats {
  cpu: { name?: string, cores?: number, loadPercent: number, tempC?: number | null }
  ram: { totalGb: number, usedGb: number, freeGb: number, percentUsed: number }
  gpu: { name: string, totalMb: number, freeMb: number, tempC: number }
  disks: Array<{ name: string, totalGb: number, freeGb: number }>
}

interface UserSystemPaths {
  desktop: string
  documents: string
  downloads: string
  pictures: string
  music?: string
  videos?: string
  home: string
  username: string
  drives: string[]
}

interface YukiseiApi {
  windowControl?: {
    hide: () => Promise<void>
    close: () => Promise<void>
    toggleAlwaysOnTop: () => Promise<boolean>
    isAlwaysOnTop: () => Promise<boolean>
    getSize: () => Promise<[number, number]>
    setSize: (width: number, height: number) => Promise<[number, number]>
  }
  onAppAction?: (callback: (action: string) => void) => () => void
  getGpuInfo: () => Promise<GpuInfo | null>
  getWorkersStatus?: () => Promise<WorkersStatus>
  /** Returns a JPEG screenshot of the display under the cursor, as base64 without a data URL prefix. */
  captureScreen?: () => Promise<string>
  searchWeb?: (query: string, maxResults?: number) => Promise<Array<{ title: string, snippet: string, url: string }>>
  transcribeAudio?: (audioBuffer: ArrayBuffer) => Promise<string>
  synthesizeSpeech?: (options: { text: string, voice?: string, pitch?: string, rate?: string }) => Promise<string>
  player2?: {
    checkHealth: (baseUrl?: string) => Promise<boolean>
    listVoices: (baseUrl?: string) => Promise<Player2Voice[]>
    speak: (baseUrl: string, text: string, voiceId?: string, speed?: number) => Promise<string>
  }
  ollama?: {
    tags: (baseUrl: string) => Promise<{ name: string, size?: number }[]>
    show: (baseUrl: string, model: string) => Promise<{ model_info?: Record<string, unknown> }>
    streamChat: (
      baseUrl: string,
      payload: unknown,
      onChunk: (data: OllamaChunkData) => void,
      onError: (err: string) => void,
      onDone: () => void,
    ) => () => void
  }
  tools?: {
    executeSafe: (toolName: string, args: Record<string, unknown>) => Promise<{ success: boolean, message?: string, data?: unknown }>
    executeSensitive: (toolName: string, args: Record<string, unknown>) => Promise<{ success: boolean, message?: string }>
    getSystemStats: () => Promise<SystemStats>
    getUserPaths: () => Promise<UserSystemPaths>
    readClipboard: () => Promise<string>
  }
}

interface Window {
  /** Injected by Electron preload script for Yukisei. */
  yukisei?: YukiseiApi
  /** Legacy alias for backward compatibility. */
  airiMini?: YukiseiApi
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
