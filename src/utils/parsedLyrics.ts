export interface LyricLine {
  time: number
  text: string
}

const TIMESTAMP_PATTERN = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g

export function parseLyrics(content: string): LyricLine[] {
  const lines: LyricLine[] = []
  const offsetMatch = content.match(/^\[offset:([+-]?\d+)\]/im)
  const offsetMilliseconds = offsetMatch ? Number(offsetMatch[1]) : 0

  for (const line of content.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(TIMESTAMP_PATTERN)]
    if (timestamps.length === 0) continue

    const text = line.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim()
    if (!text) continue

    for (const timestamp of timestamps) {
      const minutes = Number(timestamp[1])
      const seconds = Number(timestamp[2])
      if (seconds > 59) continue

      const fraction = timestamp[3] ?? ''
      const milliseconds = fraction ? Number(fraction.padEnd(3, '0')) : 0
      const time = Math.max(
        0,
        minutes * 60_000 + seconds * 1_000 + milliseconds + offsetMilliseconds
      )
      lines.push({ time, text })
    }
  }

  return lines
    .map((line, index) => ({ line, index }))
    .sort(
      (left, right) =>
        left.line.time - right.line.time || left.index - right.index
    )
    .map(({ line }) => line)
}

export function decodeLyrics(bytes: ArrayBuffer): string {
  const content = new Uint8Array(bytes)
  let decoded: string
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    decoded = new TextDecoder('utf-16le').decode(content.subarray(2))
  } else if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    decoded = new TextDecoder('utf-16be').decode(content.subarray(2))
  } else {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(content)
  }
  return decoded.replace(/^\uFEFF/, '')
}
