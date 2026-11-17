import { errorMessageFrom, normalizeServiceUrl } from '../utils/errors.mjs'

const activeStreams = new Map()

export function resolveOllamaUrl(rawUrl) {
  return normalizeServiceUrl(rawUrl, 'http://127.0.0.1:11434', true)
}

export async function fetchOllamaTags(baseUrl) {
  const target = resolveOllamaUrl(baseUrl)
  const res = await fetch(`${target}/api/tags`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok)
    throw new Error(`Ollama respondió con error: ${res.status} ${res.statusText}`)
  const data = await res.json()
  return data.models || []
}

export async function fetchOllamaShow(baseUrl, model) {
  const target = resolveOllamaUrl(baseUrl)
  const res = await fetch(`${target}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok)
    throw new Error(`Ollama respondió con error: ${res.status} ${res.statusText}`)
  return await res.json()
}

export async function handleOllamaChatStream(event, { id, baseUrl, payload }) {
  const controller = new AbortController()
  activeStreams.set(id, controller)

  try {
    const target = resolveOllamaUrl(baseUrl)
    const res = await fetch(`${target}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!res.ok)
      throw new Error(`Ollama respondió con error: ${res.status} ${res.statusText}`)
    if (!res.body)
      throw new Error('Ollama no devolvió respuesta')

    const reader = res.body.getReader()
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
        const data = JSON.parse(line)
        if (data.error)
          throw new Error(data.error)
        event.sender.send(`ollama:chat:chunk:${id}`, {
          content: data.message?.content ?? '',
          thinking: data.message?.thinking ?? '',
        })
      }
    }

    event.sender.send(`ollama:chat:done:${id}`)
  }
  catch (err) {
    if (err.name !== 'AbortError') {
      event.sender.send(`ollama:chat:error:${id}`, errorMessageFrom(err) ?? String(err))
    }
    else {
      event.sender.send(`ollama:chat:done:${id}`)
    }
  }
  finally {
    activeStreams.delete(id)
  }
}

export function abortOllamaChatStream(id) {
  const controller = activeStreams.get(id)
  if (controller) {
    controller.abort()
    activeStreams.delete(id)
  }
}

export async function checkPlayer2Health(rawUrl) {
  try {
    const target = normalizeServiceUrl(rawUrl, 'http://127.0.0.1:4315/v1')
    const res = await fetch(`${target}/health`, {
      headers: { 'player2-game-key': 'airi' },
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  }
  catch {
    return false
  }
}

export async function listPlayer2Voices(rawUrl) {
  try {
    const target = normalizeServiceUrl(rawUrl, 'http://127.0.0.1:4315/v1')
    const res = await fetch(`${target}/tts/voices`, {
      headers: { 'player2-game-key': 'airi' },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok)
      return []
    const data = await res.json()
    return data.voices || []
  }
  catch {
    return []
  }
}

export async function speakWithPlayer2({ baseUrl, text, voiceId, speed }) {
  const target = normalizeServiceUrl(baseUrl, 'http://127.0.0.1:4315/v1')
  const payload = {
    text,
    voice_ids: voiceId ? [voiceId] : [],
    audio_format: 'mp3',
    speed: speed ?? 1,
    play_in_app: false,
  }
  const res = await fetch(`${target}/tts/speak`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'player2-game-key': 'airi',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok)
    throw new Error(`Player 2 respondió con código ${res.status} ${res.statusText}`)
  const data = await res.json()
  return data.data || ''
}
