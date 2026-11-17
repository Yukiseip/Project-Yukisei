import { app, BrowserWindow, clipboard, ipcMain } from 'electron'

import {
  abortOllamaChatStream,
  checkPlayer2Health,
  fetchOllamaShow,
  fetchOllamaTags,
  handleOllamaChatStream,
  listPlayer2Voices,
  speakWithPlayer2,
} from '../services/ai-bridge.mjs'
import { executeSafeTool, executeSensitiveTool } from '../services/desktop-tools.mjs'
import { captureActiveDisplay } from '../services/screen-capture.mjs'
import { getFullSystemStats, getUserSystemPaths, readDisks, readGpuInfo } from '../services/system-monitor.mjs'
import { searchWebDuckDuckGo } from '../services/web-search.mjs'
import {
  getWorkersStatus,
  synthesizeNeuralSpeech,
  transcribeAudioBuffer,
} from '../services/workers.mjs'

/**
 * Registers all Electron IPC handlers grouped by domain.
 * @param {() => BrowserWindow | null} getMainWindow
 */
export function registerIpcHandlers(getMainWindow) {
  // 1. Control de Ventana
  ipcMain.handle('window:hide', () => {
    getMainWindow()?.hide()
  })

  ipcMain.handle('window:close', () => {
    app.quit()
  })

  ipcMain.handle('window:toggle-always-on-top', () => {
    const win = getMainWindow()
    if (!win)
      return true
    const current = win.isAlwaysOnTop()
    win.setAlwaysOnTop(!current)
    return !current
  })

  ipcMain.handle('window:is-always-on-top', () => {
    return getMainWindow()?.isAlwaysOnTop() ?? true
  })

  ipcMain.handle('window:get-size', () => {
    return getMainWindow()?.getSize() ?? [520, 820]
  })

  ipcMain.handle('window:set-size', (_, payload) => {
    const win = getMainWindow()
    if (!win || !payload)
      return win?.getSize() ?? [520, 820]
    const width = Math.max(340, Math.min(1920, Math.round(Number(payload.width) || 520)))
    const height = Math.max(480, Math.min(1440, Math.round(Number(payload.height) || 820)))
    win.setSize(width, height)
    return win.getSize()
  })

  // 2. Telemetría y Sistema
  ipcMain.handle('gpu:info', readGpuInfo)
  ipcMain.handle('workers:status', getWorkersStatus)
  ipcMain.handle('tool:system-stats', getFullSystemStats)

  ipcMain.handle('system:user-paths', async () => {
    const userPaths = getUserSystemPaths()
    let drives = []
    try {
      const diskList = await readDisks()
      drives = diskList.map(d => d.name)
    }
    catch {}
    return { ...userPaths, drives }
  })

  ipcMain.handle('clipboard:read', () => {
    return clipboard.readText() || ''
  })

  // 3. Herramientas, Visión y Búsqueda Web
  ipcMain.handle('tool:execute-safe', async (_, payload) => {
    return executeSafeTool(payload?.toolName, payload?.args)
  })

  ipcMain.handle('tool:execute-sensitive', async (_, payload) => {
    return executeSensitiveTool(payload?.toolName, payload?.args)
  })

  ipcMain.handle('screen:capture', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow()
    return captureActiveDisplay(owner)
  })

  ipcMain.handle('web:search', async (_, payload) => {
    const query = typeof payload === 'string' ? payload : payload?.query
    const maxResults = typeof payload === 'object' && payload?.maxResults ? payload.maxResults : 4
    return searchWebDuckDuckGo(query, maxResults)
  })

  // 4. Inteligencia Artificial (Ollama) y Voz (Whisper, Edge-TTS, Player2)
  ipcMain.handle('ollama:tags', (_, baseUrl) => fetchOllamaTags(baseUrl))
  ipcMain.handle('ollama:show', (_, { baseUrl, model }) => fetchOllamaShow(baseUrl, model))
  ipcMain.on('ollama:chat:stream', (event, payload) => handleOllamaChatStream(event, payload))
  ipcMain.on('ollama:chat:abort', (_, { id }) => abortOllamaChatStream(id))

  ipcMain.handle('whisper:transcribe', (_, audioBuffer) => transcribeAudioBuffer(audioBuffer))
  ipcMain.handle('tts:synthesize', (_, options) => synthesizeNeuralSpeech(options))

  ipcMain.handle('player2:health', (_, rawUrl) => checkPlayer2Health(rawUrl))
  ipcMain.handle('player2:voices', (_, rawUrl) => listPlayer2Voices(rawUrl))
  ipcMain.handle('player2:speak', (_, payload) => speakWithPlayer2(payload))
}

