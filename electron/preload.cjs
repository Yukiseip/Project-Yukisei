const { contextBridge, ipcRenderer } = require('electron')

const api = {
  windowControl: {
    hide: () => ipcRenderer.invoke('window:hide'),
    close: () => ipcRenderer.invoke('window:close'),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('window:toggle-always-on-top'),
    isAlwaysOnTop: () => ipcRenderer.invoke('window:is-always-on-top'),
    getSize: () => ipcRenderer.invoke('window:get-size'),
    setSize: (width, height) => ipcRenderer.invoke('window:set-size', { width, height }),
  },
  onAppAction: (callback) => {
    const handler = (_, action) => callback(action)
    ipcRenderer.on('app:action', handler)
    return () => ipcRenderer.removeListener('app:action', handler)
  },
  getGpuInfo: () => ipcRenderer.invoke('gpu:info'),
  getWorkersStatus: () => ipcRenderer.invoke('workers:status'),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  searchWeb: (query, maxResults) => ipcRenderer.invoke('web:search', { query, maxResults }),
  transcribeAudio: arrayBuffer => ipcRenderer.invoke('whisper:transcribe', arrayBuffer),
  synthesizeSpeech: options => ipcRenderer.invoke('tts:synthesize', options),
  player2: {
    checkHealth: baseUrl => ipcRenderer.invoke('player2:health', baseUrl),
    listVoices: baseUrl => ipcRenderer.invoke('player2:voices', baseUrl),
    speak: (baseUrl, text, voiceId, speed) => ipcRenderer.invoke('player2:speak', { baseUrl, text, voiceId, speed }),
  },
  ollama: {
    tags: baseUrl => ipcRenderer.invoke('ollama:tags', baseUrl),
    show: (baseUrl, model) => ipcRenderer.invoke('ollama:show', { baseUrl, model }),
    streamChat: (baseUrl, payload, onChunk, onError, onDone) => {
      const id = Math.random().toString(36).slice(2)
      const chunkChannel = `ollama:chat:chunk:${id}`
      const doneChannel = `ollama:chat:done:${id}`
      const errorChannel = `ollama:chat:error:${id}`

      const cleanup = () => {
        ipcRenderer.removeAllListeners(chunkChannel)
        ipcRenderer.removeAllListeners(doneChannel)
        ipcRenderer.removeAllListeners(errorChannel)
      }

      ipcRenderer.on(chunkChannel, (_, data) => onChunk(data))
      ipcRenderer.on(errorChannel, (_, err) => {
        cleanup()
        onError(err)
      })
      ipcRenderer.on(doneChannel, () => {
        cleanup()
        onDone()
      })

      ipcRenderer.send('ollama:chat:stream', { id, baseUrl, payload })

      return () => {
        cleanup()
        ipcRenderer.send('ollama:chat:abort', { id })
        onDone()
      }
    },
  },
  tools: {
    executeSafe: (toolName, args) => {
      const plainArgs = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {}
      return ipcRenderer.invoke('tool:execute-safe', { toolName, args: plainArgs })
    },
    executeSensitive: (toolName, args) => {
      const plainArgs = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {}
      return ipcRenderer.invoke('tool:execute-sensitive', { toolName, args: plainArgs })
    },
    getSystemStats: () => ipcRenderer.invoke('tool:system-stats'),
    getUserPaths: () => ipcRenderer.invoke('system:user-paths'),
    readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  },
}

contextBridge.exposeInMainWorld('yukisei', api)
contextBridge.exposeInMainWorld('airiMini', api)
