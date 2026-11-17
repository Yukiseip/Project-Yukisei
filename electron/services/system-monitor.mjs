import os from 'node:os'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { app } from 'electron'

const run = promisify(execFile)

let gpuCache = null
let gpuCacheTime = 0
const GPU_CACHE_TTL_MS = 2000

let disksCache = null
let disksCacheTime = 0
const DISKS_CACHE_TTL_MS = 15000

/** Reads the first NVIDIA card with `nvidia-smi` (cached for 2s). */
export async function readGpuInfo() {
  const now = Date.now()
  if (gpuCache && now - gpuCacheTime < GPU_CACHE_TTL_MS) {
    return gpuCache
  }
  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
    )
    const [name, total, free, temp] = stdout.split('\n')[0].split(',').map(part => part.trim())
    gpuCache = {
      name,
      totalMb: Number(total),
      freeMb: Number(free),
      tempC: Number(temp) || 0,
    }
    gpuCacheTime = now
    return gpuCache
  }
  catch {
    return null
  }
}

const cpuInfoList = os.cpus()
const CPU_MODEL = cpuInfoList[0]?.model || 'Procesador x64'
const CPU_CORES = cpuInfoList.length || 1

function getCpuSnapshot() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }
  return { idle, total }
}

let lastCpuLoad = 5
let lastCpuSnapshot = getCpuSnapshot()
let lastCpuSnapshotTime = Date.now()

export async function getInstantCpuLoad() {
  const now = Date.now()
  if (now - lastCpuSnapshotTime < 80) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const current = getCpuSnapshot()
  const idleDiff = current.idle - lastCpuSnapshot.idle
  const totalDiff = current.total - lastCpuSnapshot.total
  lastCpuSnapshot = current
  lastCpuSnapshotTime = Date.now()

  if (totalDiff > 0) {
    lastCpuLoad = Math.max(1, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)))
  }
  return lastCpuLoad
}

export function getRamStats() {
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()
  const usedBytes = totalBytes - freeBytes
  const totalGb = Number((totalBytes / (1024 ** 3)).toFixed(1))
  const usedGb = Number((usedBytes / (1024 ** 3)).toFixed(1))
  const freeGb = Number((freeBytes / (1024 ** 3)).toFixed(1))
  const percentUsed = Math.round((usedBytes / totalBytes) * 100)
  return { totalGb, usedGb, freeGb, percentUsed }
}

export async function readDisks() {
  const now = Date.now()
  if (disksCache && now - disksCacheTime < DISKS_CACHE_TTL_MS) {
    return disksCache
  }
  try {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-Command', '[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | Select-Object Name, TotalFreeSpace, TotalSize | ConvertTo-Json'],
      { timeout: 3000, windowsHide: true },
    )
    const parsed = JSON.parse(stdout)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    disksCache = list.map(d => ({
      name: d.Name,
      totalGb: Math.round(d.TotalSize / (1024 ** 3)),
      freeGb: Math.round(d.TotalFreeSpace / (1024 ** 3)),
    }))
    disksCacheTime = now
    return disksCache
  }
  catch {
    return disksCache || []
  }
}

export function getUserSystemPaths() {
  const desktop = app.getPath('desktop')
  const documents = app.getPath('documents')
  const downloads = app.getPath('downloads')
  const pictures = app.getPath('pictures')
  const music = app.getPath('music')
  const videos = app.getPath('videos')
  const home = app.getPath('home')
  const username = os.userInfo().username
  return { desktop, documents, downloads, pictures, music, videos, home, username }
}

export async function getFullSystemStats() {
  const [gpu, disks, loadPercent] = await Promise.all([readGpuInfo(), readDisks(), getInstantCpuLoad()])
  const cpu = {
    name: CPU_MODEL,
    cores: CPU_CORES,
    loadPercent,
  }
  const ram = getRamStats()
  return {
    cpu,
    ram,
    gpu: gpu || { name: 'GPU Desconocida', totalMb: 0, freeMb: 0, tempC: 0 },
    disks,
  }
}
