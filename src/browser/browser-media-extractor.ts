const MEDIA_LOAD_TIMEOUT_MS = 30_000
const MAX_BROWSER_EXTRACTION_BYTES = 300 * 1024 * 1024
const OUTPUT_AUDIO_SAMPLE_RATE = 24_000

export interface ExtractedVideoFrame {
  blob: globalThis.Blob
  width: number
  height: number
  durationSec: number
}

export interface ExtractedAudioSegment {
  blob: globalThis.Blob
  durationSec: number
}

export type VideoFramePosition = 'FIRST' | 'LAST'

export async function extractVideoFrame(
  videoBlob: globalThis.Blob,
  position: VideoFramePosition,
): Promise<ExtractedVideoFrame> {
  assertBrowserExtractionSize(videoBlob)
  const sourceUrl = globalThis.URL.createObjectURL(videoBlob)
  const video = globalThis.document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.src = sourceUrl

  try {
    await waitForMediaEvent(video, 'loadedmetadata')
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error(`无法读取视频时长，不能提取${position === 'FIRST' ? '首帧' : '尾帧'}`)
    }
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error(`无法读取视频画面尺寸，不能提取${position === 'FIRST' ? '首帧' : '尾帧'}`)
    }

    const targetTime =
      position === 'FIRST' ? 0 : Math.max(0, video.duration - Math.min(0.08, video.duration / 2))
    if (targetTime > 0) {
      video.currentTime = targetTime
      await waitForMediaEvent(video, 'seeked')
    } else if (video.readyState < globalThis.HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMediaEvent(video, 'loadeddata')
    }

    const canvas = globalThis.document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持视频画面提取')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await canvasToBlob(canvas, 'image/png')
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      durationSec: video.duration,
    }
  } finally {
    video.removeAttribute('src')
    video.load()
    globalThis.URL.revokeObjectURL(sourceUrl)
  }
}

export async function extractLastVideoFrame(
  videoBlob: globalThis.Blob,
): Promise<ExtractedVideoFrame> {
  return extractVideoFrame(videoBlob, 'LAST')
}

export async function extractAudioSegment(
  videoBlob: globalThis.Blob,
  startSec: number,
  endSec: number,
): Promise<ExtractedAudioSegment> {
  assertBrowserExtractionSize(videoBlob)
  if (
    !Number.isFinite(startSec) ||
    !Number.isFinite(endSec) ||
    startSec < 0 ||
    endSec <= startSec
  ) {
    throw new Error('音频截取时间范围无效')
  }
  const durationSec = endSec - startSec
  if (durationSec < 1 || durationSec > 60) throw new Error('单次音频截取时长必须为 1 到 60 秒')

  const audioContext = new globalThis.AudioContext()
  try {
    let decoded: globalThis.AudioBuffer
    try {
      decoded = await audioContext.decodeAudioData(await videoBlob.arrayBuffer())
    } catch {
      throw new Error('浏览器无法解码该视频的音轨，请改用 Windows 客户端 FFmpeg 提取')
    }
    if (startSec >= decoded.duration) throw new Error('开始时间超出视频音轨时长')
    const boundedDuration = Math.min(durationSec, decoded.duration - startSec)
    if (boundedDuration < 1) throw new Error('可提取的音频不足 1 秒')

    const frameCount = Math.max(1, Math.ceil(boundedDuration * OUTPUT_AUDIO_SAMPLE_RATE))
    const renderer = new globalThis.OfflineAudioContext(1, frameCount, OUTPUT_AUDIO_SAMPLE_RATE)
    const source = renderer.createBufferSource()
    source.buffer = decoded
    source.connect(renderer.destination)
    source.start(0, startSec, boundedDuration)
    const rendered = await renderer.startRendering()
    return { blob: encodePcmWav(rendered), durationSec: rendered.duration }
  } finally {
    await audioContext.close().catch(() => undefined)
  }
}

export function encodePcmWav(audioBuffer: globalThis.AudioBuffer): globalThis.Blob {
  const samples = audioBuffer.getChannelData(0)
  const bytesPerSample = 2
  const dataLength = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, audioBuffer.sampleRate, true)
  view.setUint32(28, audioBuffer.sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataLength, true)

  let offset = 44
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true)
    offset += bytesPerSample
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

function assertBrowserExtractionSize(blob: globalThis.Blob) {
  if (!blob.size) throw new Error('视频文件为空，无法提取媒体')
  if (blob.size > MAX_BROWSER_EXTRACTION_BYTES) {
    throw new Error('视频超过 300 MB，请使用 Windows 客户端 FFmpeg 提取，避免浏览器内存不足')
  }
}

function waitForMediaEvent(
  media: globalThis.HTMLMediaElement,
  eventName: 'loadedmetadata' | 'loadeddata' | 'seeked',
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      cleanup()
      reject(new Error('读取视频超时，请确认视频文件可以正常播放'))
    }, MEDIA_LOAD_TIMEOUT_MS)
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(media.error?.message || '视频文件读取失败'))
    }
    const cleanup = () => {
      globalThis.clearTimeout(timeout)
      media.removeEventListener(eventName, onEvent)
      media.removeEventListener('error', onError)
    }
    media.addEventListener(eventName, onEvent, { once: true })
    media.addEventListener('error', onError, { once: true })
  })
}

function canvasToBlob(canvas: globalThis.HTMLCanvasElement, type: string) {
  return new Promise<globalThis.Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('视频帧图片编码失败'))
    }, type)
  })
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}
