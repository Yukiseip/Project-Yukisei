import { ref } from 'vue'

import { useSettingsStore } from '../stores/settings'
import { getDesktopApi } from './desktop-bridge'

const RE_CONTROL_CLOSED = /<\|[\s\S]*?\|>/g
const RE_CONTROL_TRAILING = /<\|[\s\S]*$/g
const RE_TOOL_CLOSED = /<tool_call>[\s\S]*?<\/tool_call>/gi
const RE_TOOL_TRAILING = /<tool_call>[\s\S]*$/gi
const RE_JSON_TOOL = /\{[\s\S]*?"(?:name|tool|args|action|target|level)"\s*:[\s\S]*?\}/gi
const RE_ACT_CALL = /\b(?:ACT|CALL)\s*\{[^}]*\}\s*/gi
const RE_ACT_EMOTION = /\b(?:at|act)\s+emotion\s+[a-z]+\b/gi
const RE_EMOTION_KV = /\bemotion\s*:\s*[a-z]+\b/gi
const RE_CODE_CLOSED = /```[\s\S]*?```/g
const RE_CODE_TRAILING = /```[\s\S]*$/g
const RE_CODE_INLINE = /`[^`]*`/g
const RE_THINK_CLOSED = /<think>[\s\S]*?<\/think>/gi
const RE_THINK_TRAILING = /<think>[\s\S]*$/gi
const RE_URLS = /https?:\/\/\S+/gi
const RE_MD_LINK = /\[([^\]]+)\]\([^)]+\)/g
const RE_EMOJI = /\p{Extended_Pictographic}/gu
const RE_MD_BOLD = /\*\*([^*\n]+)\*\*/g
const RE_STAGE_ASTERISK = /(?<!\*)\*[^*]+\*(?!\*)/g
const RE_STAGE_PARENS = /\((?:se |sonr|asien|suspir|mira|observ|pens|r[ií]e|acomod|levant|camin|tom|dud|apen|averg|anim|bostez)[^)]*\)/gi
const RE_HASH = /#/g
const RE_AMPERSAND = /&/g
const RE_PERCENT = /%/g
const RE_MD_SYMBOLS = /[*_~]/g
const RE_OPEN_PUNCT = /[¿¡]/g
const RE_CLOSE_PUNCT = /[?!]/g
const RE_DASH_BULLET = /(^|\s)[—–-]+(?=\s|\b)/g
const RE_DASH_MID = /\s+[—–-]+\s+/g
const RE_COLON_SEMI = /[:;]/g
const RE_QUOTES = /["'«»“”„]/g
const RE_BRACKETS = /[()[\]{}]/g
const RE_SLASHES = /\s*[/\\|]\s*/g
const RE_ELLIPSIS_DOTS = /\.{2,}/g
const RE_ELLIPSIS_CHAR = /…/g
const RE_DIACRITICS = /[´`^¨~]/g
const RE_COMBINING = /[\u0300-\u036F]/g
const RE_MISC_SYMBOLS = /[/\\|^@*+=<>~]/g
const RE_SPACE_PUNCT = /\s+([,.])/g
const RE_DUP_COMMA = /,\s*,+/g
const RE_DUP_DOT = /\.\s*\.+/g
const RE_COMMA_DOT = /,\s*\./g
const RE_DOT_COMMA = /\.\s*,/g
const RE_LEADING_PUNCT = /^[.,\s]+/
const RE_MULTI_SPACE = /\s+/g
const RE_SENTENCE = /[^.!?\n]+[.!?\n]+/g
const RE_TRAILING_CONTROL = /<\|[\w:\s{}"',-]*$/
const RE_TRAILING_TOOL_OPEN = /<tool_call[\s\S]*$/i
const RE_TRAILING_THINK_OPEN = /<think[\s\S]*$/i
const RE_TRAILING_CODE_OPEN = /```[^`]*$/

export interface VoiceOption {
  id: string
  name: string
  provider: 'neural' | 'player2' | 'browser'
  lang?: string
}

export const neuralVoicePresets: VoiceOption[] = [
  {
    id: 'es-MX-DaliaNeural',
    name: '🌸 Dalia (México) — Anime Waifu Dulce (Recomendada)',
    provider: 'neural',
    lang: 'es-MX',
  },
  {
    id: 'es-ES-ElviraNeural',
    name: '✨ Elvira (España) — Expresiva y Natural',
    provider: 'neural',
    lang: 'es-ES',
  },
  {
    id: 'es-CO-SalomeNeural',
    name: '🍃 Salomé (Colombia) — Suave y Melódica',
    provider: 'neural',
    lang: 'es-CO',
  },
  {
    id: 'es-AR-ElenaNeural',
    name: '⭐ Elena (Argentina) — Jovial y Viva',
    provider: 'neural',
    lang: 'es-AR',
  },
  {
    id: 'es-US-PalomaNeural',
    name: '💖 Paloma (EE. UU.) — Clara y Energética',
    provider: 'neural',
    lang: 'es-US',
  },
]

interface AudioTask {
  id: string
  text: string
  promise: Promise<string | null>
}

export function useTextToSpeech() {
  const settings = useSettingsStore()
  const isSpeaking = ref(false)
  const isPlayer2Online = ref(false)
  const availableVoices = ref<VoiceOption[]>([])

  let taskQueue: AudioTask[] = []
  let streamBuffer = ''
  let currentAudio: HTMLAudioElement | null = null
  let isProcessingQueue = false
  let currentSessionId = 0

  async function checkPlayer2Health(): Promise<boolean> {
    try {
      const api = getDesktopApi()
      if (api?.player2) {
        const ok = await api.player2.checkHealth(settings.player2Url)
        isPlayer2Online.value = ok
        return ok
      }

      const url = `${settings.player2Url.replace(/\/+$/, '')}/health`
      const res = await fetch(url, {
        headers: { 'player2-game-key': 'airi' },
        signal: AbortSignal.timeout(2500),
      })
      isPlayer2Online.value = res.ok
      return res.ok
    }
    catch {
      isPlayer2Online.value = false
      return false
    }
  }

  function getSpanishBrowserVoices(): VoiceOption[] {
    if (typeof window === 'undefined' || !('speechSynthesis' in window))
      return []
    const out: VoiceOption[] = []
    const browserList = window.speechSynthesis.getVoices()
    for (const v of browserList) {
      if (v.lang.toLowerCase().startsWith('es')) {
        const lower = v.name.toLowerCase()
        const isFemale = lower.includes('sabina') || lower.includes('helena') || lower.includes('laura') || lower.includes('monica')
        const tag = isFemale ? ' (Femenina)' : ''
        out.push({
          id: v.voiceURI,
          name: `${v.name}${tag}`,
          provider: 'browser',
          lang: v.lang,
        })
      }
    }
    return out
  }

  function refreshBrowserVoices() {
    const nonBrowser = availableVoices.value.filter(v => v.provider !== 'browser')
    availableVoices.value = [
      ...(nonBrowser.length > 0 ? nonBrowser : neuralVoicePresets),
      ...getSpanishBrowserVoices(),
    ]
  }

  async function loadVoices() {
    const list: VoiceOption[] = [...neuralVoicePresets]

    // 1. Player 2 voices if online
    const p2Online = await checkPlayer2Health()
    if (p2Online) {
      try {
        let p2Voices: { id: string, name: string, language?: string }[] = []
        const api = getDesktopApi()
        if (api?.player2) {
          p2Voices = await api.player2.listVoices(settings.player2Url)
        }
        else {
          const url = `${settings.player2Url.replace(/\/+$/, '')}/tts/voices`
          const res = await fetch(url, { headers: { 'player2-game-key': 'airi' } })
          if (res.ok) {
            const data = await res.json() as { voices?: { id: string, name: string, language?: string }[] }
            p2Voices = data.voices || []
          }
        }

        for (const v of p2Voices) {
          list.push({
            id: v.id,
            name: `${v.name} (Player 2)`,
            provider: 'player2',
            lang: v.language || 'es',
          })
        }
      }
      catch {
        // Player 2 voice loading failed
      }
    }

    // 2. Browser Spanish voices (strictly filter / prefer female voices)
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      list.push(...getSpanishBrowserVoices())
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = refreshBrowserVoices
      }
    }

    availableVoices.value = list
  }

  /**
   * Sanitizes text thoroughly so speech engines never verbalize signs,
   * questions, accents or formatting words out loud.
   */
  function cleanTextForSpeech(raw: string): string {
    if (!raw)
      return ''

    // 1. Unicode NFC normalization (merges decomposed accents like o + ´ into single ó)
    let text = raw.normalize('NFC')

    // 2. Remove AIRI protocol tags (<|ACT ...|>, <|CALL ...|>) and residual control words
    text = text.replace(RE_CONTROL_CLOSED, '')
    text = text.replace(RE_CONTROL_TRAILING, '')
    text = text.replace(RE_TOOL_CLOSED, '')
    text = text.replace(RE_TOOL_TRAILING, '')
    text = text.replace(RE_JSON_TOOL, '')
    text = text.replace(RE_ACT_CALL, '')
    text = text.replace(RE_ACT_EMOTION, '')
    text = text.replace(RE_EMOTION_KV, '')

    // 3. Remove code blocks and inline code
    text = text.replace(RE_CODE_CLOSED, '')
    text = text.replace(RE_CODE_TRAILING, '')
    text = text.replace(RE_CODE_INLINE, '')

    // 4. Remove thinking / reasoning blocks
    text = text.replace(RE_THINK_CLOSED, '')

    // 5. Remove URLs
    text = text.replace(RE_URLS, '')

    // 6. Remove markdown links, keep text: [label](url) -> label
    text = text.replace(RE_MD_LINK, '$1')

    // 7. Remove all emojis
    text = text.replace(RE_EMOJI, '')

    // 8. Convert markdown bold to plain spoken words (**palabra** -> palabra)
    text = text.replace(RE_MD_BOLD, '$1')

    // 9. Remove action / roleplay stage directions (e.g. *observa la pantalla*, *sonríe*, (suspira))
    text = text.replace(RE_STAGE_ASTERISK, '')
    text = text.replace(RE_STAGE_PARENS, '')

    // 10. Convert '#' before stripping remaining markdown formatting symbols (*, _, ~)
    text = text.replace(RE_HASH, ' número ')
    text = text.replace(RE_MD_SYMBOLS, '')

    // 11. Remove all question marks and exclamation marks so no engine ever says 'signo de interrogación'
    text = text.replace(RE_OPEN_PUNCT, '')
    text = text.replace(RE_CLOSE_PUNCT, '.')

    // 12. Dialogue dashes and bullet points (- or — or –)
    text = text.replace(RE_DASH_BULLET, '$1')
    text = text.replace(RE_DASH_MID, ', ')

    // 13. Colons and semicolons: replace with comma for natural pause
    text = text.replace(RE_COLON_SEMI, ', ')

    // 14. Quotes: remove all quotes so it never says 'comillas'
    text = text.replace(RE_QUOTES, '')

    // 15. Parentheses and brackets: keep inner words, remove brackets
    text = text.replace(RE_BRACKETS, ', ')

    // 16. Slashes and backslashes
    text = text.replace(RE_SLASHES, ', ')

    // 17. Ellipses: replace '...' or '…' with a simple comma for a natural pause
    text = text.replace(RE_ELLIPSIS_DOTS, ', ')
    text = text.replace(RE_ELLIPSIS_CHAR, ', ')

    // 18. Remove standalone accents, diacritics and combining marks so it never says 'acento'
    text = text.replace(RE_DIACRITICS, '')
    text = text.replace(RE_COMBINING, '')

    // 19. Convert remaining special symbols to words or space
    text = text.replace(RE_AMPERSAND, ' y ')
    text = text.replace(RE_PERCENT, ' por ciento ')
    text = text.replace(RE_MISC_SYMBOLS, ' ')

    // 20. Clean punctuation spacing and collapse duplicate commas/dots
    text = text.replace(RE_SPACE_PUNCT, '$1')
    text = text.replace(RE_DUP_COMMA, ', ')
    text = text.replace(RE_DUP_DOT, '. ')
    text = text.replace(RE_COMMA_DOT, '. ')
    text = text.replace(RE_DOT_COMMA, '. ')

    // 21. Clean leading dots/commas and duplicate whitespace
    text = text.replace(RE_LEADING_PUNCT, '')
    text = text.replace(RE_MULTI_SPACE, ' ').trim()

    return text
  }

  /** Background synthesizes audio data immediately */
  async function synthesizeAudioData(text: string): Promise<string | null> {
    const api = getDesktopApi()
    if (settings.ttsProvider === 'neural' && api?.synthesizeSpeech) {
      try {
        const rateDelta = Math.round((settings.ttsSpeed - 1.0) * 100)
        const rateStr = rateDelta >= 0 ? `+${rateDelta}%` : `${rateDelta}%`
        const base64 = await api.synthesizeSpeech({
          text,
          voice: settings.neuralVoice || 'es-MX-DaliaNeural',
          pitch: settings.neuralPitch || '+8Hz',
          rate: rateStr,
        })
        if (base64)
          return base64
      }
      catch (err) {
        console.warn('[tts] Neural TTS synthesis error:', err)
      }
    }

    if (settings.ttsProvider === 'player2' && isPlayer2Online.value && api?.player2) {
      try {
        const base64 = await api.player2.speak(
          settings.player2Url,
          text,
          settings.player2Voice,
          settings.ttsSpeed,
        )
        if (base64)
          return base64
      }
      catch (err) {
        console.warn('[tts] Player 2 synthesis error:', err)
      }
    }

    return null
  }

  /** Plays pre-synthesized audio with zero delay */
  function playBase64Audio(base64: string): Promise<void> {
    return new Promise((resolve) => {
      const audio = new Audio(`data:audio/mp3;base64,${base64}`)
      currentAudio = audio
      audio.volume = Math.max(0.1, Math.min(1.0, settings.ttsVolume ?? 1.0))
      audio.preload = 'auto'

      if (settings.audioOutputDeviceId && typeof audio.setSinkId === 'function') {
        void audio.setSinkId(settings.audioOutputDeviceId).catch(() => {})
      }

      let safetyTimer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const done = () => {
        if (finished)
          return
        finished = true
        if (currentAudio === audio)
          currentAudio = null
        if (safetyTimer)
          clearTimeout(safetyTimer)
        resolve()
      }

      // Safety timeout: 20 seconds maximum per sentence
      safetyTimer = setTimeout(done, 20000)

      audio.onended = done
      audio.onerror = done

      audio.play().catch(done)
    })
  }

  /** Browser SpeechSynthesis fallback, guaranteed female voices */
  async function speakBrowser(text: string): Promise<void> {
    if (typeof window === 'undefined' || !('speechSynthesis' in window))
      return

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'es-MX'
      utterance.rate = settings.ttsSpeed || 1.15
      utterance.volume = settings.ttsVolume ?? 1.0

      const voices = window.speechSynthesis.getVoices()
      if (settings.browserVoice) {
        const selected = voices.find(v => v.voiceURI === settings.browserVoice)
        if (selected)
          utterance.voice = selected
      }

      if (!utterance.voice) {
        const femaleKeywords = ['sabina', 'helena', 'laura', 'monica', 'elena', 'carmen', 'lucia', 'sofia', 'maria', 'paulina', 'female']
        const maleKeywords = ['raul', 'pablo', 'david', 'jorge', 'carlos', 'male', 'hombre']

        const spanishVoices = voices.filter(v => v.lang.toLowerCase().startsWith('es'))
        const femaleVoice = spanishVoices.find((v) => {
          const lower = v.name.toLowerCase()
          return femaleKeywords.some(k => lower.includes(k)) && !maleKeywords.some(k => lower.includes(k))
        })

        if (femaleVoice) {
          utterance.voice = femaleVoice
        }
        else {
          const notMale = spanishVoices.find((v) => {
            const lower = v.name.toLowerCase()
            return !maleKeywords.some(k => lower.includes(k))
          })
          utterance.voice = notMale || spanishVoices[0]
        }
      }

      const safetyMs = Math.max(5000, text.length * 150)
      const safetyTimer = setTimeout(() => {
        resolve()
      }, safetyMs)

      utterance.onend = () => {
        clearTimeout(safetyTimer)
        resolve()
      }
      utterance.onerror = () => {
        clearTimeout(safetyTimer)
        resolve()
      }

      window.speechSynthesis.speak(utterance)
    })
  }

  /**
   * Processes pre-synthesized audio queue sequentially with zero gaps
   */
  async function processQueue(sessionId: number) {
    if (isProcessingQueue)
      return
    isProcessingQueue = true

    while (taskQueue.length > 0) {
      if (!settings.ttsEnabled || currentSessionId !== sessionId) {
        taskQueue = []
        break
      }

      const task = taskQueue.shift()
      if (!task)
        continue

      isSpeaking.value = true

      try {
        // Audio is pre-fetched in the background while the previous sentence played!
        const base64 = await task.promise

        // Retry the same voice once. The browser voice sounds different, so use it only without a neural or Player 2 voice.
        const audio = base64 ?? (settings.ttsProvider === 'browser' ? null : await synthesizeAudioData(task.text))

        if (currentSessionId !== sessionId)
          break

        if (audio) {
          await playBase64Audio(audio)
        }
        else if (settings.ttsProvider === 'browser') {
          await speakBrowser(task.text)
        }
      }
      catch (err) {
        console.warn('[tts] Error playing audio task:', err)
      }
    }

    isSpeaking.value = false
    isProcessingQueue = false
  }

  function queueSentence(sentence: string) {
    if (!settings.ttsEnabled)
      return

    const clean = cleanTextForSpeech(sentence)
    if (!clean || clean.length < 2)
      return

    const sessionId = currentSessionId
    const taskId = Math.random().toString(36).slice(2)

    // Pre-synthesize IMMEDIATELY in parallel with current playback!
    const promise = synthesizeAudioData(clean)

    taskQueue.push({ id: taskId, text: clean, promise })
    processQueue(sessionId)
  }

  /** Feeds incoming LLM streaming chunks and detects full sentences */
  function pushChunk(chunk: string) {
    if (!settings.ttsEnabled)
      return

    streamBuffer += chunk

    // Strip fully closed control tags, tool calls, and code blocks immediately
    streamBuffer = streamBuffer
      .replace(RE_CONTROL_CLOSED, '')
      .replace(RE_TOOL_CLOSED, '')
      .replace(RE_THINK_CLOSED, '')
      .replace(RE_CODE_CLOSED, '')

    // If an unclosed control tag, tool call, thinking tag or code block is streaming, hold back until it finishes
    if (
      RE_TRAILING_CONTROL.test(streamBuffer)
      || RE_TRAILING_TOOL_OPEN.test(streamBuffer)
      || RE_TRAILING_THINK_OPEN.test(streamBuffer)
      || RE_TRAILING_CODE_OPEN.test(streamBuffer)
    ) {
      return
    }

    // Match full sentences ending in . ! ? or newline
    RE_SENTENCE.lastIndex = 0
    let match: RegExpExecArray | null = null
    let lastIndex = 0

    while ((match = RE_SENTENCE.exec(streamBuffer)) !== null) {
      const sentence = match[0]
      // Don't split on numbers (e.g. 3.14) or tiny fragments
      if (sentence.trim().length > 2) {
        queueSentence(sentence)
        lastIndex = match.index + match[0].length
      }
    }

    if (lastIndex > 0) {
      streamBuffer = streamBuffer.slice(lastIndex)
    }
    else if (streamBuffer.length > 55) {
      // Natural clause split: if 55+ chars have accumulated without a period, split on comma or semicolon
      const pauseIdx = Math.max(
        streamBuffer.lastIndexOf(','),
        streamBuffer.lastIndexOf(';'),
        streamBuffer.lastIndexOf(':'),
      )
      if (pauseIdx > 18) {
        const clause = streamBuffer.slice(0, pauseIdx + 1)
        queueSentence(clause)
        streamBuffer = streamBuffer.slice(pauseIdx + 1)
      }
    }
  }

  /** Flushes any remaining text when streaming completes */
  function finishStream() {
    streamBuffer = streamBuffer
      .replace(RE_CONTROL_CLOSED, '')
      .replace(RE_CONTROL_TRAILING, '')
      .replace(RE_TOOL_CLOSED, '')
      .replace(RE_TOOL_TRAILING, '')
      .replace(RE_THINK_CLOSED, '')
      .replace(RE_THINK_TRAILING, '')
      .replace(RE_CODE_CLOSED, '')
      .replace(RE_CODE_TRAILING, '')
      .replace(RE_JSON_TOOL, '')
      .trim()

    if (streamBuffer.length > 0) {
      queueSentence(streamBuffer)
      streamBuffer = ''
    }
  }

  function cancel() {
    currentSessionId++ // Invalidate active session and stop background tasks
    taskQueue = []
    streamBuffer = ''
    isSpeaking.value = false

    if (currentAudio) {
      currentAudio.pause()
      currentAudio.src = ''
      currentAudio = null
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
  }

  async function testVoice(sample = 'Hola, soy Yukisei. ¿En qué te puedo ayudar hoy?') {
    cancel()
    queueSentence(sample)
  }

  return {
    isSpeaking,
    isPlayer2Online,
    availableVoices,
    checkPlayer2Health,
    loadVoices,
    queueSentence,
    pushChunk,
    finishStream,
    cancel,
    testVoice,
  }
}
