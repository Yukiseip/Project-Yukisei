import { useLive2dParams } from '@proj-airi/stage-ui-live2d/stores'
import { computed, ref } from 'vue'

export type AvatarEmotion = 'happy' | 'think' | 'surprised' | 'awkward' | 'sad' | 'neutral'

export interface EmotionMeta {
  name: AvatarEmotion
  label: string
  icon: string
}

export const emotionMetadata: Record<AvatarEmotion, EmotionMeta> = {
  happy: { name: 'happy', label: 'Feliz', icon: '🌸' },
  think: { name: 'think', label: 'Pensativa', icon: '🤔' },
  surprised: { name: 'surprised', label: 'Sorprendida', icon: '✨' },
  awkward: { name: 'awkward', label: 'Apenada', icon: '😳' },
  sad: { name: 'sad', label: 'Triste', icon: '💧' },
  neutral: { name: 'neutral', label: 'Serena', icon: '🍃' },
}

const currentEmotion = ref<AvatarEmotion>('neutral')
let resetTimer: ReturnType<typeof setTimeout> | undefined

export function useAvatarEmotions() {
  const live2dStore = useLive2dParams()

  const activeMeta = computed(() => emotionMetadata[currentEmotion.value])

  function applyModelParameters(emotion: AvatarEmotion) {
    const params = live2dStore.modelParameters

    switch (emotion) {
      case 'happy':
        params.cheek = 0.8
        params.mouthForm = 1.0
        params.leftEyebrowForm = 0.5
        params.rightEyebrowForm = 0.5
        params.angleZ = 4
        live2dStore.currentMotion = { group: 'Tap', index: 0 }
        break

      case 'think':
        params.cheek = 0
        params.mouthForm = 0
        params.leftEyebrowForm = 0.4
        params.rightEyebrowForm = -0.5
        params.angleY = 6
        params.angleX = -5
        live2dStore.currentMotion = { group: 'Flick@Body', index: 0 }
        break

      case 'surprised':
        params.cheek = 0.3
        params.leftEyeOpen = 1.3
        params.rightEyeOpen = 1.3
        params.leftEyebrowY = 0.8
        params.rightEyebrowY = 0.8
        params.mouthForm = 0.4
        params.angleZ = -6
        live2dStore.currentMotion = { group: 'Tap@Body', index: 0 }
        break

      case 'awkward':
        // Roxy-inspired shy/flustered expression with prominent blush
        params.cheek = 1.0
        params.leftEyebrowForm = -0.6
        params.rightEyebrowForm = -0.6
        params.mouthForm = -0.2
        params.angleY = -7
        params.angleZ = 5
        live2dStore.currentMotion = { group: 'FlickDown', index: 0 }
        break

      case 'sad':
        params.cheek = 0
        params.leftEyebrowForm = -0.9
        params.rightEyebrowForm = -0.9
        params.leftEyebrowY = -0.5
        params.rightEyebrowY = -0.5
        params.mouthForm = -0.8
        params.angleY = -5
        live2dStore.currentMotion = { group: 'FlickDown', index: 0 }
        break

      case 'neutral':
      default:
        params.cheek = 0
        params.mouthForm = 0
        params.leftEyeOpen = 1.0
        params.rightEyeOpen = 1.0
        params.leftEyebrowForm = 0
        params.rightEyebrowForm = 0
        params.leftEyebrowY = 0
        params.rightEyebrowY = 0
        params.angleX = 0
        params.angleY = 0
        params.angleZ = 0
        live2dStore.currentMotion = { group: 'Idle', index: 0 }
        break
    }
  }

  function setEmotion(emotion: AvatarEmotion, durationMs = 7000) {
    if (resetTimer) {
      clearTimeout(resetTimer)
      resetTimer = undefined
    }

    currentEmotion.value = emotion
    applyModelParameters(emotion)

    if (emotion !== 'neutral' && durationMs > 0) {
      resetTimer = setTimeout(() => {
        currentEmotion.value = 'neutral'
        applyModelParameters('neutral')
      }, durationMs)
    }
  }

  /**
   * Scans streamed text or user turns for explicit AIRI ACT tags,
   * roleplay asterisks (*sonríe*, *pensativa*) or semantic sentiment cues.
   */
  function detectEmotion(raw: string): AvatarEmotion | null {
    if (!raw)
      return null

    // 1. Explicit AIRI ACT tags: <|ACT {"emotion": "happy"}|>
    const actMatch = raw.match(/<\|ACT\s+(\{[^>]*?\})\|>/i)
    if (actMatch?.[1]) {
      try {
        const payload = JSON.parse(actMatch[1]) as { emotion?: string | { name?: string } }
        const emoName = typeof payload.emotion === 'string'
          ? payload.emotion.toLowerCase()
          : payload.emotion?.name?.toLowerCase()
        if (emoName && emoName in emotionMetadata) {
          return emoName as AvatarEmotion
        }
      }
      catch {}
    }

    const lower = raw.toLowerCase()

    // 2. Roleplay action asterisks and semantic indicators
    if (/\*(?:sonr|r[ií]e|alegr|abraz|asient|feliz)/i.test(lower)
      || /¡excelente!|¡genial!|me alegro|muchas gracias|con gusto|un placer/i.test(lower)) {
      return 'happy'
    }

    if (/\*(?:piens|pensat|analiz|revis|reflex)/i.test(lower)
      || /veamos|déjame revisar|analizando|en mi opinión|si lo piensas/i.test(lower)) {
      return 'think'
    }

    if (/\*(?:sorprend|asombr|abre los ojos)/i.test(lower)
      || /¡vaya!|¿en serio\?|¡increíble!|¡no me digas!|¡wow!/i.test(lower)) {
      return 'surprised'
    }

    if (/\*(?:sonroj|apen|avergonz|tímid|duda|nervios)/i.test(lower)
      || /b-bueno|qué vergüenza|lo siento si dudé|no es para tanto/i.test(lower)) {
      return 'awkward'
    }

    if (/\*(?:suspir|trist|lament|decepcion)/i.test(lower)
      || /qué lástima|lo lamento mucho|es una pena|me entristece/i.test(lower)) {
      return 'sad'
    }

    return null
  }

  return {
    currentEmotion,
    activeMeta,
    setEmotion,
    detectEmotion,
  }
}
