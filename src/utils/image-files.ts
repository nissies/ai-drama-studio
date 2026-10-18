export type SupportedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

const MAX_SIGNATURE_BYTES = 16

export async function detectImageMimeType(
  blob: globalThis.Blob,
): Promise<SupportedImageMimeType | null> {
  const bytes = new Uint8Array(await blob.slice(0, MAX_SIGNATURE_BYTES).arrayBuffer())
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

export async function normalizeImageFile(file: globalThis.File, maxBytes: number) {
  if (file.size <= 0 || file.size > maxBytes) {
    throw new Error(`图片必须小于 ${Math.floor(maxBytes / 1024 / 1024)}MB`)
  }
  const mimeType = await detectImageMimeType(file)
  if (!mimeType) throw new Error(`${file.name} 不是有效的 PNG、JPEG 或 WebP 图片`)
  const normalizedName = replaceImageExtension(file.name, fileExtension(mimeType))
  const corrected = file.type !== mimeType || normalizedName !== file.name
  return {
    file: corrected
      ? new globalThis.File([file], normalizedName, {
          type: mimeType,
          lastModified: file.lastModified,
        })
      : file,
    corrected,
    originalName: file.name,
    mimeType,
  }
}

export async function normalizeImageBlob(blob: globalThis.Blob) {
  if (blob.size <= 0) throw new Error('图片内容为空')
  const mimeType = await detectImageMimeType(blob)
  if (!mimeType) throw new Error('服务器返回的内容不是有效图片')
  return blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType)
}

export function fileExtension(mimeType: SupportedImageMimeType | string) {
  return mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png'
}

function replaceImageExtension(name: string, extension: string) {
  const baseName = name.replace(/\.(?:png|jpe?g|webp)$/i, '') || 'reference-image'
  return `${baseName}${extension}`
}
