import type { SystemStats, ToolCallItem, UserPathsInfo } from '../lib/desktop-tools'
import type { OllamaMessage } from '../lib/ollama'

import { errorMessageFrom } from '@moeru/std'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import { estimateTokens, trimHistory } from '../lib/context-budget'
import {
  buildDesktopToolsPrompt,
  formatClipboardContext,
  formatSystemStatsContext,
  isQueryTool,
  parseToolCalls,
  sanitizeDisplayContent,
} from '../lib/desktop-tools'
import { getDesktopApi } from '../lib/desktop-bridge'
import { streamOllamaChat } from '../lib/ollama'
import { defaultScreenPrompt, imageTokenCost } from '../lib/vision'
import { formatWebContext } from '../lib/web-search'
import { useMemoryStore } from './memory'
import { useSettingsStore } from './settings'

export interface ChatMetrics {
  tokensPerSec: number
  totalTokens: number
  durationMs: number
}

export interface ChatEntry {
  id: number
  role: 'user' | 'assistant'
  content: string
  thinking: string
  /** The user message had a screenshot or attached image. */
  hasImage?: boolean
  /** Name of attached file or code */
  attachmentName?: string
  /** Web search sources consulted for this message */
  webSources?: Array<{ title: string, url: string }>
  /** Desktop tool calls detected in this turn */
  toolCalls?: ToolCallItem[]
  /** Memories learned in this turn */
  memoriesSaved?: string[]
  /** Response speed and token metrics */
  metrics?: ChatMetrics
}

export interface ChatSendOptions {
  image?: string
  attachmentName?: string
  webSources?: Array<{ title: string, url: string }>
  /** Hidden context (e.g. web search facts) injected into LLM prompt without polluting chat bubble */
  promptContext?: string
}

const storageKey = 'yukisei:conversation'
let cachedUserPaths: UserPathsInfo | undefined

function load(): ChatEntry[] {
  try {
    const raw = localStorage.getItem(storageKey) || localStorage.getItem('airi-mini:conversation')
    return JSON.parse(raw ?? '[]') as ChatEntry[]
  }
  catch {
    return []
  }
}

function formatQueryToolObservation(tool: ToolCallItem): string {
  if (tool.status === 'error') {
    return `[Resultado de herramienta ${tool.name}]: Error: ${tool.error || 'No se pudo completar.'}`
  }
  if (tool.name === 'get_system_stats' && tool.result && typeof tool.result === 'object') {
    return formatSystemStatsContext(tool.result as SystemStats)
  }
  if (tool.name === 'clipboard_read' && tool.result && typeof tool.result === 'object') {
    const data = tool.result as { text?: string }
    return formatClipboardContext(data.text || '')
  }
  if (tool.name === 'list_directory' && tool.result && typeof tool.result === 'object') {
    const data = tool.result as { path?: string, items?: Array<{ name: string, type: string, sizeKb: number }> }
    const listText = (data.items || [])
      .map(i => `- [${i.type === 'folder' ? 'CARPETA' : 'ARCHIVO'}] ${i.name}${i.type === 'file' ? ` (${i.sizeKb} KB)` : ''}`)
      .join('\n')
    return `<contexto_carpeta path="${data.path || ''}">\nContenido real encontrado (${(data.items || []).length} elementos):\n${listText || '(Carpeta vacía)'}\n</contexto_carpeta>`
  }
  if (tool.name === 'web_search' && tool.result && typeof tool.result === 'object') {
    const data = tool.result as { query?: string, results?: Array<{ title: string, snippet: string, url: string }> }
    return formatWebContext(data.query || '', data.results || []) || `[Búsqueda sin resultados para "${data.query || ''}"]`
  }
  return `[Resultado de ${tool.name}]: ${JSON.stringify(tool.result ?? {})}`
}

