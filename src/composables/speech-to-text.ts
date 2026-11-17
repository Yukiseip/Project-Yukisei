import { errorMessageFrom } from '@moeru/std'
import { computed, ref, watch } from 'vue'

import { getDesktopApi } from '../lib/desktop-bridge'
import { useSettingsStore } from '../stores/settings'

export interface SpeechToTextOptions {
  onTranscript?: (text: string, isFinal: boolean) => void
  onBargeIn?: () => void
  onError?: (error: string) => void
  isAssistantSpeaking?: () => boolean
}

function normalizeText(raw: string): string {
  if (!raw)
    return ''
  let text = raw.trim()
  text = text.replace(/\b[yY]uki\s+[sS]ei\b/g, 'Yukisei')
  text = text.replace(/\b[yY]uqui\s*[sS]ei\b/g, 'Yukisei')
  text = text.replace(/\b[yY]uquisei\b/g, 'Yukisei')
  text = text.replace(/\b[yY]ukisey\b/g, 'Yukisei')
  text = text.replace(/\bo\s+like\s+o\s+quiz[aá]s\b/gi, 'Hola Yukisei')
  text = text.replace(/\bhola\s+yo\s+que\s+s[eé]\b/gi, 'Hola Yukisei')
  return text
}

/** Detects empty noise or common Whisper hallucinations triggered by silence/ambient hum */
function isNoiseOrHallucination(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned || cleaned.length < 2)
    return true
  if (!/[a-záéíóúñ0-9]/i.test(cleaned))
    return true

  const hallucinationPatterns = [
    /^subt[ií]tulos\s+por/i,
    /^amara\.org/i,
    /^gracias\s*[.!]?$/i,
    /^muchas\s+gracias\s*[.!]?$/i,
    /^gracias\s+por\s+(?:ver|escuchar|sintonizar)/i,
    /^[[(].*?[\])]$/,
    /^m[uú]sica\s*[.!]?$/i,
    /^continuar[aá]\s*[.!]?$/i,
    /^suscr[ií]bete/i,
    /^you\s*[.!]?$/i,
  ]
  return hallucinationPatterns.some(pattern => pattern.test(cleaned))
}

/** Encodes raw 32-bit Float PCM samples into a standard 16-bit mono RIFF/WAVE ArrayBuffer */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  // RIFF container
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')

  // fmt chunk
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM subchunk size
  view.setUint16(20, 1, true) // AudioFormat 1 = PCM
  view.setUint16(22, 1, true) // NumChannels = 1 (mono)
  view.setUint32(24, sampleRate, true) // SampleRate
  view.setUint32(28, sampleRate * 2, true) // ByteRate (sampleRate * 1 * 2)
  view.setUint16(32, 2, true) // BlockAlign (1 * 2)
  view.setUint16(34, 16, true) // BitsPerSample = 16

  // data chunk
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  // 16-bit PCM samples
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }

  return buffer
}

