const DB_NAME = 'yukisei-models-db'
const LEGACY_DB_NAME = 'airi-mini-models-db'
const STORE_NAME = 'models'
const MODEL_KEY = 'active-custom-model'

function openNamedDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function openDb(): Promise<IDBDatabase> {
  return openNamedDb(DB_NAME)
}

export async function clearOpfsCache(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && 'getDirectory' in navigator.storage) {
      const root = await navigator.storage.getDirectory()
      const entries: string[] = []
      // Collect entries safely
      for await (const name of (root as any).keys()) {
        entries.push(name)
      }
      for (const name of entries) {
        try {
          await (root as any).removeEntry(name, { recursive: true })
        }
        catch {}
      }
    }
  }
  catch (e) {
    console.warn('[custom-model-storage] Could not clear OPFS cache:', e)
  }
}

export async function saveCustomModelZip(blob: Blob): Promise<void> {
  await clearOpfsCache()
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.put(blob, MODEL_KEY)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function loadCustomModelZip(): Promise<Blob | null> {
  try {
    const db = await openDb()
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(MODEL_KEY)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
    if (blob)
      return blob

    // Fallback: check legacy indexedDB from airi-mini
    try {
      const legacyDb = await openNamedDb(LEGACY_DB_NAME)
      const legacyBlob = await new Promise<Blob | null>((resolve, reject) => {
        const tx = legacyDb.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const request = store.get(MODEL_KEY)
        request.onsuccess = () => resolve(request.result || null)
        request.onerror = () => reject(request.error)
      })
      if (legacyBlob) {
        // Automatically migrate to new DB
        await saveCustomModelZip(legacyBlob)
        return legacyBlob
      }
    }
    catch {}

    return null
  }
  catch {
    return null
  }
}

export async function deleteCustomModelZip(): Promise<void> {
  try {
    await clearOpfsCache()
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.delete(MODEL_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }
  catch {
    // Ignore cleanup errors
  }
}
