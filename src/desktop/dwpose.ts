import * as ort from 'onnxruntime-web/wasm'
import { stabilizePoseFrames } from './pose-stabilizer'
import type {
  PoseProxyFrame,
  PoseProxyLandmark,
  PoseProxyProgress,
  PoseProxyRenderResult,
} from './types'

const SAMPLE_FPS = 12
const MAX_DURATION_SEC = 30
const MAX_FILE_BYTES = 500 * 1024 * 1024
const MODEL_INPUT_WIDTH = 288
const MODEL_INPUT_HEIGHT = 384
const SIMCC_SPLIT_RATIO = 2
const KEYPOINT_COUNT = 133
const BODY_KEYPOINT_COUNT = 17
const FOOT_KEYPOINT_OFFSET = 17
const FOOT_KEYPOINT_COUNT = 6
const FACE_KEYPOINT_OFFSET = 23
const FACE_KEYPOINT_COUNT = 68
const LEFT_HAND_KEYPOINT_OFFSET = 91
const RIGHT_HAND_KEYPOINT_OFFSET = 112
const HAND_KEYPOINT_COUNT = 21
const BODY_VISIBILITY_THRESHOLD = 0.12
const DETECTION_VISIBILITY_THRESHOLD = 0.08
let sessionPromise: Promise<ort.InferenceSession> | null = null
let extractionActive = false

interface ProxyPoint {
  x: number
  y: number
  score: number
}

interface CropBox {
  x: number
  y: number
  width: number
  height: number
}

interface InferenceOutput {
  poses: PoseProxyLandmark[][]
  nextCropBox: CropBox | null
  detected: boolean
}

export interface LocalDwPoseProxyResult {
  file: File
  width: number
  height: number
  durationSec: number
  detectedFrameRatio: number
}

