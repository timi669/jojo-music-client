import { describe, it, expect } from 'vitest'
import { parseLyrics, decodeLyrics } from '../src/utils/parsedLyrics'

/** 把字符串转成 ArrayBuffer，便于测试 decodeLyrics */
const toBuffer = (bytes: number[]): ArrayBuffer =>
  new Uint8Array(bytes).buffer

describe('parseLyrics', () => {
  it('解析标准的 LRC 时间戳行', () => {
    const lrc = ['[00:01.00]第一行', '[00:02.50]第二行'].join('\n')
    expect(parseLyrics(lrc)).toEqual([
      { time: 1000, text: '第一行' },
      { time: 2500, text: '第二行' },
    ])
  })

  it('支持一行多个时间戳，展开为多行', () => {
    const lrc = '[00:01.00][00:10.00]副歌'
    expect(parseLyrics(lrc)).toEqual([
      { time: 1000, text: '副歌' },
      { time: 10000, text: '副歌' },
    ])
  })

  it('支持 [offset:±ms] 全局偏移', () => {
    const lrc = ['[offset:500]', '[00:02.00]延迟五百毫秒'].join('\n')
    expect(parseLyrics(lrc)).toEqual([{ time: 2500, text: '延迟五百毫秒' }])

    const negative = ['[offset:-500]', '[00:02.00]提前五百毫秒'].join('\n')
    expect(parseLyrics(negative)).toEqual([{ time: 1500, text: '提前五百毫秒' }])
  })

  it('偏移把时间推到负数时下限截断为 0', () => {
    const lrc = ['[offset:-99999]', '[00:01.00]应被截断'].join('\n')
    expect(parseLyrics(lrc)).toEqual([{ time: 0, text: '应被截断' }])
  })

  it('分数秒按毫秒对齐（.5 -> 500ms，.05 -> 50ms）', () => {
    expect(parseLyrics('[00:01.5]半秒')).toEqual([{ time: 1500, text: '半秒' }])
    expect(parseLyrics('[00:01.05]五十毫秒')).toEqual([
      { time: 1050, text: '五十毫秒' },
    ])
    // 冒号也能作为毫秒分隔符
    expect(parseLyrics('[00:01:250]冒号毫秒')).toEqual([
      { time: 1250, text: '冒号毫秒' },
    ])
  })

  it('跳过秒数大于 59 的脏数据', () => {
    const lrc = ['[00:60.00]非法秒', '[00:10.00]合法行'].join('\n')
    expect(parseLyrics(lrc)).toEqual([{ time: 10000, text: '合法行' }])
  })

  it('忽略无时间戳的行与只有时间戳没有文字的行', () => {
    const lrc = [
      '[ar:某歌手]',
      '',
      '[00:05.00]',
      '[00:06.00]有文字',
    ].join('\n')
    expect(parseLyrics(lrc)).toEqual([{ time: 6000, text: '有文字' }])
  })

  it('按时间升序排序，乱序输入也能正确排列', () => {
    const lrc = ['[00:30.00]第三', '[00:10.00]第一', '[00:20.00]第二'].join('\n')
    expect(parseLyrics(lrc).map(l => l.text)).toEqual(['第一', '第二', '第三'])
  })

  it('兼容 CRLF 换行', () => {
    const lrc = '[00:01.00]甲\r\n[00:02.00]乙'
    expect(parseLyrics(lrc)).toEqual([
      { time: 1000, text: '甲' },
      { time: 2000, text: '乙' },
    ])
  })

  it('空内容返回空数组', () => {
    expect(parseLyrics('')).toEqual([])
  })
})

describe('decodeLyrics', () => {
  it('解码普通 UTF-8 内容', () => {
    const bytes = Array.from(new TextEncoder().encode('[00:01.00]你好'))
    expect(decodeLyrics(toBuffer(bytes))).toBe('[00:01.00]你好')
  })

  it('解码带 BOM 的 UTF-8 并去掉 BOM', () => {
    const body = Array.from(new TextEncoder().encode('歌词内容'))
    const bytes = [0xef, 0xbb, 0xbf, ...body]
    expect(decodeLyrics(toBuffer(bytes))).toBe('歌词内容')
  })

  it('解码 UTF-16LE（FF FE BOM）', () => {
    const text = '中文歌词'
    const bytes = [0xff, 0xfe]
    for (const ch of text) {
      const code = ch.charCodeAt(0)
      bytes.push(code & 0xff, (code >> 8) & 0xff)
    }
    expect(decodeLyrics(toBuffer(bytes))).toBe(text)
  })

  it('解码 UTF-16BE（FE FF BOM）', () => {
    const text = '中文'
    const bytes = [0xfe, 0xff]
    for (const ch of text) {
      const code = ch.charCodeAt(0)
      bytes.push((code >> 8) & 0xff, code & 0xff)
    }
    expect(decodeLyrics(toBuffer(bytes))).toBe(text)
  })

  it('非法 UTF-8 会抛错（fatal 模式，不做静默替换）', () => {
    // 0xff 不是合法的 UTF-8 起始字节
    expect(() => decodeLyrics(toBuffer([0xff, 0x00, 0x41]))).toThrow()
  })
})
