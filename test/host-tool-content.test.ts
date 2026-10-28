import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeHostToolContent } from '../src/host/host-tool-content.ts'

// A text-only bridge silently drops read_image pixels; resolve only the host
// tool's returned durable reference and refuse unavailable/aborted reads.
test('host image results preserve pixels and cannot silently degrade into text', { timeout: 2000 }, async () => {
  const signal = new AbortController().signal
  const ref = { attachmentId: 'authorized-image', mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
  const result = { content: [{ type: 'text', text: 'image envelope' }, { type: 'image', attachment: ref }] }
  const encoded = await encodeHostToolContent(result, signal, async (actual, actualSignal) => {
    assert.equal(actual, ref); assert.equal(actualSignal, signal)
    return { data: new Uint8Array([1, 2, 3]) }
  }) as { content: unknown[] }
  assert.deepEqual(encoded.content, [{ type: 'text', text: 'image envelope' }, { type: 'image', mimeType: 'image/png', data: 'AQID' }])
  const ptc = await encodeHostToolContent({ isError: false, value: { result: { path: '/fixture.png', image: ref } }, content: [{ type: 'text', text: 'structured image metadata' }] }, signal,
    async actual => { assert.equal(actual, ref); return { data: new Uint8Array([1, 2, 3]) } }, 'read_image') as { content: unknown[] }
  assert.deepEqual(ptc.content[1], { type: 'image', mimeType: 'image/png', data: 'AQID' })
  await assert.rejects(() => encodeHostToolContent(result, signal, async () => null), /could not be read/)
  await assert.rejects(() => encodeHostToolContent(result, AbortSignal.abort(), async () => ({ data: new Uint8Array([1]) })))
})