export function useSpeechToText(options: SpeechToTextOptions = {}) {
  const settings = useSettingsStore()
  const isListening = ref(false)
  const isSpeaking = ref(false)
  const isTranscribing = ref(false)
  const errorMessage = ref('')
  const silenceCountdown = ref(0)
  const audioLevel = ref(0)

  let activeStream: MediaStream | null = null
  let audioContext: AudioContext | null = null
  let gainNode: GainNode | null = null
  let scriptNode: ScriptProcessorNode | null = null
  let silentGain: GainNode | null = null

  const thresholdLevel = computed(() => {
    const sens = Math.max(1, Math.min(100, settings.micSensitivity ?? 50))
    // Accessible voice curve: sens 50 -> ~0.024 RMS; sens 80 -> ~0.011 RMS; sens 100 -> 0.003 RMS
    const base = Math.max(0.003, 0.045 - (sens / 100) * 0.042)
    return Math.min(100, Math.round(base * 350))
  })

  watch(() => settings.micGain, (gain) => {
    if (gainNode) {
      gainNode.gain.value = Math.max(0.1, Math.min(3.0, gain))
    }
  })

  watch(() => settings.audioInputDeviceId, async () => {
    if (isListening.value) {
      stop()
      await start()
    }
  })

  async function start() {
    errorMessage.value = ''
    silenceCountdown.value = 0
    isSpeaking.value = false
    audioLevel.value = 0

    try {
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      if (settings.audioInputDeviceId) {
        audioConstraints.deviceId = { exact: settings.audioInputDeviceId }
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      }
      catch {
        // Fallback to default audio device if selected deviceId is disconnected/unavailable
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
      }

      activeStream = stream

      const AudioCtx = window.AudioContext ?? Reflect.get(window, 'webkitAudioContext') as typeof AudioContext | undefined
      if (!AudioCtx) {
        throw new Error('AudioContext no está disponible en este entorno')
      }

      // Target 16kHz native Whisper sample rate
      audioContext = new AudioCtx({ sampleRate: 16000 })
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }

      const sampleRate = audioContext.sampleRate
      const source = audioContext.createMediaStreamSource(stream)

      // Buffer size 4096 gives ~256ms per audio chunk at 16kHz
      scriptNode = audioContext.createScriptProcessor(4096, 1, 1)

      // Silent gain node to keep scriptNode processing without output feedback loop
      silentGain = audioContext.createGain()
      silentGain.gain.value = 0

      // User-configurable microphone digital gain / volume
      gainNode = audioContext.createGain()
      gainNode.gain.value = Math.max(0.1, Math.min(3.0, settings.micGain ?? 1.0))

      source.connect(gainNode)
      gainNode.connect(scriptNode)
      scriptNode.connect(silentGain)
      silentGain.connect(audioContext.destination)

      // Rolling pre-roll buffer (~350ms to preserve the first consonant of speech)
      const preRollCapacity = Math.round(sampleRate * 0.35)
      const preRollBuffer = new Float32Array(preRollCapacity)
      let preRollCount = 0

      let turnBuffers: Float32Array[] = []
      let hasSpoken = false
      let silenceStart = Date.now()
      let consecutiveBargeInFrames = 0

      scriptNode.onaudioprocess = (event) => {
        if (!isListening.value)
          return

        const input = event.inputBuffer.getChannelData(0)

        // Calculate RMS audio energy
        let sum = 0
        for (let i = 0; i < input.length; i++) {
          const val = input[i] ?? 0
          sum += val * val
        }
        const rms = Math.sqrt(sum / input.length)
        audioLevel.value = Math.min(100, Math.round(rms * 350))

        const now = Date.now()
        const isAssistantTalking = options.isAssistantSpeaking?.() ?? false
        // Dynamic threshold based on user-configured mic sensitivity
        const sens = Math.max(1, Math.min(100, settings.micSensitivity ?? 50))
        const baseThreshold = Math.max(0.003, 0.045 - (sens / 100) * 0.042)
        const speechThreshold = isAssistantTalking ? baseThreshold * 2.0 : baseThreshold

        if (rms >= speechThreshold) {
          if (isAssistantTalking) {
            consecutiveBargeInFrames++
            // ~200ms of sustained user voice interrupts the assistant immediately
            if (consecutiveBargeInFrames >= 2) {
              options.onBargeIn?.()
              if (!hasSpoken) {
                hasSpoken = true
                const startSlice = preRollBuffer.slice(Math.max(0, preRollCapacity - preRollCount))
                turnBuffers = [startSlice]
              }
            }
          }
          else {
            consecutiveBargeInFrames = 0
            if (!hasSpoken) {
              hasSpoken = true
              const startSlice = preRollBuffer.slice(Math.max(0, preRollCapacity - preRollCount))
              turnBuffers = [startSlice]
            }
          }

          if (hasSpoken) {
            isSpeaking.value = true
            silenceStart = now
            silenceCountdown.value = 0
            turnBuffers.push(new Float32Array(input))
          }
        }
        else {
          consecutiveBargeInFrames = 0

          if (!hasSpoken) {
            // Keep rolling pre-roll window
            if (input.length >= preRollCapacity) {
              preRollBuffer.set(input.subarray(input.length - preRollCapacity))
              preRollCount = preRollCapacity
            }
            else {
              preRollBuffer.copyWithin(0, input.length, preRollCapacity)
              preRollBuffer.set(input, preRollCapacity - input.length)
              preRollCount = Math.min(preRollCapacity, preRollCount + input.length)
            }
          }
          else {
            // Still in active turn, record natural decaying audio
            turnBuffers.push(new Float32Array(input))

            if (now - silenceStart > 260) {
              isSpeaking.value = false
            }

            const elapsed = (now - silenceStart) / 1000
            const remaining = Math.max(0, Math.ceil(settings.silenceTimeoutSeconds - elapsed))
            silenceCountdown.value = remaining

            if (elapsed >= settings.silenceTimeoutSeconds) {
              // Speech turn completed!
              const turnCopy = turnBuffers
              turnBuffers = []
              hasSpoken = false
              silenceCountdown.value = 0
              isSpeaking.value = false

              let totalSamples = 0
              for (const buf of turnCopy) {
                totalSamples += buf.length
              }

              // Discard very short bursts (< 380ms) like desk bumps or throat clearings
              if (totalSamples >= sampleRate * 0.38) {
                const merged = new Float32Array(totalSamples)
                let offset = 0
                for (const buf of turnCopy) {
                  merged.set(buf, offset)
                  offset += buf.length
                }

                const wav = encodeWav(merged, sampleRate)
                processAudio(wav)
              }
            }
          }
        }
      }

      isListening.value = true
    }
    catch (err) {
      cleanupAudio()
      errorMessage.value = errorMessageFrom(err) ?? 'No se pudo acceder al micrófono'
      options.onError?.(errorMessage.value)
    }
  }

  async function processAudio(wavBuffer: ArrayBuffer) {
    // Only transcribe if audio has at least ~380ms of PCM data
    if (wavBuffer.byteLength < 12000) {
      return
    }

    isTranscribing.value = true

    try {
      const api = getDesktopApi()
      if (api?.transcribeAudio && settings.sttProvider !== 'whisper-api') {
        const text = await api.transcribeAudio(wavBuffer)
        const cleaned = normalizeText(text)
        if (cleaned && !isNoiseOrHallucination(cleaned)) {
          options.onTranscript?.(cleaned, true)
        }
        return
      }

      if (settings.whisperUrl) {
        const blob = new Blob([wavBuffer], { type: 'audio/wav' })
        const formData = new FormData()
        formData.append('file', blob, 'audio.wav')
        formData.append('model', 'whisper-1')
        formData.append('language', 'es')

        const headers: Record<string, string> = {}
        if (settings.whisperApiKey) {
          headers.Authorization = `Bearer ${settings.whisperApiKey}`
        }

        const url = `${settings.whisperUrl.replace(/\/+$/, '')}/audio/transcriptions`
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: formData,
        })

        if (!res.ok) {
          throw new Error(`Whisper API respondió con código ${res.status}`)
        }

        const data = await res.json() as { text?: string }
        const cleaned = normalizeText(data.text || '')
        if (cleaned && !isNoiseOrHallucination(cleaned)) {
          options.onTranscript?.(cleaned, true)
        }
        return
      }

      throw new Error('No hay motor de transcripción configurado.')
    }
    catch (err) {
      errorMessage.value = `Error al transcribir: ${errorMessageFrom(err) ?? String(err)}`
      options.onError?.(errorMessage.value)
    }
    finally {
      isTranscribing.value = false
    }
  }

  function cleanupAudio() {
    isListening.value = false
    isSpeaking.value = false
    silenceCountdown.value = 0
    audioLevel.value = 0

    if (gainNode) {
      gainNode.disconnect()
      gainNode = null
    }

    if (scriptNode) {
      scriptNode.onaudioprocess = null
      scriptNode.disconnect()
      scriptNode = null
    }

    if (silentGain) {
      silentGain.disconnect()
      silentGain = null
    }

    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {})
      audioContext = null
    }

    activeStream?.getTracks().forEach(t => t.stop())
    activeStream = null
  }

  function stop() {
    cleanupAudio()
  }

  function toggle() {
    if (isListening.value) {
      stop()
    }
    else {
      start()
    }
  }

  return {
    isListening,
    isSpeaking,
    isTranscribing,
    errorMessage,
    silenceCountdown,
    audioLevel,
    thresholdLevel,
    start,
    stop,
    toggle,
  }
}
