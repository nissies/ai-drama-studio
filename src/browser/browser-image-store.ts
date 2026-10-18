import { normalizeImageFile } from '../utils/image-files'

const DATABASE_NAME = 'ai-drama-studio-browser-assets'
const DATABASE_VERSION = 3
const IMAGE_STORE_NAME = 'images'
const MEDIA_STORE_NAME = 'media'

interface StoredBrowserImage {
  key: string
  projectId: string
  assetId: string
  blob: globalThis.Blob
  updatedAt: string
}

interface StoredBrowserMedia {
  key: string
  projectId: string
  assetId: string
  blob: globalThis.Blob
  updatedAt: string
}

export async function saveBrowserImage(projectId: string, assetId: string, blob: globalThis.Blob) {
  const database = await openDatabase()
  await transactionPromise(database, IMAGE_STORE_NAME, 'readwrite', (store) =>
    store.put({
      key: imageKey(projectId, assetId),
      projectId,
      assetId,
      blob,
      updatedAt: new Date().toISOString(),
    } satisfies StoredBrowserImage),
  )
}

export async function loadBrowserImage(
  projectId: string,
  assetId: string,
): Promise<globalThis.Blob | null> {
  const database = await openDatabase()
  const record = await transactionPromise<StoredBrowserImage | undefined>(
    database,
    IMAGE_STORE_NAME,
    'readonly',
    (store) => store.get(imageKey(projectId, assetId)),
  )
  return record?.blob ?? null
}

export async function deleteBrowserImage(projectId: string, assetId: string) {
  const database = await openDatabase()
  await transactionPromise(database, IMAGE_STORE_NAME, 'readwrite', (store) =>
    store.delete(imageKey(projectId, assetId)),
  )
}

export async function deleteBrowserProjectImages(projectId: string) {
  await deleteProjectRecords(IMAGE_STORE_NAME, projectId)
  await deleteProjectRecords(MEDIA_STORE_NAME, projectId)
}

export async function saveBrowserMedia(
  projectId: string,
  assetId: string,
  blob: globalThis.Blob,
) {
  const database = await openDatabase()
  await transactionPromise(database, MEDIA_STORE_NAME, 'readwrite', (store) =>
    store.put({
      key: imageKey(projectId, assetId),
      projectId,
      assetId,
      blob,
      updatedAt: new Date().toISOString(),
    } satisfies StoredBrowserMedia),
  )
}

export async function loadBrowserMedia(
  projectId: string,
  assetId: string,
): Promise<globalThis.Blob | null> {
  const database = await openDatabase()
  const record = await transactionPromise<StoredBrowserMedia | undefined>(
    database,
    MEDIA_STORE_NAME,
    'readonly',
    (store) => store.get(imageKey(projectId, assetId)),
  )
  return record?.blob ?? null
}

export async function deleteBrowserMedia(projectId: string, assetId: string) {
  const database = await openDatabase()
  await transactionPromise(database, MEDIA_STORE_NAME, 'readwrite', (store) =>
    store.delete(imageKey(projectId, assetId)),
  )
}

async function deleteProjectRecords(storeName: string, projectId: string) {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const request = transaction.objectStore(storeName).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const record = cursor.value as StoredBrowserImage | StoredBrowserMedia
      if (record.projectId === projectId) cursor.delete()
      cursor.continue()
    }
    request.onerror = () => reject(request.error ?? new Error('浏览器本地图片清理失败'))
    transaction.oncomplete = () => {
      database.close()
      resolve()
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('浏览器本地图片清理失败'))
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('浏览器本地图片清理已中止'))
    }
  })
}

export async function validateBrowserImage(file: globalThis.File) {
  return (await normalizeImageFile(file, 30 * 1024 * 1024)).file
}

export async function sha256Hex(file: globalThis.Blob) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function imageKey(projectId: string, assetId: string) {
  return `${projectId}:${assetId}`
}

function openDatabase(): Promise<globalThis.IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        database.createObjectStore(IMAGE_STORE_NAME, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        database.createObjectStore(MEDIA_STORE_NAME, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains('motion-assets')) {
        database.createObjectStore('motion-assets', { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('浏览器本地图片库打开失败'))
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
    request.onerror = () => reject(request.error ?? new Error('浏览器本地图片操作失败'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => reject(transaction.error ?? new Error('浏览器本地图片事务失败'))
  })
}
