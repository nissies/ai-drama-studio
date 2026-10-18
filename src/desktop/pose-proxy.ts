import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { createDwPoseProxy } from './dwpose'
import { stabilizePoseFrames } from './pose-stabilizer'
import type {
  PoseProxyFrame,
  PoseProxyLandmark,
  PoseProxyMask,
  PoseProxyProgress,
  PoseProxyRenderResult,
} from './types'

const SAMPLE_FPS = 12
const MAX_DURATION_SEC = 30
const MAX_FILE_BYTES = 500 * 1024 * 1024
const MAX_POSES = 4
const MASK_MAX_WIDTH = 256
const MODEL_PATHS = [
  {
    variant: 'full',
    path: 'mediapipe/models/pose_landmarker_full.task',
  },
  {
    variant: 'lite',
    path: 'mediapipe/models/pose_landmarker_lite.task',
  },
] as const

interface LoadedLandmarker {
  landmarker: PoseLandmarker
  variant: (typeof MODEL_PATHS)[number]['variant']
}

let landmarkerPromise: Promise<LoadedLandmarker> | null = null
let extractionActive = false

export interface LocalPoseProxyResult {
  file: File
  width: number
  height: number
  durationSec: number
  detectedFrameRatio: number
}

export async function createLocalPoseProxy(
  source: File,
  onProgress: (progress: PoseProxyProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<LocalPoseProxyResult> {
  try {
    return await createDwPoseProxy(source, onProgress, signal)
  } catch (error) {
    console.warn('DWPose 动作代理失败，回退到 MediaPipe', error)
    return createLocalPoseProxyLegacy(source, onProgress, signal)
  }
}

async function createLocalPoseProxyLegacy(
  source: File,
  onProgress: (progress: PoseProxyProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<LocalPoseProxyResult> {
  const bridge = globalThis.window?.aiDramaDesktop
  if (!bridge) throw new Error('姿态代理需要在 Windows 客户端中生成')
  validateSourceFile(source)
  if (extractionActive) throw new Error('已有动作视频正在提取骨骼，请等待当前任务完成')
  extractionActive = true
  const taskId = crypto.randomUUID()
  const objectUrl = URL.createObjectURL(source)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = objectUrl
  let unsubscribe = () => undefined
  const abortHandler = () => void bridge.cancelPoseProxy(taskId)
  signal?.addEventListener('abort', abortHandler, { once: true })
  try {
    assertNotAborted(signal)
    onProgress(progress(taskId, 'LOADING_MODEL', 2, '正在加载本地高精度动作识别模型'))
    const [loadedLandmarker] = await Promise.all([loadLandmarker(), waitForVideoMetadata(video)])
    const landmarker = loadedLandmarker.landmarker
    assertNotAborted(signal)
    const durationSec = validateVideoMetadata(video)
    const frameCount = Math.max(1, Math.ceil(durationSec * SAMPLE_FPS))
    const frames: PoseProxyFrame[] = []
    for (let index = 0; index < frameCount; index += 1) {
      assertNotAborted(signal)
      const timestampMs = Math.min(index * (1000 / SAMPLE_FPS), Math.max(0, durationSec * 1000 - 1))
      await seekVideo(video, timestampMs / 1000)
      const result = landmarker.detectForVideo(video, timestampMs)
      try {
        frames.push({
          poses: result.landmarks.slice(0, MAX_POSES).map((pose) =>
            pose.map((landmark): PoseProxyLandmark => ({
              x: landmark.x,
              y: landmark.y,
              z: landmark.z,
              visibility: landmark.visibility ?? 1,
            })),
          ),
          poseMasks: extractPoseMasks(result.segmentationMasks),
        })
      } finally {
        result.close()
      }
      if (index % 2 === 0 || index === frameCount - 1) {
        const value = 5 + Math.round(((index + 1) / frameCount) * 47)
        onProgress(progress(taskId, 'ANALYZING', value, `正在本地识别动作 ${index + 1}/${frameCount}`))
        await yieldToRenderer()
      }
    }
    const stabilizedFrames = stabilizePoseFrames(frames)

    unsubscribe = bridge.onPoseProxyProgress((event) => {
      if (event.taskId === taskId) onProgress(event)
    })
    const rendered = await bridge.renderPoseProxy({
      taskId,
      sourceWidth: video.videoWidth,
      sourceHeight: video.videoHeight,
      fps: SAMPLE_FPS,
      frames: stabilizedFrames,
    })
    assertNotAborted(signal)
    return renderResult(rendered)
  } finally {
    unsubscribe()
    signal?.removeEventListener('abort', abortHandler)
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
    extractionActive = false
  }
}

async function loadLandmarker(): Promise<LoadedLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker().catch((error) => {
      landmarkerPromise = null
      throw error
    })
  }
  return landmarkerPromise
}

async function createLandmarker(): Promise<LoadedLandmarker> {
  const wasmRoot = new URL('mediapipe/wasm', document.baseURI).toString().replace(/\/$/, '')
  const fileset = await FilesetResolver.forVisionTasks(wasmRoot)
  let lastError: unknown
  for (const model of MODEL_PATHS) {
    try {
      return {
        landmarker: await createLandmarkerForModel(
          fileset,
          new URL(model.path, document.baseURI).toString(),
        ),
        variant: model.variant,
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('本地动作识别模型加载失败')
}

async function createLandmarkerForModel(
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  modelAssetPath: string,
) {
  const options = {
    baseOptions: { modelAssetPath },
    runningMode: 'VIDEO' as const,
    numPoses: MAX_POSES,
    minPoseDetectionConfidence: 0.45,
    minPosePresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
    outputSegmentationMasks: true,
  }
  try {
    return await PoseLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'GPU' },
    })
  } catch {
    return PoseLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    })
  }
}

