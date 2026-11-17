import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type MemoryCategory = 'usuario' | 'preferencia' | 'proyecto' | 'nota'

export interface MemoryItem {
  id: string
  fact: string
  category: MemoryCategory
  createdAt: string
}

const storageKey = 'yukisei:memories:v1'

function loadMemories(): MemoryItem[] {
  try {
    const raw = localStorage.getItem(storageKey) || localStorage.getItem('airi-mini:memories:v1')
    if (!raw)
      return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

export const useMemoryStore = defineStore('yukisei-memory', () => {
  const items = ref<MemoryItem[]>(loadMemories())

  watch(
    items,
    (list) => {
      localStorage.setItem(storageKey, JSON.stringify(list))
    },
    { deep: true },
  )

  function addMemory(fact: string, category: MemoryCategory = 'nota'): MemoryItem | null {
    const clean = fact.trim().replace(/\s+/g, ' ')
    if (!clean || clean.length < 3)
      return null

    const lower = clean.toLowerCase()
    const duplicate = items.value.find(item => item.fact.toLowerCase() === lower)
    if (duplicate)
      return duplicate

    const entry: MemoryItem = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fact: clean.slice(0, 260),
      category,
      createdAt: new Date().toISOString(),
    }
    items.value.unshift(entry)
    if (items.value.length > 60) {
      items.value = items.value.slice(0, 60)
    }
    return entry
  }

  function removeMemory(id: string) {
    items.value = items.value.filter(item => item.id !== id)
  }

  function clearMemories() {
    items.value = []
    localStorage.removeItem(storageKey)
  }

  /**
   * Extracts `<|MEMORY {"fact": "...", "category": "..."}|>` tags emitted by the assistant
   * and returns the cleaned text and any newly saved memories.
   */
  function extractAndSaveFromText(text: string, autoSave = true): { cleanText: string, saved: MemoryItem[] } {
    if (!text)
      return { cleanText: '', saved: [] }

    const saved: MemoryItem[] = []
    const regex = /<\|MEMORY\s+(\{[\s\S]*?\})\s*\|>/gi
    let match: RegExpExecArray | null

    while (true) {
      match = regex.exec(text)
      if (!match)
        break
      if (autoSave) {
        try {
          const parsed = JSON.parse(match[1])
          const fact = typeof parsed.fact === 'string' ? parsed.fact : (typeof parsed.text === 'string' ? parsed.text : '')
          const rawCat = String(parsed.category || 'nota').toLowerCase()
          const validCats: MemoryCategory[] = ['usuario', 'preferencia', 'proyecto', 'nota']
          const category: MemoryCategory = validCats.includes(rawCat as MemoryCategory)
            ? (rawCat as MemoryCategory)
            : 'nota'
          const item = addMemory(fact, category)
          if (item)
            saved.push(item)
        }
        catch {}
      }
    }

    const cleanText = text.replace(regex, '').trim()
    return { cleanText, saved }
  }

  /** Builds the persistent memory block injected into the system prompt. */
  function buildMemorySystemBlock(): string {
    const memoryInstructions = `
[MEMORIA A LARGO PLAZO DE YUKISEI]
Cuando el usuario te comparta un dato personal importante (su nombre, profesión, gustos, proyectos actuales, lenguaje favorito o preferencias), puedes guardarlo en tu memoria permanente incluyendo al final de tu respuesta una etiqueta con este formato exacto:
<|MEMORY {"fact": "El usuario se llama Carlos y programa en TypeScript", "category": "usuario"}|>
Categorías válidas: "usuario", "preferencia", "proyecto", "nota".
(El sistema ocultará automáticamente esta etiqueta. Úsala solo cuando descubras un dato nuevo y relevante que valga la pena recordar en futuras sesiones).`

    if (items.value.length === 0)
      return memoryInstructions

    const lines = items.value
      .slice(0, 30)
      .map(item => `- [${item.category.toUpperCase()}] ${item.fact}`)
      .join('\n')

    return `${memoryInstructions}\n\nRecuerdos permanentes que ya conoces sobre tu usuario:\n${lines}`
  }

  return {
    items,
    addMemory,
    removeMemory,
    clearMemories,
    extractAndSaveFromText,
    buildMemorySystemBlock,
  }
})
