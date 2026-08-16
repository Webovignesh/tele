'use strict'

/* Minimal PNG reader for pixel assertions.
 *
 * Element screenshots are the only way to verify what a native form control
 * actually paints: the concurrency slider's fill lives on
 * ::-webkit-slider-runnable-track, and Chromium serialises that background with
 * its calc() unresolved, so computed style cannot tell you where the boundary
 * landed. Supports the 8-bit RGB/RGBA non-interlaced output Playwright produces.
 */

const zlib = require('node:zlib')

function decodePng (buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  let interlace = 0
  const chunks = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      chunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels || bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG: colorType=${colorType} bitDepth=${bitDepth} interlace=${interlace}`)
  }

  const raw = zlib.inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let pos = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? cur[x - channels] : 0
      const up = prev ? prev[x] : 0
      const upLeft = prev && x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      cur[x] = value & 0xff
    }
  }

  return {
    width,
    height,
    pixel (x, y) {
      const index = y * stride + x * channels
      return [pixels[index], pixels[index + 1], pixels[index + 2]]
    }
  }
}

function isNear (pixel, target, tolerance = 46) {
  return Math.abs(pixel[0] - target[0]) <= tolerance &&
    Math.abs(pixel[1] - target[1]) <= tolerance &&
    Math.abs(pixel[2] - target[2]) <= tolerance
}

/* Rightmost x on the given row matching the colour, or -1. */
function rightmostMatch (png, row, target, tolerance) {
  let found = -1
  for (let x = 0; x < png.width; x++) {
    if (isNear(png.pixel(x, row), target, tolerance)) found = x
  }
  return found
}

// --fg-accent
const ACCENT = [77, 163, 255]

module.exports = { decodePng, isNear, rightmostMatch, ACCENT }
