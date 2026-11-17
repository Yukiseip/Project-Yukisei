/**
 * Rough token count for Spanish text. Spanish needs about 1 token per 3.2 characters.
 * The real count depends on the model, so keep a margin.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2)
}

/** What the model needs in video memory for each token of context. */
export interface KvLayout {
  /** Bytes per token for the layers that look at the whole context. */
  fullBytesPerToken: number
  /** Bytes per token for the layers that look at a short window only. */
  windowBytesPerToken: number
  /** Tokens that a window layer remembers. `0` when the model has no window layers. */
  window: number
  /** Largest context that the model supports. */
  maxContext: number
}

/** Extra tokens that Ollama keeps in the window layers for the batch it is processing. */
const windowBatchTokens = 512

/** Margin over the estimate. Real use is a little higher than the sum of the cache. */
const kvSafetyFactor = 1.15

export const bytesPerGb = 1024 ** 3

/** Video memory in bytes that the KV cache uses for a context size. */
export function kvBytes(layout: KvLayout, context: number): number {
  const windowTokens = layout.window > 0 ? Math.min(context, layout.window + windowBatchTokens) : context
  return (layout.fullBytesPerToken * context + layout.windowBytesPerToken * windowTokens) * kvSafetyFactor
}

/**
 * Largest context that fits a memory budget.
 * Rounds down to a multiple of 1024 and keeps the result between 2048 and the limit.
 */
export function contextForBudget(layout: KvLayout, budgetBytes: number, limit: number): number {
  const top = Math.min(layout.maxContext, limit)
  if (kvBytes(layout, 2048) > budgetBytes)
    return 2048

  // The cost only grows with the context, so a binary search finds the largest context that fits.
  let low = 2048
  let high = top
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (kvBytes(layout, middle) <= budgetBytes)
      low = middle
    else
      high = middle - 1
  }

  return Math.max(2048, Math.floor(low / 1024) * 1024)
}

/**
 * Keeps the newest messages that fit in the context window.
 * Space for the system prompt and for the answer stays free.
 */
export function trimHistory<T extends { content: string }>(messages: T[], options: {
  numCtx: number
  systemTokens: number
  answerReserve: number
  maxMessages: number
}): T[] {
  let remaining = options.numCtx - options.systemTokens - options.answerReserve
  const kept: T[] = []

  for (let index = messages.length - 1; index >= 0 && kept.length < options.maxMessages; index--) {
    const message = messages[index]!
    const cost = estimateTokens(message.content) + 4
    // The newest message always goes in, even when it is long.
    if (cost > remaining && kept.length > 0)
      break
    remaining -= cost
    kept.unshift(message)
  }

  return kept
}
