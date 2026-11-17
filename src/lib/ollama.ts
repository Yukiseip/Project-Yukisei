import type { KvLayout } from './context-budget'

import { getDesktopApi } from './desktop-bridge'

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Base64 images without a data URL prefix. Only vision models read them. */
  images?: string[]
}

export interface OllamaStreamChunk {
  /** Visible answer text. */
  content: string
  /** Reasoning text, only when the model supports thinking. */
  thinking: string
}

export interface OllamaChatOptions {
  baseUrl: string
  model: string
  messages: OllamaMessage[]
  think: boolean
  temperature: number
  topP: number
  /** `0` means no limit. */
  maxTokens: number
  numCtx: number
  repeatPenalty: number
  signal?: AbortSignal
}

export function normalizeBaseUrl(baseUrl: string): string {
  let url = (baseUrl || 'http://127.0.0.1:11434').trim()
  if (!/^https?:\/\//i.test(url))
    url = `http://${url}`
  url = url.replace(/\/+$/, '')
  url = url.replace(/\/v1\/?$/, '').replace(/\/api\/?$/, '')
  url = url.replace(/\/+$/, '')
  return url.replace('localhost', '127.0.0.1')
}

export interface OllamaModelSummary {
  name: string
  /** Size of the model files in bytes. The model takes about this much video memory. */
  size: number
}

/** Lists the models that Ollama has downloaded. */
export async function listOllamaModels(baseUrl: string): Promise<OllamaModelSummary[]> {
  // Use desktop bridge if available (100% bypasses browser CORS / Private Network restrictions)
  const api = getDesktopApi()
  if (api?.ollama?.tags) {
    const list = await api.ollama.tags(baseUrl)
    return (list ?? []).map(m => ({ name: m.name, size: m.size ?? 0 }))
  }

  // Fallback for standard browser
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/tags`, {
      signal: controller.signal,
    })
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)
    const data = await response.json() as { models?: { name: string, size?: number }[] }
    return (data.models ?? []).map(m => ({ name: m.name, size: m.size ?? 0 }))
  }
  finally {
    clearTimeout(timer)
  }
}

type InfoValue = number | boolean | (number | boolean)[] | string | undefined

function perLayer<T extends number | boolean>(value: InfoValue, layers: number): (T | undefined)[] {
  if (Array.isArray(value))
    return Array.from({ length: layers }, (_, index) => value[index] as T | undefined)
  if (typeof value === 'number' || typeof value === 'boolean')
    return Array.from({ length: layers }, () => value as T)
  return Array.from<T | undefined>({ length: layers }).fill(undefined)
}

/**
 * Reads the model architecture from Ollama and works out how much video memory its context cache needs.
 */
export async function getOllamaKvLayout(baseUrl: string, model: string): Promise<KvLayout> {
  try {
    let rawInfo: Record<string, InfoValue> | undefined
    const api = getDesktopApi()

    if (api?.ollama?.show) {
      const showData = await api.ollama.show(baseUrl, model)
      rawInfo = (showData as { model_info?: Record<string, InfoValue> }).model_info
    }
    else {
      const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      if (response.ok) {
        const json = await response.json() as { model_info?: Record<string, InfoValue> }
        rawInfo = json.model_info
      }
    }

    const info = rawInfo ?? {}
    const find = (suffix: string) => Object.entries(info).find(([key]) => key.endsWith(suffix))?.[1]

    const layers = find('.block_count')
    if (typeof layers !== 'number') {
      return {
        fullBytesPerToken: 32768,
        windowBytesPerToken: 0,
        window: 0,
        maxContext: 32768,
      }
    }

    const heads = perLayer<number>(find('.attention.head_count'), layers)
    const kvHeads = perLayer<number>(find('.attention.head_count_kv'), layers)
    const slidingPattern = perLayer<boolean>(find('.attention.sliding_window_pattern'), layers)
    const slidingWindow = typeof find('.attention.sliding_window') === 'number' ? find('.attention.sliding_window') as number : 0
    const embedding = typeof find('.embedding_length') === 'number' ? find('.embedding_length') as number : undefined
    const keyLength = find('.attention.key_length')
    const valueLength = find('.attention.value_length')
    const keyLengthWindow = find('.attention.key_length_swa')
    const valueLengthWindow = find('.attention.value_length_swa')

    let fullBytesPerToken = 0
    let windowBytesPerToken = 0

    for (let layer = 0; layer < layers; layer++) {
      const isWindow = slidingWindow > 0 && slidingPattern[layer] === true
      const layerHeads = kvHeads[layer] ?? heads[layer]
      const fallbackSize = embedding && heads[layer] ? embedding / heads[layer]! : undefined
      const key = (isWindow && typeof keyLengthWindow === 'number' ? keyLengthWindow : undefined)
        ?? (typeof keyLength === 'number' ? keyLength : fallbackSize)
      const value = (isWindow && typeof valueLengthWindow === 'number' ? valueLengthWindow : undefined)
        ?? (typeof valueLength === 'number' ? valueLength : key)

      if (!layerHeads || !key || !value)
        continue

      const bytes = layerHeads * (key + value) * 2
      if (isWindow)
        windowBytesPerToken += bytes
      else
        fullBytesPerToken += bytes
    }

    const maxContext = find('.context_length')

    return {
      fullBytesPerToken: fullBytesPerToken || 32768,
      windowBytesPerToken,
      window: slidingWindow,
      maxContext: typeof maxContext === 'number' ? maxContext : 32768,
    }
  }
  catch {
    return {
      fullBytesPerToken: 32768,
      windowBytesPerToken: 0,
      window: 0,
      maxContext: 32768,
    }
  }
}

/** Streams a chat answer from Ollama. */
export async function* streamOllamaChat(options: OllamaChatOptions): AsyncGenerator<OllamaStreamChunk> {
  const payload = {
    model: options.model,
    messages: options.messages,
    stream: true,
    think: options.think,
    options: {
      temperature: options.temperature,
      top_p: options.topP,
      num_predict: options.maxTokens > 0 ? options.maxTokens : -1,
      num_ctx: options.numCtx,
      repeat_penalty: options.repeatPenalty,
    },
  }

  // 1. If in desktop Electron app, use the direct IPC stream
  const api = getDesktopApi()
  if (api?.ollama?.streamChat) {
    const queue: OllamaStreamChunk[] = []
    let done = false
    let error: string | null = null
    let notify: (() => void) | null = null

    const push = (chunk: OllamaStreamChunk) => {
      queue.push(chunk)
      if (notify) {
        notify()
        notify = null
      }
    }

    const abort = api.ollama.streamChat(
      options.baseUrl,
      payload,
      (data) => {
        push({ content: data.content, thinking: data.thinking })
      },
      (err) => {
        error = err
        done = true
        if (notify) {
          notify()
          notify = null
        }
      },
      () => {
        done = true
        if (notify) {
          notify()
          notify = null
        }
      },
    )

    const onAbort = () => {
      done = true
      abort()
      if (notify) {
        notify()
        notify = null
      }
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    // eslint-disable-next-line no-unmodified-loop-condition
    while (!done || queue.length > 0) {
      if (options.signal?.aborted) {
        break
      }
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      if (error)
        throw new Error(error)
      if (done)
        break

      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }

    if (error && !options.signal?.aborted)
      throw new Error(error)
    return
  }

  // 2. Fallback to browser fetch
  let response: Response
  try {
    response = await fetch(`${normalizeBaseUrl(options.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify(payload),
    })
  }
  catch (err) {
    if ((err as Error).name === 'AbortError' || options.signal?.aborted)
      return
    throw err
  }

  if (!response.ok)
    throw new Error(`HTTP ${response.status}`)
  if (!response.body)
    throw new Error('Ollama no devolvió respuesta.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim())
        continue
      const data = JSON.parse(line) as { message?: { content?: string, thinking?: string }, error?: string }
      if (data.error)
        throw new Error(data.error)
      yield { content: data.message?.content ?? '', thinking: data.message?.thinking ?? '' }
    }
  }
}