export async function createDwPoseProxy(
  source: File,
  onProgress: (progress: PoseProxyProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<LocalDwPoseProxyResult> {
  const bridge = globalThis.window?.aiDramaDesktop
  if (!bridge) throw new Error('动作代理需要在 Windows 客户端中生成')
  validateSourceFile(source)
  if (extractionActive) throw new Error('已有动作参考视频正在处理，请稍后再试')
  extractionActive = true
  const taskId = crypto.randomUUID()
  const objectUrl = URL.createObjectURL(source)
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法创建动作参考视频处理画布')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = objectUrl
  let unsubscribe = () => undefined
  const abortHandler = () => void bridge.cancelPoseProxy(taskId)
  signal?.addEventListener('abort', abortHandler, { once: true })
  try {
    assertNotAborted(signal)
    onProgress(progress(taskId, 'LOADING_MODEL', 2, '正在加载 DWPose 姿态模型'))
    const [session] = await Promise.all([loadSession(), waitForVideoMetadata(video)])
    const durationSec = validateVideoMetadata(video)
    const frameCount = Math.max(1, Math.ceil(durationSec * SAMPLE_FPS))
    const frames: PoseProxyFrame[] = []
    let previousCropBox: CropBox | null = null
    for (let index = 0; index < frameCount; index += 1) {
      assertNotAborted(signal)
      const timestampMs = Math.min(index * (1000 / SAMPLE_FPS), Math.max(0, durationSec * 1000 - 1))
      await seekVideo(video, timestampMs / 1000)
      const output = await inferFrame(video, session, context, previousCropBox)
      frames.push({
        poses: output.poses,
      })
      previousCropBox = output.nextCropBox ?? previousCropBox
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

async function inferFrame(
  video: HTMLVideoElement,
  session: ort.InferenceSession,
  context: CanvasRenderingContext2D,
  cropBox: CropBox | null,
): Promise<InferenceOutput> {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  const sourceBox = normalizeCropBox(
    cropBox ?? {
      x: 0,
      y: 0,
      width: sourceWidth,
      height: sourceHeight,
    },
    sourceWidth,
    sourceHeight,
  )
  const tensor = await createInputTensor(video, context, sourceBox)
  const outputs = await session.run({ input: tensor })
  const decoded = decodeOutputs(outputs)
  if (!decoded) {
    return { poses: [], nextCropBox: sourceBox, detected: false }
  }
  const proxyPose = buildProxyPose(decoded.wholeBodyKeypoints, sourceWidth, sourceHeight, sourceBox)
  if (!proxyPose) {
    return { poses: [], nextCropBox: sourceBox, detected: false }
  }
  const nextCropBox = poseToCropBox(proxyPose, sourceWidth, sourceHeight)
  return { poses: [proxyPose], nextCropBox, detected: true }
}

async function loadSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.numThreads = 1
    const bridge = globalThis.window?.aiDramaDesktop
    if (!bridge) throw new Error('DWPose 姿态模型仅支持 Windows 客户端')
    const model = await bridge.getOptionalRuntimeAsset('dwpose-model')
    if (model.state !== 'READY') {
      throw new Error('尚未安装 DWPose 姿态模型，请先在“设置”中下载安装')
    }
    sessionPromise = ort.InferenceSession.create(bridge.runtimeAssetUrl('dwpose-model'), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }).catch((error) => {
      sessionPromise = null
      throw error
    })
  }
  return sessionPromise
}

async function createInputTensor(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  cropBox: CropBox,
) {
  const canvas = context.canvas
  canvas.width = MODEL_INPUT_WIDTH
  canvas.height = MODEL_INPUT_HEIGHT
  context.save()
  context.imageSmoothingEnabled = true
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(
    video,
    cropBox.x,
    cropBox.y,
    cropBox.width,
    cropBox.height,
    0,
    0,
    MODEL_INPUT_WIDTH,
    MODEL_INPUT_HEIGHT,
  )
  context.restore()
  const imageData = context.getImageData(0, 0, MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT)
  const data = new Float32Array(3 * MODEL_INPUT_WIDTH * MODEL_INPUT_HEIGHT)
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  for (let index = 0; index < MODEL_INPUT_WIDTH * MODEL_INPUT_HEIGHT; index += 1) {
    const rgba = index * 4
    const red = imageData.data[rgba] / 255
    const green = imageData.data[rgba + 1] / 255
    const blue = imageData.data[rgba + 2] / 255
    data[index] = (red - mean[0]) / std[0]
    data[index + MODEL_INPUT_WIDTH * MODEL_INPUT_HEIGHT] = (green - mean[1]) / std[1]
    data[index + MODEL_INPUT_WIDTH * MODEL_INPUT_HEIGHT * 2] = (blue - mean[2]) / std[2]
  }
  return new ort.Tensor('float32', data, [1, 3, MODEL_INPUT_HEIGHT, MODEL_INPUT_WIDTH])
}

function decodeOutputs(outputs: Record<string, ort.Tensor>) {
  const xTensor = outputs.simcc_x
  const yTensor = outputs.simcc_y
  if (!xTensor || !yTensor) return null
  const wholeBodyKeypoints = decodeWholeBodyKeypoints(
    xTensor.data as Float32Array,
    yTensor.data as Float32Array,
    xTensor.dims,
    yTensor.dims,
  )
  return { wholeBodyKeypoints }
}

function decodeWholeBodyKeypoints(
  simccX: Float32Array,
  simccY: Float32Array,
  xDims: number[],
  yDims: number[],
) {
  const jointCount = Math.min(KEYPOINT_COUNT, xDims[1] || 0, yDims[1] || 0)
  const xLength = xDims[2] || 0
  const yLength = yDims[2] || 0
  const points: ProxyPoint[] = []
  for (let joint = 0; joint < jointCount; joint += 1) {
    const xOffset = joint * xLength
    const yOffset = joint * yLength
    let bestX = -Infinity
    let bestXi = -1
    for (let index = 0; index < xLength; index += 1) {
      const value = simccX[xOffset + index]
      if (value > bestX) {
        bestX = value
        bestXi = index
      }
    }
    let bestY = -Infinity
    let bestYi = -1
    for (let index = 0; index < yLength; index += 1) {
      const value = simccY[yOffset + index]
      if (value > bestY) {
        bestY = value
        bestYi = index
      }
    }
    const score = Math.min(bestX, bestY)
    points.push({
      x: bestXi / SIMCC_SPLIT_RATIO,
      y: bestYi / SIMCC_SPLIT_RATIO,
      score,
    })
  }
  return points
}

function buildProxyPose(
  wholeBodyKeypoints: ProxyPoint[],
  sourceWidth: number,
  sourceHeight: number,
  cropBox: CropBox,
) {
  const body = projectKeypoints(
    wholeBodyKeypoints.slice(0, BODY_KEYPOINT_COUNT),
    sourceWidth,
    sourceHeight,
    cropBox,
  )
  const feet = projectKeypoints(
    wholeBodyKeypoints.slice(FOOT_KEYPOINT_OFFSET, FOOT_KEYPOINT_OFFSET + FOOT_KEYPOINT_COUNT),
    sourceWidth,
    sourceHeight,
    cropBox,
  )
  const face = projectKeypoints(
    wholeBodyKeypoints.slice(FACE_KEYPOINT_OFFSET, FACE_KEYPOINT_OFFSET + FACE_KEYPOINT_COUNT),
    sourceWidth,
    sourceHeight,
    cropBox,
  )
  const leftHand = projectKeypoints(
    wholeBodyKeypoints.slice(LEFT_HAND_KEYPOINT_OFFSET, LEFT_HAND_KEYPOINT_OFFSET + HAND_KEYPOINT_COUNT),
    sourceWidth,
    sourceHeight,
    cropBox,
  )
  const rightHand = projectKeypoints(
    wholeBodyKeypoints.slice(RIGHT_HAND_KEYPOINT_OFFSET, RIGHT_HAND_KEYPOINT_OFFSET + HAND_KEYPOINT_COUNT),
    sourceWidth,
    sourceHeight,
    cropBox,
  )
  const visibleCount = body.filter((landmark) => landmark.visibility > 0).length
  if (visibleCount < 6) return null

  const leftShoulder = body[5]
  const rightShoulder = body[6]
  const leftElbow = body[7]
  const rightElbow = body[8]
  const leftWrist = body[9]
  const rightWrist = body[10]
  const leftHip = body[11]
  const rightHip = body[12]
  const leftKnee = body[13]
  const rightKnee = body[14]
  const leftAnkle = body[15]
  const rightAnkle = body[16]
  const nose = body[0]
  const shoulderCenter = midpoint(leftShoulder, rightShoulder)
  const hipCenter = midpoint(leftHip, rightHip)
  const spineCenter = midpoint(shoulderCenter, hipCenter) ?? shoulderCenter ?? hipCenter ?? nose
  const shoulderWidth = distance(leftShoulder, rightShoulder)
  const faceHeight = spineCenter && nose ? Math.abs(spineCenter.y - nose.y) * 1.6 : shoulderWidth * 0.45
  const faceWidth = Math.max(shoulderWidth * 0.34, faceHeight * 0.78, 10)
  const eyeOffsetY = Math.max(faceHeight * 0.18, 4)
  const eyeOffsetX = Math.max(faceWidth * 0.22, 3)
  const earOffsetX = Math.max(faceWidth * 0.42, 5)
  const leftEye = derivePoint(nose, -eyeOffsetX, -eyeOffsetY, sourceWidth, sourceHeight)
  const rightEye = derivePoint(nose, eyeOffsetX, -eyeOffsetY, sourceWidth, sourceHeight)
  const leftEar = derivePoint(nose, -earOffsetX, -eyeOffsetY * 0.8, sourceWidth, sourceHeight)
  const rightEar = derivePoint(nose, earOffsetX, -eyeOffsetY * 0.8, sourceWidth, sourceHeight)
  const leftHandReach = handExtension(leftElbow, leftWrist, sourceWidth, sourceHeight)
  const rightHandReach = handExtension(rightElbow, rightWrist, sourceWidth, sourceHeight)
  const leftFootReach = footExtension(leftKnee, leftAnkle, sourceWidth, sourceHeight)
  const rightFootReach = footExtension(rightKnee, rightAnkle, sourceWidth, sourceHeight)
  const leftEyePoint = preferDetected(body[1], leftEye)
  const rightEyePoint = preferDetected(body[2], rightEye)
  const leftMouth = preferDetected(face[48], derivePoint(nose, -faceWidth * 0.12, faceHeight * 0.18, sourceWidth, sourceHeight))
  const rightMouth = preferDetected(face[54], derivePoint(nose, faceWidth * 0.12, faceHeight * 0.18, sourceWidth, sourceHeight))

  return [
    bodyPoint(nose, sourceWidth, sourceHeight),
    duplicate(leftEyePoint),
    duplicate(leftEyePoint),
    duplicate(leftEyePoint),
    duplicate(rightEyePoint),
    duplicate(rightEyePoint),
    duplicate(rightEyePoint),
    preferDetected(body[3], leftEar),
    preferDetected(body[4], rightEar),
    leftMouth,
    rightMouth,
    bodyPoint(leftShoulder, sourceWidth, sourceHeight),
    bodyPoint(rightShoulder, sourceWidth, sourceHeight),
    bodyPoint(leftElbow, sourceWidth, sourceHeight),
    bodyPoint(rightElbow, sourceWidth, sourceHeight),
    bodyPoint(leftWrist, sourceWidth, sourceHeight),
    bodyPoint(rightWrist, sourceWidth, sourceHeight),
    bodyPoint(leftHip, sourceWidth, sourceHeight),
    bodyPoint(rightHip, sourceWidth, sourceHeight),
    bodyPoint(leftKnee, sourceWidth, sourceHeight),
    bodyPoint(rightKnee, sourceWidth, sourceHeight),
    bodyPoint(leftAnkle, sourceWidth, sourceHeight),
    bodyPoint(rightAnkle, sourceWidth, sourceHeight),
    preferDetected(leftHand[20], leftHandReach[0]),
    preferDetected(rightHand[20], rightHandReach[0]),
    preferDetected(leftHand[8], leftHandReach[1]),
    preferDetected(rightHand[8], rightHandReach[1]),
    preferDetected(leftHand[4], leftHandReach[2]),
    preferDetected(rightHand[4], rightHandReach[2]),
    duplicate(bodyPoint(leftHip, sourceWidth, sourceHeight)),
    duplicate(bodyPoint(rightHip, sourceWidth, sourceHeight)),
    duplicate(bodyPoint(leftKnee, sourceWidth, sourceHeight)),
    duplicate(bodyPoint(rightKnee, sourceWidth, sourceHeight)),
    duplicate(bodyPoint(leftAnkle, sourceWidth, sourceHeight)),
    duplicate(bodyPoint(rightAnkle, sourceWidth, sourceHeight)),
    preferDetected(feet[2], leftFootReach[0]),
    preferDetected(feet[5], rightFootReach[0]),
    preferDetected(feet[0], leftFootReach[1]),
    preferDetected(feet[3], rightFootReach[1]),
  ]
}

function projectKeypoints(
  points: ProxyPoint[],
  sourceWidth: number,
  sourceHeight: number,
  cropBox: CropBox,
) {
  return points.map((point) => ({
    x: clamp(cropBox.x + (point.x / MODEL_INPUT_WIDTH) * cropBox.width, 0, sourceWidth),
    y: clamp(cropBox.y + (point.y / MODEL_INPUT_HEIGHT) * cropBox.height, 0, sourceHeight),
    visibility: point.score > BODY_VISIBILITY_THRESHOLD ? 1 : 0,
  }))
}

function preferDetected(
  detected: { x: number; y: number; visibility: number } | undefined,
  fallback: PoseProxyLandmark,
): PoseProxyLandmark {
  if (!detected || detected.visibility <= 0) return fallback
  return { ...detected, z: 0 }
}

function bodyPoint(point: { x: number; y: number; visibility: number }, sourceWidth: number, sourceHeight: number) {
  return {
    x: clamp(point.x, 0, sourceWidth) / sourceWidth,
    y: clamp(point.y, 0, sourceHeight) / sourceHeight,
    visibility: point.visibility,
    z: 0,
  }
}

function derivePoint(
  origin: { x: number; y: number; visibility: number },
  offsetX: number,
  offsetY: number,
  sourceWidth: number,
  sourceHeight: number,
): PoseProxyLandmark {
  return {
    x: clamp(origin.x + offsetX, 0, sourceWidth) / sourceWidth,
    y: clamp(origin.y + offsetY, 0, sourceHeight) / sourceHeight,
    visibility: origin.visibility,
    z: 0,
  }
}

function handExtension(
  elbow: { x: number; y: number; visibility: number },
  wrist: { x: number; y: number; visibility: number },
  sourceWidth: number,
  sourceHeight: number,
) {
  const vector = normalizeVector(wrist.x - elbow.x, wrist.y - elbow.y)
  const length = Math.max(distance(elbow, wrist), 18)
  const extension = { x: wrist.x + vector.x * length * 0.32, y: wrist.y + vector.y * length * 0.32 }
  const spread = { x: -vector.y * length * 0.18, y: vector.x * length * 0.18 }
  const pinky = { x: extension.x - spread.x * 0.65, y: extension.y - spread.y * 0.65 }
  const index = { x: extension.x + spread.x * 0.1, y: extension.y + spread.y * 0.1 }
  const thumb = {
    x: wrist.x + vector.x * length * 0.08 + spread.x * 0.9,
    y: wrist.y + vector.y * length * 0.08 + spread.y * 0.9,
  }
  return [
    {
      x: clamp(pinky.x, 0, sourceWidth) / sourceWidth,
      y: clamp(pinky.y, 0, sourceHeight) / sourceHeight,
      visibility: wrist.visibility,
      z: 0,
    },
    {
      x: clamp(index.x, 0, sourceWidth) / sourceWidth,
      y: clamp(index.y, 0, sourceHeight) / sourceHeight,
      visibility: wrist.visibility,
      z: 0,
    },
    {
      x: clamp(thumb.x, 0, sourceWidth) / sourceWidth,
      y: clamp(thumb.y, 0, sourceHeight) / sourceHeight,
      visibility: wrist.visibility,
      z: 0,
    },
  ]
}

function footExtension(
  knee: { x: number; y: number; visibility: number },
  ankle: { x: number; y: number; visibility: number },
  sourceWidth: number,
  sourceHeight: number,
) {
  const vector = normalizeVector(ankle.x - knee.x, ankle.y - knee.y)
  const length = Math.max(distance(knee, ankle), 18)
  const heel = { x: ankle.x - vector.x * length * 0.12, y: ankle.y - vector.y * length * 0.12 }
  const toe = { x: ankle.x + vector.x * length * 0.18, y: ankle.y + vector.y * length * 0.18 }
  return [
    {
      x: clamp(heel.x, 0, sourceWidth) / sourceWidth,
      y: clamp(heel.y, 0, sourceHeight) / sourceHeight,
      visibility: ankle.visibility,
      z: 0,
    },
    {
      x: clamp(toe.x, 0, sourceWidth) / sourceWidth,
      y: clamp(toe.y, 0, sourceHeight) / sourceHeight,
      visibility: ankle.visibility,
      z: 0,
    },
  ]
}

function poseToCropBox(pose: PoseProxyLandmark[], sourceWidth: number, sourceHeight: number) {
  const visible = pose.filter((landmark) => landmark.visibility > DETECTION_VISIBILITY_THRESHOLD)
  if (!visible.length) return null
  let minX = sourceWidth
  let minY = sourceHeight
  let maxX = 0
  let maxY = 0
  visible.forEach((landmark) => {
    const x = landmark.x * sourceWidth
    const y = landmark.y * sourceHeight
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  })
  const width = Math.max(64, (maxX - minX) * 1.28)
  const height = Math.max(64, (maxY - minY) * 1.28)
  const adjusted = fitAspectRatio({
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    width,
    height,
  })
  return normalizeCropBox(adjusted, sourceWidth, sourceHeight)
}

function fitAspectRatio(box: CropBox) {
  const targetRatio = MODEL_INPUT_WIDTH / MODEL_INPUT_HEIGHT
  const { x, y } = box
  let { width, height } = box
  if (width / height > targetRatio) {
    height = width / targetRatio
  } else {
    width = height * targetRatio
  }
  return { x, y, width, height }
}

function normalizeCropBox(box: CropBox, sourceWidth: number, sourceHeight: number) {
  let { x, y, width, height } = fitAspectRatio({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  })
  width = Math.min(width, sourceWidth)
  height = Math.min(height, sourceHeight)
  x = clamp(x, 0, Math.max(0, sourceWidth - width))
  y = clamp(y, 0, Math.max(0, sourceHeight - height))
  return { x, y, width, height }
}

function midpoint(
  left: { x: number; y: number; visibility: number } | undefined,
  right: { x: number; y: number; visibility: number } | undefined,
) {
  if (!left || !right || left.visibility <= 0 || right.visibility <= 0) return null
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
    visibility: Math.min(left.visibility, right.visibility),
  }
}

function distance(
  left: { x: number; y: number; visibility: number } | undefined,
  right: { x: number; y: number; visibility: number } | undefined,
) {
  if (!left || !right || left.visibility <= 0 || right.visibility <= 0) return 0
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function normalizeVector(x: number, y: number) {
  const magnitude = Math.hypot(x, y) || 1
  return { x: x / magnitude, y: y / magnitude }
}

function duplicate(point: PoseProxyLandmark) {
  return { ...point }
}

function renderResult(result: PoseProxyRenderResult): LocalDwPoseProxyResult {
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

function validateSourceFile(source: File) {
  if (!(source instanceof File) || !source.type.startsWith('video/')) {
    throw new Error('请选择有效的动作参考视频')
  }
  if (source.size <= 0 || source.size > MAX_FILE_BYTES) {
    throw new Error('动作参考视频大小必须在 500MB 以内')
  }
}

function validateVideoMetadata(video: HTMLVideoElement) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('无法读取动作参考视频时长')
  if (video.duration > MAX_DURATION_SEC) {
    throw new Error(`动作参考视频最长支持 ${MAX_DURATION_SEC} 秒，请先截取需要的动作片段`)
  }
  if (video.videoWidth < 64 || video.videoHeight < 64) throw new Error('动作参考视频分辨率过低')
  return video.duration
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => finish(new Error('读取动作参考视频超时')), 15_000)
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onLoaded = () => finish()
    const onError = () => finish(new Error('动作参考视频无法解码，请转换为 MP4 后重试'))
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
    const timer = globalThis.setTimeout(() => finish(new Error('读取动作参考视频帧超时')), 10_000)
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onSeeked = () => finish()
    const onError = () => finish(new Error('动作参考视频帧解码失败'))
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.currentTime = timeSec
  })
}

function progress(
  taskId: string,
  stage: PoseProxyProgress['stage'],
  value: number,
  message: string,
): PoseProxyProgress {
  return { taskId, stage, progress: value, message }
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('姿态代理生成已取消')
}

function yieldToRenderer() {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}
