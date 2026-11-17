import fs from 'node:fs'
import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { app } from 'electron'

let whisperProcess = null
let whisperReady = false
const whisperWaiters = new Map()
const whisperReadyResolvers = new Set()

let ttsProcess = null
let ttsReady = false
const ttsWaiters = new Map()
const ttsReadyResolvers = new Set()

function flushResolvers(set) {
  for (const resolve of set) {
    resolve()
  }
  set.clear()
}

export function getWorkersStatus() {
  return {
    whisperReady,
    whisperRunning: Boolean(whisperProcess),
    ttsReady,
    ttsRunning: Boolean(ttsProcess),
  }
}

export function startWhisperWorker() {
  if (whisperProcess)
    return

  const script = join(import.meta.dirname, '..', '..', 'scripts', 'whisper_worker.py')
  whisperProcess = spawn(
    'uv',
    ['run', '--with', 'faster-whisper', '--with', 'av<14', '--with', 'pip-system-certs', 'python', '-u', script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
        PYTHONUNBUFFERED: '1',
        PYTHONHTTPSVERIFY: '0',
      },
    },
  )

  let buffer = ''
  whisperProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed)
        continue
      if (trimmed === 'READY') {
        whisperReady = true
        flushResolvers(whisperReadyResolvers)
      }
      else {
        try {
          const result = JSON.parse(trimmed)
          const reqId = result.id
          if (reqId && whisperWaiters.has(reqId)) {
            const waiter = whisperWaiters.get(reqId)
            whisperWaiters.delete(reqId)
            waiter.resolve(result)
          }
        }
        catch (e) {
          console.error('[whisper] parse error', e)
        }
      }
    }
  })

  whisperProcess.stderr?.on('data', (chunk) => {
    const msg = chunk.toString('utf8').trim()
    if (msg)
      console.warn('[whisper-worker]', msg)
  })

  whisperProcess.on('error', (err) => {
    console.warn('[whisper-worker] process error:', err)
  })

  whisperProcess.on('close', () => {
    whisperProcess = null
    whisperReady = false
    flushResolvers(whisperReadyResolvers)
    for (const waiter of whisperWaiters.values()) {
      waiter.reject(new Error('Whisper cerrado'))
    }
    whisperWaiters.clear()
  })
}

function waitForWhisperReady(timeoutMs = 20000) {
  if (whisperReady)
    return Promise.resolve()
  if (!whisperProcess)
    startWhisperWorker()
  if (!whisperProcess)
    return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      whisperReadyResolvers.delete(done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    whisperReadyResolvers.add(done)
  })
}

export async function transcribeAudioBuffer(audioBuffer) {
  await waitForWhisperReady()

  const buf = Buffer.from(audioBuffer)
  const isWav = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'RIFF'
  const ext = isWav ? 'wav' : 'webm'
  const reqId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const tempPath = join(app.getPath('temp'), `yukisei-audio-${reqId}.${ext}`)
  await fs.promises.writeFile(tempPath, buf)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (whisperWaiters.has(reqId)) {
        whisperWaiters.delete(reqId)
        fs.promises.unlink(tempPath).catch(() => {})
        reject(new Error('Tiempo de espera agotado al transcribir el audio (15s)'))
      }
    }, 15000)

    whisperWaiters.set(reqId, {
      resolve: (res) => {
        clearTimeout(timer)
        fs.promises.unlink(tempPath).catch(() => {})
        if (res.error)
          reject(new Error(res.error))
        else
          resolve(res.text || '')
      },
      reject: (err) => {
        clearTimeout(timer)
        fs.promises.unlink(tempPath).catch(() => {})
        reject(err)
      },
    })

    if (!whisperProcess) {
      clearTimeout(timer)
      whisperWaiters.delete(reqId)
      fs.promises.unlink(tempPath).catch(() => {})
      reject(new Error('Whisper worker no está activo'))
      return
    }

    whisperProcess.stdin.write(`${JSON.stringify({ id: reqId, audio_path: tempPath })}\n`)
  })
}

export function startTtsWorker() {
  if (ttsProcess)
    return

  const script = join(import.meta.dirname, '..', '..', 'scripts', 'tts_worker.py')
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'

  const ttsEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }

  try {
    ttsProcess = spawn(pythonCmd, ['-u', script], {
      windowsHide: true,
      env: ttsEnv,
    })
  }
  catch {
    ttsProcess = spawn('uv', ['run', 'python', '-u', script], {
      windowsHide: true,
      env: ttsEnv,
    })
  }

  let buffer = ''
  ttsProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed)
        continue
      if (trimmed === 'READY') {
        ttsReady = true
        flushResolvers(ttsReadyResolvers)
      }
      else {
        try {
          const result = JSON.parse(trimmed)
          if (result.id && ttsWaiters.has(result.id)) {
            const waiter = ttsWaiters.get(result.id)
            ttsWaiters.delete(result.id)
            waiter.resolve(result)
          }
        }
        catch (e) {
          console.error('[tts] parse error', e)
        }
      }
    }
  })

  ttsProcess.stderr?.on('data', (chunk) => {
    const msg = chunk.toString('utf8').trim()
    if (msg)
      console.warn('[tts-worker]', msg)
  })

  ttsProcess.on('error', (err) => {
    console.warn('[tts-worker] process error:', err)
  })

  ttsProcess.on('close', () => {
    ttsProcess = null
    ttsReady = false
    flushResolvers(ttsReadyResolvers)
    for (const waiter of ttsWaiters.values()) {
      waiter.reject(new Error('TTS worker cerrado'))
    }
    ttsWaiters.clear()
  })
}

function waitForTtsReady(timeoutMs = 12000) {
  if (ttsReady)
    return Promise.resolve()
  if (!ttsProcess)
    startTtsWorker()
  if (!ttsProcess)
    return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      ttsReadyResolvers.delete(done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    ttsReadyResolvers.add(done)
  })
}

export async function synthesizeNeuralSpeech({ text, voice, pitch, rate }) {
  await waitForTtsReady()

  const reqId = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (ttsWaiters.has(reqId)) {
        ttsWaiters.delete(reqId)
        reject(new Error('Tiempo de espera agotado al sintetizar voz'))
      }
    }, 30000)

    ttsWaiters.set(reqId, {
      resolve: (res) => {
        clearTimeout(timer)
        if (res.error)
          reject(new Error(res.error))
        else
          resolve(res.audio || '')
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      },
    })

    if (!ttsProcess) {
      clearTimeout(timer)
      ttsWaiters.delete(reqId)
      reject(new Error('TTS worker no disponible'))
      return
    }

    ttsProcess.stdin.write(`${JSON.stringify({ id: reqId, text, voice, pitch, rate })}\n`)
  })
}

export function stopAllWorkers() {
  if (whisperProcess) {
    try {
      whisperProcess.stdin.write('QUIT\n')
      whisperProcess.kill()
    }
    catch {}
    whisperProcess = null
    whisperReady = false
    flushResolvers(whisperReadyResolvers)
  }
  if (ttsProcess) {
    try {
      ttsProcess.stdin.write('QUIT\n')
      ttsProcess.kill()
    }
    catch {}
    ttsProcess = null
    ttsReady = false
    flushResolvers(ttsReadyResolvers)
  }
}
