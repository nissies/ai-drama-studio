const DATABASE_NAME = 'ai-drama-studio-browser-assets'
const DATABASE_VERSION = 3
const MOTION_STORE_NAME = 'motion-assets'
const MAX_MOTION_ASSETS_PER_PROJECT = 40

export type MotionAssetKind = 'MOTION_REFERENCE' | 'POSE_PROXY'

export interface BrowserMotionAssetMeta {
  id: string
  projectId: string
  kind: MotionAssetKind
  label: string
  mimeType: string
  sizeBytes: number
  sourceCandidateId?: string
  sourceStoryboardId?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

interface StoredMotionAsset extends BrowserMotionAssetMeta {
  key: string
  blob: globalThis.Blob
}

function motionKey(projectId: string, id: string) {
  return `${projectId}::${id}`
}

export async function listBrowserMotionAssets(
  projectId: string,
): Promise<BrowserMotionAssetMeta[]> {
  const database = await openDatabase()
  const records = await transactionAll<StoredMotionAsset>(database, MOTION_STORE_NAME, 'readonly')
  return records
    .filter((item) => item.projectId === projectId)
    .map(toMeta)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function loadBrowserMotionAsset(
  projectId: string,
  id: string,
): Promise<{ meta: BrowserMotionAssetMeta; blob: globalThis.Blob } | null> {
  const database = await openDatabase()
  const record = await transactionPromise<StoredMotionAsset | undefined>(
    database,
    MOTION_STORE_NAME,
    'readonly',
    (store) => store.get(motionKey(projectId, id)),
  )
  if (!record) return null
  return { meta: toMeta(record), blob: record.blob }
}

export async function saveBrowserMotionAsset(input: {
  projectId: string
  kind: MotionAssetKind
  label: string
  blob: globalThis.Blob
  sourceCandidateId?: string
  sourceStoryboardId?: string
  notes?: string
  id?: string
}): Promise<BrowserMotionAssetMeta> {
  if (!input.blob || input.blob.size <= 0) {
    throw new Error('动作素材文件无效')
  }
  if (input.blob.size > 50 * 1024 * 1024) {
    throw new Error('动作素材单个文件不能超过 50MB')
  }
  const existing = await listBrowserMotionAssets(input.projectId)
  if (!input.id && existing.length >= MAX_MOTION_ASSETS_PER_PROJECT) {
    throw new Error(`每个项目最多保存 ${MAX_MOTION_ASSETS_PER_PROJECT} 个动作素材`)
  }
  const now = new Date().toISOString()
  const id = input.id || globalThis.crypto.randomUUID()
  const previous = existing.find((item) => item.id === id)
  const meta: BrowserMotionAssetMeta = {
    id,
    projectId: input.projectId,
    kind: input.kind,
    label: input.label.trim() || (input.kind === 'POSE_PROXY' ? '姿态代理' : '动作参考'),
    mimeType: input.blob.type || 'video/mp4',
    sizeBytes: input.blob.size,
    sourceCandidateId: input.sourceCandidateId,
    sourceStoryboardId: input.sourceStoryboardId,
    notes: input.notes?.trim() || undefined,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  }
  const database = await openDatabase()
  await transactionPromise(database, MOTION_STORE_NAME, 'readwrite', (store) =>
    store.put({
      key: motionKey(input.projectId, id),
      ...meta,
      blob: input.blob,
    } satisfies StoredMotionAsset),
  )
  return meta
}

export async function deleteBrowserMotionAsset(projectId: string, id: string) {
  const database = await openDatabase()
  await transactionPromise(database, MOTION_STORE_NAME, 'readwrite', (store) =>
    store.delete(motionKey(projectId, id)),
  )
}

export async function deleteBrowserProjectMotionAssets(projectId: string) {
  const database = await openDatabase()
  const records = await transactionAll<StoredMotionAsset>(database, MOTION_STORE_NAME, 'readonly')
  const targets = records.filter((item) => item.projectId === projectId)
  if (!targets.length) return
  await new Promise<void>((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error ?? new Error('动作素材库打开失败'))
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(MOTION_STORE_NAME, 'readwrite')
      const store = tx.objectStore(MOTION_STORE_NAME)
      targets.forEach((item) => store.delete(item.key))
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error ?? new Error('动作素材清理失败'))
    }
  })
}

function toMeta(record: StoredMotionAsset): BrowserMotionAssetMeta {
  return {
    id: record.id,
    projectId: record.projectId,
    kind: record.kind,
    label: record.label,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    sourceCandidateId: record.sourceCandidateId,
    sourceStoryboardId: record.sourceStoryboardId,
    notes: record.notes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function openDatabase(): Promise<globalThis.IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('images')) {
        database.createObjectStore('images', { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains('media')) {
        database.createObjectStore('media', { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(MOTION_STORE_NAME)) {
        database.createObjectStore(MOTION_STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('动作素材库打开失败'))
  })
}

function transactionPromise<T = globalThis.IDBValidKey>(
  database: globalThis.IDBDatabase,
  storeName: string,
  mode: globalThis.IDBTransactionMode,
  operation: (store: globalThis.IDBObjectStore) => globalThis.IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = operation(transaction.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('动作素材操作失败'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => reject(transaction.error ?? new Error('动作素材事务失败'))
  })
}

function transactionAll<T>(
  database: globalThis.IDBDatabase,
  storeName: string,
  mode: globalThis.IDBTransactionMode,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = transaction.objectStore(storeName).getAll()
    request.onsuccess = () => resolve((request.result as T[]) ?? [])
    request.onerror = () => reject(request.error ?? new Error('动作素材列表读取失败'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => reject(transaction.error ?? new Error('动作素材列表事务失败'))
  })
}