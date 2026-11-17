export interface ModelCapabilities {
  vision: boolean
  reasoning: boolean
  vramWeightGb: number
  totalRequiredGb: number
  fitsInVram: 'full' | 'partial' | 'overflow'
  summaryText: string
}

/** Tells if the model supports multimodal vision (analyzing screen & images) */
export function modelSupportsVision(
  modelName: string,
  families?: string[],
  family?: string,
): boolean {
  const n = modelName.toLowerCase()
  const fams = (families ?? []).map(f => f.toLowerCase())
  const fam = (family ?? '').toLowerCase()

  return (
    n.includes('gemma4')
    || n.includes('vision')
    || n.includes('llava')
    || n.includes('minicpm-v')
    || n.includes('vl')
    || n.includes('moondream')
    || n.includes('bakllava')
    || fams.includes('clip')
    || fams.includes('mllama')
    || fam === 'clip'
  )
}

/** Tells if the model outputs explicit reasoning / thinking tags */
export function modelSupportsReasoning(modelName: string): boolean {
  const n = modelName.toLowerCase()
  return (
    n.includes('r1')
    || n.includes('qwq')
    || n.includes('gemma4')
    || n.includes('reasoning')
    || n.includes('thought')
  )
}

/**
 * Calculates real VRAM requirements based on model file weight and KV context memory,
 * contrasted with real GPU memory from NVIDIA SMI.
 */
export function inspectModelCapabilities(
  modelName: string,
  modelSizeBytes: number,
  contextBytes: number,
  gpuTotalMb: number,
  gpuFreeMb: number,
  families?: string[],
  family?: string,
): ModelCapabilities {
  const bytesPerGb = 1024 * 1024 * 1024
  const vramWeightGb = modelSizeBytes / bytesPerGb
  const contextGb = contextBytes / bytesPerGb
  const systemBuffersGb = 0.8
  const totalRequiredGb = vramWeightGb + contextGb + systemBuffersGb

  const totalGpuGb = gpuTotalMb > 0 ? gpuTotalMb / 1024 : 16
  const freeGpuGb = gpuFreeMb > 0 ? gpuFreeMb / 1024 : Math.max(1, totalGpuGb - 4)

  const vision = modelSupportsVision(modelName, families, family)
  const reasoning = modelSupportsReasoning(modelName)

  let fitsInVram: 'full' | 'partial' | 'overflow' = 'full'
  let summaryText = ''

  if (totalRequiredGb <= freeGpuGb) {
    fitsInVram = 'full'
    const remaining = Math.max(0, freeGpuGb - totalRequiredGb)
    summaryText = `Excelente: Cabe 100% en la VRAM libre de tu tarjeta gráfica. Quedarán ~${remaining.toFixed(1)} GB libres para tus juegos y sistema.`
  }
  else if (totalRequiredGb <= totalGpuGb) {
    fitsInVram = 'partial'
    summaryText = `Ajustado: Ocupará casi toda la VRAM de tu GPU (${totalRequiredGb.toFixed(1)} GB de ${totalGpuGb.toFixed(1)} GB).`
  }
  else {
    fitsInVram = 'overflow'
    summaryText = `Atención: Supera la memoria de tu GPU (${totalRequiredGb.toFixed(1)} GB necesarios vs ${totalGpuGb.toFixed(1)} GB disponibles). Ollama descargará capas a la memoria RAM compartida (más lenta).`
  }

  return {
    vision,
    reasoning,
    vramWeightGb,
    totalRequiredGb,
    fitsInVram,
    summaryText,
  }
}
