import { onUnmounted, ref } from 'vue'

export interface AudioDeviceOption {
  deviceId: string
  label: string
}

interface AudioContextWithSink extends AudioContext {
  setSinkId?: (id: string) => Promise<void>
}

export function useAudioDevices() {
  const audioInputs = ref<AudioDeviceOption[]>([])
  const audioOutputs = ref<AudioDeviceOption[]>([])
  const micMeterLevel = ref(0)
  const isTestingMic = ref(false)

  let meterStream: MediaStream | null = null
  let meterContext: AudioContext | null = null
  let meterScriptNode: ScriptProcessorNode | null = null
  let meterSilentGain: GainNode | null = null

  async function loadDevices() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices)
      return

    try {
      // First ensure permission so device labels are not empty strings
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        tempStream.getTracks().forEach(t => t.stop())
      }
      catch {}

      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs: AudioDeviceOption[] = []
      const outputs: AudioDeviceOption[] = []

      let inputIdx = 1
      let outputIdx = 1

      for (const dev of devices) {
        if (dev.kind === 'audioinput') {
          inputs.push({
            deviceId: dev.deviceId,
            label: dev.label || `Micrófono ${inputIdx++}`,
          })
        }
        else if (dev.kind === 'audiooutput') {
          outputs.push({
            deviceId: dev.deviceId,
            label: dev.label || `Altavoz / Auriculares ${outputIdx++}`,
          })
        }
      }

      audioInputs.value = inputs
      audioOutputs.value = outputs
    }
    catch (err) {
      console.warn('[audio-devices] Could not enumerate devices:', err)
    }
  }

  async function startMicMeter(deviceId?: string, gainValue = 1.0) {
    stopMicMeter()
    isTestingMic.value = true

    try {
      const constraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
      if (deviceId) {
        constraints.deviceId = { exact: deviceId }
      }

      meterStream = await navigator.mediaDevices.getUserMedia({ audio: constraints })

      const AudioCtx = window.AudioContext ?? Reflect.get(window, 'webkitAudioContext') as typeof AudioContext | undefined
      if (!AudioCtx)
        return

      meterContext = new AudioCtx()
      if (meterContext.state === 'suspended') {
        await meterContext.resume()
      }

      const source = meterContext.createMediaStreamSource(meterStream)
      const gainNode = meterContext.createGain()
      gainNode.gain.value = Math.max(0.2, Math.min(3.0, gainValue))

      meterScriptNode = meterContext.createScriptProcessor(2048, 1, 1)
      meterSilentGain = meterContext.createGain()
      meterSilentGain.gain.value = 0

      source.connect(gainNode)
      gainNode.connect(meterScriptNode)
      meterScriptNode.connect(meterSilentGain)
      meterSilentGain.connect(meterContext.destination)

      meterScriptNode.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        let sum = 0
        for (let i = 0; i < input.length; i++) {
          const val = input[i] ?? 0
          sum += val * val
        }
        const rms = Math.sqrt(sum / input.length)
        micMeterLevel.value = Math.min(100, Math.round(rms * 450))
      }
    }
    catch (err) {
      console.warn('[audio-devices] Could not start mic meter:', err)
      stopMicMeter()
    }
  }

  function stopMicMeter() {
    isTestingMic.value = false
    micMeterLevel.value = 0

    if (meterStream) {
      meterStream.getTracks().forEach(t => t.stop())
      meterStream = null
    }
    if (meterScriptNode) {
      meterScriptNode.onaudioprocess = null
      meterScriptNode.disconnect()
      meterScriptNode = null
    }
    if (meterSilentGain) {
      meterSilentGain.disconnect()
      meterSilentGain = null
    }
    if (meterContext && meterContext.state !== 'closed') {
      void meterContext.close()
      meterContext = null
    }
  }

  async function testAudioOutput(deviceId?: string) {
    // Play a friendly gentle 3-tone notification chime to test speakers / headphones
    try {
      const AudioCtx = window.AudioContext ?? Reflect.get(window, 'webkitAudioContext') as typeof AudioContext | undefined
      if (!AudioCtx)
        return

      const ctx = new AudioCtx()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }

      const sinkCtx = ctx as AudioContextWithSink
      if (deviceId && typeof sinkCtx.setSinkId === 'function') {
        await sinkCtx.setSinkId(deviceId)
      }

      const notes = [523.25, 659.25, 783.99] // C5, E5, G5 major triad
      let time = ctx.currentTime

      for (const freq of notes) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()

        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, time)

        gain.gain.setValueAtTime(0.001, time)
        gain.gain.exponentialRampToValueAtTime(0.2, time + 0.04)
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.22)

        osc.connect(gain)
        gain.connect(ctx.destination)

        osc.start(time)
        osc.stop(time + 0.25)

        time += 0.12
      }

      setTimeout(() => {
        void ctx.close()
      }, 1000)
    }
    catch (err) {
      console.warn('[audio-devices] Could not test audio output:', err)
    }
  }

  onUnmounted(() => {
    stopMicMeter()
  })

  return {
    audioInputs,
    audioOutputs,
    micMeterLevel,
    isTestingMic,
    loadDevices,
    startMicMeter,
    stopMicMeter,
    testAudioOutput,
  }
}