export const useChatStore = defineStore('yukisei-chat', () => {
  const settings = useSettingsStore()
  const memoryStore = useMemoryStore()
  const entries = ref<ChatEntry[]>(load())
  const busy = ref(false)
  const error = ref('')
  let nextId = Math.max(0, ...entries.value.map(entry => entry.id)) + 1
  let controller: AbortController | undefined

  type ChunkListener = (chunk: string) => void
  type VoidListener = () => void

  const chunkListeners = new Set<ChunkListener>()
  const doneListeners = new Set<VoidListener>()
  const stopListeners = new Set<VoidListener>()

  function onChunk(cb: ChunkListener) {
    chunkListeners.add(cb)
    return () => chunkListeners.delete(cb)
  }

  function onDone(cb: VoidListener) {
    doneListeners.add(cb)
    return () => doneListeners.delete(cb)
  }

  function onStop(cb: VoidListener) {
    stopListeners.add(cb)
    return () => stopListeners.delete(cb)
  }

  watch(busy, (isBusy) => {
    if (!isBusy)
      localStorage.setItem(storageKey, JSON.stringify(entries.value))
  })

  async function buildSystemPrompt(): Promise<string> {
    const api = getDesktopApi()
    if (settings.desktopToolsEnabled && !cachedUserPaths && api?.tools?.getUserPaths) {
      try {
        cachedUserPaths = await api.tools.getUserPaths()
      }
      catch {}
    }

    const parts = [settings.persona]
    if (settings.autoMemoryEnabled || memoryStore.items.length > 0) {
      parts.push(memoryStore.buildMemorySystemBlock())
    }
    if (settings.desktopToolsEnabled) {
      parts.push(buildDesktopToolsPrompt(cachedUserPaths))
    }
    return parts.join('\n\n')
  }

  async function runAssistantTurn(
    live: ChatEntry,
    opts: ChatSendOptions,
  ) {
    busy.value = true
    controller = new AbortController()
    const startedAt = performance.now()

    try {
      const systemPrompt = await buildSystemPrompt()
      const image = opts.image

      const history = trimHistory(
        entries.value
          .filter(entry => entry.id !== live.id)
          .map(entry => ({ role: entry.role, content: sanitizeDisplayContent(entry.content) || entry.content })),
        {
          numCtx: settings.numCtx,
          systemTokens: estimateTokens(systemPrompt),
          answerReserve: (settings.maxTokens > 0 ? settings.maxTokens : 1024) + (image ? imageTokenCost : 0),
          maxMessages: settings.maxMessages,
        },
      )

      const messages: OllamaMessage[] = [{ role: 'system', content: systemPrompt }, ...history]
      const last = messages[messages.length - 1]
      if (last?.role === 'user') {
        const enrichedContent = opts.promptContext
          ? `${opts.promptContext}\n\n${last.content}`
          : last.content
        messages[messages.length - 1] = {
          ...last,
          content: enrichedContent,
          ...(image ? { images: [image] } : {}),
        }
      }

      const stream = streamOllamaChat({
        baseUrl: settings.ollamaUrl,
        model: settings.model,
        think: settings.think,
        temperature: settings.temperature,
        topP: settings.topP,
        maxTokens: settings.maxTokens,
        numCtx: settings.numCtx,
        repeatPenalty: settings.repeatPenalty,
        signal: controller.signal,
        messages,
      })

      for await (const chunk of stream) {
        if (!busy.value)
          break
        live.content += chunk.content
        live.thinking += chunk.thinking
        if (chunk.content) {
          chunkListeners.forEach(fn => fn(chunk.content))
        }
      }

      // Extract inline <think>...</think> blocks if model emitted them inside content
      const inlineThinkMatch = live.content.match(/<think>([\s\S]*?)<\/think>/i)
      if (inlineThinkMatch) {
        live.thinking = `${live.thinking}\n${inlineThinkMatch[1].trim()}`.trim()
        live.content = live.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      }

      // Extract and persist any <|MEMORY {...}|> blocks
      const memResult = memoryStore.extractAndSaveFromText(live.content, settings.autoMemoryEnabled)
      live.content = memResult.cleanText
      if (memResult.saved.length > 0) {
        live.memoriesSaved = memResult.saved.map(m => m.fact)
      }

      // Check for ReAct query tools & desktop action tools
      const api = getDesktopApi()
      if (settings.desktopToolsEnabled && api?.tools) {
        const parsed = parseToolCalls(live.content)
        if (parsed.toolCalls.length > 0) {
          const queryTools = parsed.toolCalls.filter(t => isQueryTool(t.name))
          const actionTools = parsed.toolCalls.filter(t => !isQueryTool(t.name))

          // Execute safe (non-sensitive) action tools immediately
          for (const tool of actionTools) {
            if (!tool.isSensitive) {
              try {
                tool.status = 'executing'
                const res = await api.tools.executeSafe(tool.name, tool.args)
                tool.status = res.success ? 'completed' : 'error'
                tool.result = res.message || (typeof res.data === 'string' ? res.data : (res.data ? JSON.stringify(res.data) : undefined))
                if (!res.success)
                  tool.error = res.message
              }
              catch (err) {
                tool.status = 'error'
                tool.error = errorMessageFrom(err) ?? 'Error al ejecutar herramienta'
              }
            }
          }

          if (queryTools.length > 0 && busy.value) {
            const observations: string[] = []
            for (const tool of queryTools) {
              try {
                tool.status = 'executing'
                const res = await api.tools.executeSafe(tool.name, tool.args)
                tool.status = res.success ? 'completed' : 'error'
                tool.result = res.data ?? res.message
                if (!res.success)
                  tool.error = res.message
                if (tool.name === 'web_search' && res.data && typeof res.data === 'object') {
                  const searchData = res.data as { results?: Array<{ title: string, url: string }> }
                  if (searchData.results?.length) {
                    live.webSources = searchData.results.map(r => ({ title: r.title, url: r.url }))
                  }
                }
              }
              catch (err) {
                tool.status = 'error'
                tool.error = errorMessageFrom(err) ?? 'Error al ejecutar herramienta'
              }
              observations.push(formatQueryToolObservation(tool))
            }

            live.toolCalls = [...queryTools, ...actionTools]

            // Stream the second ReAct pass so Yukisei answers naturally with the real tool data!
            const followUpMessages: OllamaMessage[] = [
              ...messages,
              { role: 'assistant', content: live.content },
              {
                role: 'user',
                content: `${observations.join('\n\n')}\n\n[Instrucción del sistema]: Con base en los datos reales obtenidos por las herramientas anteriores, responde ahora al usuario con naturalidad y precisión en 2 a 4 oraciones. No vuelvas a emitir etiquetas <tool_call>.`,
              },
            ]

            live.content = ''
            const followUpStream = streamOllamaChat({
              baseUrl: settings.ollamaUrl,
              model: settings.model,
              think: false,
              temperature: settings.temperature,
              topP: settings.topP,
              maxTokens: settings.maxTokens,
              numCtx: settings.numCtx,
              repeatPenalty: settings.repeatPenalty,
              signal: controller.signal,
              messages: followUpMessages,
            })

            for await (const chunk of followUpStream) {
              if (!busy.value)
                break
              live.content += chunk.content
              if (chunk.content) {
                chunkListeners.forEach(fn => fn(chunk.content))
              }
            }

            const followUpMem = memoryStore.extractAndSaveFromText(live.content, settings.autoMemoryEnabled)
            live.content = sanitizeDisplayContent(followUpMem.cleanText)
          }
          else {
            live.toolCalls = actionTools
            live.content = parsed.cleanText
          }
        }
      }

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt))
      const totalTokens = estimateTokens(live.content) + estimateTokens(live.thinking)
      const tokensPerSec = Number(((totalTokens / durationMs) * 1000).toFixed(1))
      live.metrics = {
        tokensPerSec,
        totalTokens,
        durationMs,
      }
    }
    catch (caught) {
      if ((caught as Error).name !== 'AbortError')
        error.value = errorMessageFrom(caught) ?? 'No pude hablar con Ollama.'
    }
    finally {
      busy.value = false
      controller = undefined
      doneListeners.forEach(fn => fn())
    }
  }

  async function send(text: string, options?: string | ChatSendOptions) {
    const opts: ChatSendOptions = typeof options === 'string' ? { image: options } : (options ?? {})
    const image = opts.image
    const content = text.trim() || (image ? defaultScreenPrompt : '')
    if (!content || busy.value)
      return

    error.value = ''
    entries.value.push({
      id: nextId++,
      role: 'user',
      content,
      thinking: '',
      hasImage: Boolean(image),
      attachmentName: opts.attachmentName,
      webSources: opts.webSources,
    })
    entries.value.push({ id: nextId++, role: 'assistant', content: '', thinking: '' })
    const live = entries.value[entries.value.length - 1]!

    await runAssistantTurn(live, opts)
  }

  async function regenerateLast() {
    if (busy.value || entries.value.length === 0)
      return

    const lastIdx = entries.value.length - 1
    const lastEntry = entries.value[lastIdx]
    if (lastEntry?.role === 'assistant') {
      lastEntry.content = ''
      lastEntry.thinking = ''
      lastEntry.toolCalls = undefined
      lastEntry.memoriesSaved = undefined
      lastEntry.metrics = undefined
      error.value = ''
      await runAssistantTurn(lastEntry, {})
    }
  }

  function stop() {
    busy.value = false
    controller?.abort()
    controller = undefined
    stopListeners.forEach(fn => fn())
  }

  /** Starts a new conversation and forgets the saved one. */
  function clear() {
    stop()
    entries.value = []
    error.value = ''
    localStorage.removeItem(storageKey)
  }

  return {
    entries,
    busy,
    error,
    send,
    regenerateLast,
    stop,
    clear,
    onChunk,
    onDone,
    onStop,
  }
})
