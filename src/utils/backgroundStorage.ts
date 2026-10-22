/**
 * 背景图片的本地持久化（IndexedDB）。
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 * - localStorage 上限约 5MB 且只能存字符串，一张 4K 壁纸转 dataURL 就超了；
 * - IndexedDB 可直接存 Blob，容量按浏览器配额（通常数百 MB ~ 数 GB）。
 *
 * 存储结构：
 * - `images`  存 { id, meta, blob }，blob 为渲染用的降采样图
 * - 配置本身不在这里，放在 Pinia + persist（体积小、需响应式）
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { BackgroundImageMeta } from '@/utils/background'

const DB_NAME = 'jojo-music-background'
const DB_VERSION = 1
const STORE = 'images'

interface BackgroundDB extends DBSchema {
  images: {
    key: string
    value: {
      id: string
      meta: BackgroundImageMeta
      /** 渲染用的降采样图（WebP/JPEG Blob） */
      blob: Blob
      /** 原始文件（用于"重新裁剪/换尺寸"时不丢失细节） */
      original?: Blob
    }
    indexes: { 'by-createdAt': number }
  }
}

let dbPromise: Promise<IDBPDatabase<BackgroundDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<BackgroundDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' })
          store.createIndex('by-createdAt', 'meta.createdAt')
        }
      }
    })
  }
  return dbPromise
}

/** 浏览器是否支持 IndexedDB */
export function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/** 新增/更新一张背景图 */
export async function putBackgroundImage(entry: {
  meta: BackgroundImageMeta
  blob: Blob
  original?: Blob
}): Promise<void> {
  const db = await getDB()
  await db.put(STORE, {
    id: entry.meta.id,
    meta: entry.meta,
    blob: entry.blob,
    original: entry.original
  })
}

/** 按 id 获取一张背景图 */
export async function getBackgroundImage(id: string) {
  const db = await getDB()
  return db.get(STORE, id)
}

/** 列出全部背景图元信息（按导入时间倒序） */
export async function listBackgroundImages(): Promise<BackgroundImageMeta[]> {
  const db = await getDB()
  const all = await db.getAll(STORE)
  return all
    .map(item => item.meta)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** 删除一张背景图 */
export async function deleteBackgroundImage(id: string): Promise<void> {
  const db = await getDB()
  await db.delete(STORE, id)
}

/** 清空全部背景图 */
export async function clearBackgroundImages(): Promise<void> {
  const db = await getDB()
  await db.clear(STORE)
}

/** 统计已占用的近似体积（字节） */
export async function estimateUsage(): Promise<number> {
  const db = await getDB()
  const all = await db.getAll(STORE)
  return all.reduce(
    (sum, item) =>
      sum + (item.blob?.size ?? 0) + (item.original?.size ?? 0),
    0
  )
}

/**
 * 把 Blob 转成可供 CSS 使用的 objectURL。
 * 调用方负责在不再使用时 revokeObjectURL，避免内存泄漏。
 */
export function blobToObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob)
}