import type { ImageRefLike } from './media.ts'

/** Resolve only images returned by the authorized host tool, never model paths. */
export async function encodeHostToolContent(result: unknown, signal: AbortSignal,
  readImage: (ref: ImageRefLike, signal: AbortSignal) => Promise<{ data?: Uint8Array } | null>, toolName?: string) {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return result
  let blocks: unknown[] = result.content
  // Official PTC returns the tool's structured value in value.result and
  // defers image blocks to DSH's next context. The still-running agy process
  // also needs those pixels in its immediate MCP response.
  if (toolName === 'read_image' && !('isError' in result && result.isError) && !blocks.some(b => b && typeof b === 'object' && 'type' in b && b.type === 'image')) {
    const value = 'value' in result ? result.value as { result?: unknown; logs?: unknown[] } | undefined : undefined
    let imageValue = value?.result
    if (!imageValue && Array.isArray(value?.logs)) {
      for (const log of value.logs) { try { imageValue = JSON.parse(String(log)) } catch { /* not our serialized result */ } }
    }
    const ref = imageValue && typeof imageValue === 'object' && 'image' in imageValue ? imageValue.image : undefined
    if (!ref || typeof ref !== 'object' || !('attachmentId' in ref)) throw new Error('Host image tool returned no readable image attachment')
    blocks = [...blocks, { type: 'image', attachment: ref }]
  }
  const content = await Promise.all(blocks.map(async (block: unknown) => {
    if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'image') return block
    if (!('attachment' in block) || !block.attachment || typeof block.attachment !== 'object') throw new Error('Host image result has no attachment reference')
    const ref = block.attachment as ImageRefLike
    signal.throwIfAborted()
    const stored = await readImage(ref, signal)
    signal.throwIfAborted()
    if (!stored?.data) throw new Error('Host image result could not be read from attachment storage')
    return { type: 'image', mimeType: ref.mediaType, data: Buffer.from(stored.data).toString('base64') }
  }))
  return { ...result, content }
}
