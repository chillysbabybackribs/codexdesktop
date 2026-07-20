import assert from 'node:assert/strict'
import test from 'node:test'
import { compositeBitmap } from './app-window-screenshot.js'

function rgbaBuffer(width: number, height: number, r: number, g: number, b: number, a = 255): Buffer {
  const buffer = Buffer.alloc(width * height * 4)
  for (let offset = 0; offset < buffer.length; offset += 4) {
    buffer[offset] = b
    buffer[offset + 1] = g
    buffer[offset + 2] = r
    buffer[offset + 3] = a
  }
  return buffer
}

test('compositeBitmap overlays browser pixels onto the shell bitmap', () => {
  const base = rgbaBuffer(4, 4, 10, 20, 30)
  const overlay = rgbaBuffer(2, 2, 200, 210, 220)
  compositeBitmap(base, 4, 4, overlay, 2, 2, 1, 1)

  assert.deepEqual([...base.subarray(20, 24)], [220, 210, 200, 255])
  assert.deepEqual([...base.subarray(0, 4)], [30, 20, 10, 255])
})

test('compositeBitmap respects alpha blending', () => {
  const base = rgbaBuffer(1, 1, 0, 0, 0)
  const overlay = rgbaBuffer(1, 1, 255, 255, 255, 128)
  compositeBitmap(base, 1, 1, overlay, 1, 1, 0, 0)
  assert.equal(base[0], 128)
  assert.equal(base[1], 128)
  assert.equal(base[2], 128)
})