function validateSourceFile(source: File) {
  if (!(source instanceof File) || !source.type.startsWith('video/')) {
    throw new Error('请选择有效的动作参考视频')
  }
  if (source.size <= 0 || source.size > MAX_FILE_BYTES) {
    throw new Error('动作参考视频大小必须在 500MB 以内')
  }
}

function validateVideoMetadata(video: HTMLVideoElement) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('无法读取动作视频时长')
  if (video.duration > MAX_DURATION_SEC) {
    throw new Error(`动作参考视频最长支持 ${MAX_DURATION_SEC} 秒，请先截取需要的动作片段`)
  }
  if (video.videoWidth < 64 || video.videoHeight < 64) throw new Error('动作视频分辨率过低')
  return video.duration
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => finish(new Error('读取动作视频超时')), 15_000)
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onLoaded = () => finish()
    const onError = () => finish(new Error('动作视频无法解码，请转换为 MP4 后重试'))
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.load()
  })
}

function seekVideo(video: HTMLVideoElement, timeSec: number) {
  if (Math.abs(video.currentTime - timeSec) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => finish(new Error('读取动作视频帧超时')), 10_000)
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onSeeked = () => finish()
    const onError = () => finish(new Error('动作视频帧解码失败'))
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.currentTime = timeSec
  })
}

function renderResult(result: PoseProxyRenderResult): LocalPoseProxyResult {
  const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes)
  return {
    file: new File([bytes], result.fileName, {
      type: result.mimeType,
      lastModified: Date.now(),
    }),
    width: result.width,
    height: result.height,
    durationSec: result.durationSec,
    detectedFrameRatio: result.detectedFrameRatio,
  }
}

function extractPoseMasks(masks: { width: number; height: number; getAsFloat32Array(): Float32Array }[] | undefined) {
  if (!masks?.length) return []
  return masks.slice(0, MAX_POSES).map((mask) => downsampleMask(mask)).filter(Boolean) as PoseProxyMask[]
}

function downsampleMask(mask: { width: number; height: number; getAsFloat32Array(): Float32Array }) {
  const sourceWidth = Math.max(1, Math.floor(mask.width))
  const sourceHeight = Math.max(1, Math.floor(mask.height))
  const source = mask.getAsFloat32Array()
  if (source.length !== sourceWidth * sourceHeight) return null
  const width = Math.min(MASK_MAX_WIDTH, sourceWidth)
  const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width))
  const alpha = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / height))
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / width))
      const confidence = source[sourceY * sourceWidth + sourceX] ?? 0
      alpha[y * width + x] = Math.round(clamp(confidence, 0, 1) * 255)
    }
  }
  return { width, height, alpha }
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('姿态代理生成已取消')
}

function progress(
  taskId: string,
  stage: PoseProxyProgress['stage'],
  value: number,
  message: string,
): PoseProxyProgress {
  return { taskId, stage, progress: value, message }
}

function yieldToRenderer() {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}
