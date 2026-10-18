const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const sharp = require('sharp')

const MAX_FRAMES = 450
const MAX_POSES = 4
const MAX_LANDMARKS = 33
const MAX_MASK_WIDTH = 256
const MAX_MASK_HEIGHT = 512
const MAX_LOG_LENGTH = 32 * 1024
const VISIBILITY_THRESHOLD = 0.35
const COORDINATE_VISIBLE_MIN = -0.25
const COORDINATE_VISIBLE_MAX = 1.25
const COORDINATE_ACCEPT_MIN = -2
const COORDINATE_ACCEPT_MAX = 3
const POSE_PALETTES = [
  { fill: '#d8d8d8', edge: '#f3f4f6', shade: '#6f7780', core: '#f0f0f0' },
  { fill: '#bfc1c4', edge: '#e3e5e8', shade: '#5d646d', core: '#dedfe1' },
  { fill: '#a8abb0', edge: '#cfd3d8', shade: '#505761', core: '#c8cacf' },
  { fill: '#90949b', edge: '#b8bec5', shade: '#454c56', core: '#afb3ba' },
]

class PoseProxyRenderer {
  constructor({ appDataPath, ffmpegPath = 'ffmpeg' }) {
    if (!appDataPath) throw new Error('appDataPath is required')
    this.cacheRoot = path.join(appDataPath, 'pose-proxy-cache')
    this.ffmpegPath = ffmpegPath
    this.activeTasks = new Map()
  }

  async render(input, onProgress = () => undefined) {
    const values = validatePoseProxyInput(input)
    if (this.activeTasks.has(values.taskId)) throw new Error('姿态代理任务正在处理中')
    const task = { cancelled: false, child: null }
    this.activeTasks.set(values.taskId, task)
    await fs.mkdir(this.cacheRoot, { recursive: true })
    const taskDirectory = path.join(this.cacheRoot, values.taskId)
    const framesDirectory = path.join(taskDirectory, 'frames')
    const outputPath = path.join(taskDirectory, 'pose-proxy.mp4')
    try {
      await fs.mkdir(framesDirectory, { recursive: true })
      onProgress(progress(values.taskId, 'RENDERING', 55, '正在渲染本地骨骼动画'))
      let lastVisiblePoses = []
      let lastVisibleMasks = []
      let missingFrameCount = 0
      for (let index = 0; index < values.frames.length; index += 1) {
        assertNotCancelled(task)
        const frame = values.frames[index]
        let poses = frame.poses
        let poseMasks = frame.poseMasks
        if (poses.length) {
          lastVisiblePoses = poses
          if (poseMasks.length) lastVisibleMasks = poseMasks
          missingFrameCount = 0
        } else if (lastVisiblePoses.length && missingFrameCount < 3) {
          poses = lastVisiblePoses
          poseMasks = lastVisibleMasks
          missingFrameCount += 1
        } else {
          missingFrameCount += 1
        }
        const framePath = path.join(framesDirectory, `frame-${String(index).padStart(5, '0')}.png`)
        await renderPoseFrame(values.width, values.height, poses, poseMasks, framePath)
        if (index % 6 === 0 || index === values.frames.length - 1) {
          const frameProgress = 55 + Math.round(((index + 1) / values.frames.length) * 30)
          onProgress(progress(values.taskId, 'RENDERING', frameProgress, '正在渲染本地骨骼动画'))
        }
      }

      assertNotCancelled(task)
      onProgress(progress(values.taskId, 'ENCODING', 88, '正在编码骨骼参考视频'))
      await runFfmpeg(
        this.ffmpegPath,
        [
          '-hide_banner',
          '-y',
          '-framerate',
          String(values.fps),
          '-i',
          path.join(framesDirectory, 'frame-%05d.png'),
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          outputPath,
        ],
        task,
      )
      assertNotCancelled(task)
      const bytes = await fs.readFile(outputPath)
      onProgress(progress(values.taskId, 'SUCCEEDED', 100, '本地骨骼参考已生成'))
      return {
        taskId: values.taskId,
        fileName: `pose-proxy-${values.taskId.slice(0, 8)}.mp4`,
        mimeType: 'video/mp4',
        bytes,
        width: values.width,
        height: values.height,
        fps: values.fps,
        durationSec: values.frames.length / values.fps,
        detectedFrameRatio: values.detectedFrameRatio,
      }
    } finally {
      this.activeTasks.delete(values.taskId)
      await fs.rm(taskDirectory, { recursive: true, force: true })
    }
  }

  cancel(taskId) {
    const task = this.activeTasks.get(String(taskId || ''))
    if (!task) return false
    task.cancelled = true
    if (task.child && !task.child.killed) task.child.kill()
    return true
  }
}

function validatePoseProxyInput(input) {
  if (!input || typeof input !== 'object') throw new Error('姿态代理参数无效')
  const taskId = requiredText(input.taskId, '姿态代理任务标识', 80)
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error('姿态代理任务标识格式无效')
  const sourceWidth = boundedInteger(input.sourceWidth, '原视频宽度', 64, 8192)
  const sourceHeight = boundedInteger(input.sourceHeight, '原视频高度', 64, 8192)
  const fps = boundedInteger(input.fps, '采样帧率', 6, 15)
  if (!Array.isArray(input.frames) || !input.frames.length || input.frames.length > MAX_FRAMES) {
    throw new Error(`姿态代理帧数必须是 1 到 ${MAX_FRAMES}`)
  }
  const frames = input.frames.map((frame, frameIndex) => validateFrame(frame, frameIndex))
  const outputSize = resolveOutputSize(sourceWidth, sourceHeight)
  const detectedFrameCount = frames.filter((frame) => frame.poses.length > 0).length
  const detectedFrameRatio = detectedFrameCount / frames.length
  if (detectedFrameRatio < 0.35) {
    throw new Error('动作识别率过低，请换用人物全身更清晰、遮挡更少的视频')
  }
  return {
    taskId,
    width: outputSize.width,
    height: outputSize.height,
    fps,
    frames,
    detectedFrameRatio,
  }
}

function validateFrame(frame, frameIndex) {
  if (!frame || typeof frame !== 'object' || !Array.isArray(frame.poses)) {
    throw new Error(`第 ${frameIndex + 1} 帧姿态数据无效`)
  }
  if (frame.poses.length > MAX_POSES) throw new Error(`单帧最多支持 ${MAX_POSES} 个人物`)
  return {
    poses: frame.poses.map((pose, poseIndex) => {
      if (!Array.isArray(pose) || pose.length !== MAX_LANDMARKS) {
        throw new Error(`第 ${frameIndex + 1} 帧第 ${poseIndex + 1} 个人物关键点无效`)
      }
      return pose.map((landmark) => validateLandmark(landmark))
    }),
    poseMasks: Array.isArray(frame.poseMasks)
      ? frame.poseMasks.slice(0, MAX_POSES).map((mask) => validatePoseMask(mask, frameIndex))
      : [],
  }
}

function validatePoseMask(mask, frameIndex) {
  if (!mask || typeof mask !== 'object') throw new Error(`第 ${frameIndex + 1} 帧人体蒙版无效`)
  const width = boundedInteger(mask.width, '人体蒙版宽度', 8, MAX_MASK_WIDTH)
  const height = boundedInteger(mask.height, '人体蒙版高度', 8, MAX_MASK_HEIGHT)
  const alpha = normalizeMaskAlpha(mask.alpha)
  if (alpha.length !== width * height) throw new Error(`第 ${frameIndex + 1} 帧人体蒙版尺寸不匹配`)
  return { width, height, alpha }
}

function normalizeMaskAlpha(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value)) return Uint8Array.from(value)
  throw new Error('人体蒙版数据无效')
}

function validateLandmark(landmark) {
  if (!landmark || typeof landmark !== 'object') throw new Error('姿态关键点无效')
  const x = boundedNumber(landmark.x, '关键点横坐标', COORDINATE_ACCEPT_MIN, COORDINATE_ACCEPT_MAX)
  const y = boundedNumber(landmark.y, '关键点纵坐标', COORDINATE_ACCEPT_MIN, COORDINATE_ACCEPT_MAX)
  const visibility = boundedNumber(landmark.visibility ?? 1, '关键点可见度', 0, 1)
  const offscreen =
    x < COORDINATE_VISIBLE_MIN ||
    x > COORDINATE_VISIBLE_MAX ||
    y < COORDINATE_VISIBLE_MIN ||
    y > COORDINATE_VISIBLE_MAX
  return {
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    visibility: offscreen ? 0 : visibility,
  }
}

function buildPoseSvg(width, height, poses) {
  const body = [
    `<defs>
      <filter id="depthSoft" x="-15%" y="-15%" width="130%" height="130%">
        <feGaussianBlur stdDeviation="6"/>
      </filter>
      <filter id="depthGlow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="10"/>
      </filter>
    </defs>`,
    `<rect width="${width}" height="${height}" fill="#06080a"/>`,
  ]
  poses.forEach((pose, poseIndex) => {
    const palette = POSE_PALETTES[poseIndex] || POSE_PALETTES.at(-1)
    const scale = poseScale(pose, width, height)
    appendBodySilhouette(body, pose, width, height, scale, palette)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body.join('')}</svg>`
}

async function renderPoseFrame(width, height, poses, poseMasks = [], framePath) {
  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: '#06080a',
    },
  })
  const validMasks = poseMasks.filter((mask) => mask?.alpha?.length === mask.width * mask.height)
  if (!validMasks.length) {
    await sharp(Buffer.from(buildPoseSvg(width, height, poses))).png({ compressionLevel: 2 }).toFile(framePath)
    return
  }
  const composites = []
  validMasks.slice(0, MAX_POSES).forEach((mask, index) => {
    const palette = POSE_PALETTES[index] || POSE_PALETTES.at(-1)
    composites.push(
      {
        input: maskToRgba(mask, palette, { glow: true }),
        raw: { width: mask.width, height: mask.height, channels: 4 },
        blur: 8,
        top: 0,
        left: 0,
        blend: 'over',
      },
      {
        input: maskToRgba(mask, palette, { glow: false }),
        raw: { width: mask.width, height: mask.height, channels: 4 },
        blur: 1,
        top: 0,
        left: 0,
        blend: 'over',
      },
    )
  })
  const layers = await Promise.all(
    composites.map(async (item) => ({
      input: await sharp(item.input, { raw: item.raw })
        .resize(width, height, { fit: 'fill' })
        .blur(item.blur)
        .png()
        .toBuffer(),
      top: item.top,
      left: item.left,
      blend: item.blend,
    })),
  )
  await base
    .composite(layers)
    .png({ compressionLevel: 2 })
    .toFile(framePath)
}

function maskToRgba(mask, palette, options) {
  const rgba = Buffer.alloc(mask.width * mask.height * 4)
  const fill = hexToRgb(options.glow ? palette.shade : palette.fill)
  const edge = hexToRgb(options.glow ? palette.shade : palette.edge)
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x
      const confidence = mask.alpha[index] / 255
      const shaped = options.glow ? Math.pow(confidence, 0.72) : smoothMaskConfidence(confidence)
      const neighborDelta = options.glow ? 0 : maskEdgeStrength(mask, x, y)
      const shade = Math.max(0, Math.min(1, 0.82 + y / mask.height * 0.16 - neighborDelta * 0.28))
      const edgeMix = Math.min(1, neighborDelta * 2.4)
      const r = Math.round(mix(fill.r, edge.r, edgeMix) * shade)
      const g = Math.round(mix(fill.g, edge.g, edgeMix) * shade)
      const b = Math.round(mix(fill.b, edge.b, edgeMix) * shade)
      const offset = index * 4
      rgba[offset] = r
      rgba[offset + 1] = g
      rgba[offset + 2] = b
      rgba[offset + 3] = Math.round(shaped * (options.glow ? 118 : 245))
    }
  }
  return rgba
}

function smoothMaskConfidence(value) {
  const normalized = clamp((value - 0.16) / 0.58, 0, 1)
  return normalized * normalized * (3 - 2 * normalized)
}

function maskEdgeStrength(mask, x, y) {
  const center = mask.alpha[y * mask.width + x] / 255
  if (center <= 0.08) return 0
  const left = mask.alpha[y * mask.width + Math.max(0, x - 1)] / 255
  const right = mask.alpha[y * mask.width + Math.min(mask.width - 1, x + 1)] / 255
  const top = mask.alpha[Math.max(0, y - 1) * mask.width + x] / 255
  const bottom = mask.alpha[Math.min(mask.height - 1, y + 1) * mask.width + x] / 255
  return Math.max(Math.abs(center - left), Math.abs(center - right), Math.abs(center - top), Math.abs(center - bottom))
}

function hexToRgb(value) {
  const normalized = value.replace('#', '')
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  }
}

function mix(left, right, amount) {
  return left + (right - left) * amount
}

function appendBodySilhouette(output, pose, width, height, scale, palette) {
  output.push(`<g data-layer="depth-shadow" filter="url(#depthGlow)" opacity="0.58">`)
  appendLimbSet(output, pose, width, height, scale, {
    fill: palette.shade,
    edge: palette.shade,
    opacity: 0.55,
    widthMultiplier: 1.2,
  })
  appendTorso(output, pose, width, height, scale, {
    fill: palette.shade,
    edge: palette.shade,
    opacity: 0.5,
    expansion: 1.28,
  })
  appendHead(output, pose, width, height, scale, {
    fill: palette.shade,
    edge: palette.shade,
    opacity: 0.5,
    expansion: 1.18,
  })
  output.push('</g>')

  output.push(`<g data-layer="depth-body">`)
  appendLimbSet(output, pose, width, height, scale, {
    fill: palette.fill,
    edge: palette.edge,
    opacity: 0.96,
    widthMultiplier: 1,
  })
  appendTorso(output, pose, width, height, scale, {
    fill: palette.fill,
    edge: palette.edge,
    opacity: 0.98,
    expansion: 1,
  })
  appendHead(output, pose, width, height, scale, {
    fill: palette.core,
    edge: palette.edge,
    opacity: 0.98,
    expansion: 1,
  })
  appendDepthHighlights(output, pose, width, height, scale, palette)
  output.push('</g>')
}

function appendLimbSet(output, pose, width, height, scale, style) {
  const limbSegments = [
    [11, 13, 0.36, 0.31],
    [13, 15, 0.31, 0.24],
    [12, 14, 0.36, 0.31],
    [14, 16, 0.31, 0.24],
    [23, 25, 0.5, 0.42],
    [25, 27, 0.42, 0.32],
    [24, 26, 0.5, 0.42],
    [26, 28, 0.42, 0.32],
    [15, 19, 0.22, 0.18],
    [16, 20, 0.22, 0.18],
    [27, 31, 0.3, 0.24],
    [28, 32, 0.3, 0.24],
  ]
  for (const [startIndex, endIndex, startFactor, endFactor] of limbSegments) {
    const start = pose[startIndex]
    const end = pose[endIndex]
    if (!visible(start) || !visible(end)) continue
    const pathData = capsulePath(
      start,
      end,
      width,
      height,
      Math.max(7, Math.round(scale * startFactor * style.widthMultiplier)),
      Math.max(6, Math.round(scale * endFactor * style.widthMultiplier)),
    )
    if (!pathData) continue
    output.push(
      `<path data-layer="depth-limb" d="${pathData}" fill="${style.fill}" stroke="${style.edge}" stroke-width="${Math.max(1, Math.round(scale * 0.022))}" stroke-linejoin="round" opacity="${style.opacity}"/>`,
    )
  }

  for (const index of [15, 16, 27, 28]) {
    const landmark = pose[index]
    if (!visible(landmark)) continue
    output.push(
      `<ellipse data-layer="depth-endcap" cx="${pixel(landmark.x, width)}" cy="${pixel(landmark.y, height)}" rx="${Math.round(scale * 0.2 * style.widthMultiplier)}" ry="${Math.round(scale * 0.15 * style.widthMultiplier)}" fill="${style.fill}" opacity="${style.opacity}"/>`,
    )
  }
}

function appendTorso(output, pose, width, height, scale, style) {
  const torso = torsoPoints(pose, width, height, style.expansion)
  if (torso) {
    output.push(
      `<path data-layer="depth-torso" d="${smoothClosedPath(torso)}" fill="${style.fill}" stroke="${style.edge}" stroke-width="${Math.max(2, Math.round(scale * 0.035))}" stroke-linejoin="round" opacity="${style.opacity}"/>`,
    )
  }
}

function appendHead(output, pose, width, height, scale, style) {
  const head = headShape(pose, width, height, scale, style.expansion)
  if (head) {
    const shoulderCenter = midpoint(pose[11], pose[12])
    if (shoulderCenter) {
      const neckPath = capsulePath(
        { x: head.cx / width, y: (head.cy + head.ry * 0.58) / height, visibility: 1 },
        shoulderCenter,
        width,
        height,
        Math.max(7, Math.round(scale * 0.18 * style.expansion)),
        Math.max(8, Math.round(scale * 0.28 * style.expansion)),
      )
      if (neckPath) {
        output.push(
          `<path data-layer="depth-neck" d="${neckPath}" fill="${style.fill}" opacity="${style.opacity}" />`,
        )
      }
    }
    output.push(
      `<ellipse data-layer="depth-head" cx="${head.cx}" cy="${head.cy}" rx="${head.rx}" ry="${head.ry}" fill="${style.fill}" stroke="${style.edge}" stroke-width="${Math.max(2, Math.round(scale * 0.035))}" opacity="${style.opacity}"/>`,
    )
  }
}

function appendDepthHighlights(output, pose, width, height, scale, palette) {
  const torso = torsoPoints(pose, width, height, 0.72)
  if (torso) {
    const center = polygonCenter(torso)
    const shoulderCenter = midpoint(pose[11], pose[12])
    const hipCenter = midpoint(pose[23], pose[24])
    const angle = shoulderCenter && hipCenter ? segmentAngle(shoulderCenter, hipCenter) : 0
    output.push(
      `<ellipse data-layer="depth-highlight" cx="${center.x}" cy="${center.y}" rx="${Math.round(scale * 0.34)}" ry="${Math.round(scale * 0.62)}" fill="${palette.core}" opacity="0.22" transform="rotate(${angle} ${center.x} ${center.y})" filter="url(#depthSoft)"/>`,
    )
  }
  for (const index of [13, 14, 25, 26]) {
    const landmark = pose[index]
    if (!visible(landmark)) continue
    output.push(
      `<circle data-layer="depth-joint-volume" cx="${pixel(landmark.x, width)}" cy="${pixel(landmark.y, height)}" r="${Math.round(scale * 0.18)}" fill="${palette.core}" opacity="0.2" filter="url(#depthSoft)"/>`,
    )
  }
}

function capsulePath(start, end, width, height, startRadius, endRadius) {
  const startPoint = { x: pixel(start.x, width), y: pixel(start.y, height) }
  const endPoint = { x: pixel(end.x, width), y: pixel(end.y, height) }
  const dx = endPoint.x - startPoint.x
  const dy = endPoint.y - startPoint.y
  const length = Math.hypot(dx, dy)
  if (length < 1) return ''
  const nx = -dy / length
  const ny = dx / length
  const s1 = { x: startPoint.x + nx * startRadius, y: startPoint.y + ny * startRadius }
  const s2 = { x: startPoint.x - nx * startRadius, y: startPoint.y - ny * startRadius }
  const e1 = { x: endPoint.x + nx * endRadius, y: endPoint.y + ny * endRadius }
  const e2 = { x: endPoint.x - nx * endRadius, y: endPoint.y - ny * endRadius }
  return [
    `M ${roundPoint(s1)}`,
    `L ${roundPoint(e1)}`,
    `Q ${roundPoint(endPoint)} ${roundPoint(e2)}`,
    `L ${roundPoint(s2)}`,
    `Q ${roundPoint(startPoint)} ${roundPoint(s1)}`,
    'Z',
  ].join(' ')
}

function roundPoint(point) {
  return `${Math.round(point.x)} ${Math.round(point.y)}`
}

function smoothClosedPath(points) {
  if (points.length < 3) return ''
  const [first, ...rest] = points
  const commands = [`M ${roundPoint(first)}`]
  for (const point of rest) commands.push(`L ${roundPoint(point)}`)
  commands.push('Z')
  return commands.join(' ')
}

function segmentAngle(start, end) {
  return (Math.atan2((end.y - start.y), (end.x - start.x)) * 180) / Math.PI - 90
}

function polygonCenter(points) {
  return {
    x: Math.round(points.reduce((sum, point) => sum + point.x, 0) / points.length),
    y: Math.round(points.reduce((sum, point) => sum + point.y, 0) / points.length),
  }
}

function torsoPoints(pose, width, height, expansion = 1) {
  const landmarks = [pose[11], pose[12], pose[24], pose[23]]
  if (!landmarks.every(visible)) return null
  const points = landmarks.map((landmark) => ({
    x: pixel(landmark.x, width),
    y: pixel(landmark.y, height),
  }))
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
  return points.map((point) => ({
    x: Math.round(center.x + (point.x - center.x) * 1.24 * expansion),
    y: Math.round(center.y + (point.y - center.y) * 1.14 * expansion),
  }))
}

function poseScale(pose, width, height) {
  const minimum = Math.min(width, height)
  const shoulder = landmarkDistance(pose[11], pose[12], width, height)
  const hip = landmarkDistance(pose[23], pose[24], width, height)
  const torsoLength = landmarkDistance(midpoint(pose[11], pose[12]), midpoint(pose[23], pose[24]), width, height)
  return clamp(Math.max(shoulder, hip, torsoLength * 0.46, minimum * 0.085), minimum * 0.07, minimum * 0.28)
}

function landmarkDistance(left, right, width, height) {
  if (!visible(left) || !visible(right)) return 0
  return Math.hypot((left.x - right.x) * width, (left.y - right.y) * height)
}

function headShape(pose, width, height, scale, expansion = 1) {
  const center = headCenter(pose)
  if (!center) return null
  const earWidth = landmarkDistance(pose[7], pose[8], width, height)
  const faceBounds = landmarkBounds(pose.slice(0, 11), width, height)
  const faceWidth = faceBounds ? faceBounds.width : 0
  const faceHeight = faceBounds ? faceBounds.height : 0
  const rx = Math.round(Math.max(scale * 0.42, earWidth * 0.76, faceWidth * 0.62) * expansion)
  return {
    cx: pixel(center.x, width),
    cy: pixel(center.y, height),
    rx,
    ry: Math.round(Math.max(scale * 0.54, faceHeight * 0.74, rx * 1.2) * expansion),
  }
}

function landmarkBounds(landmarks, width, height) {
  const points = landmarks
    .filter(visible)
    .map((landmark) => ({ x: pixel(landmark.x, width), y: pixel(landmark.y, height) }))
  if (!points.length) return null
  const left = Math.min(...points.map((point) => point.x))
  const right = Math.max(...points.map((point) => point.x))
  const top = Math.min(...points.map((point) => point.y))
  const bottom = Math.max(...points.map((point) => point.y))
  return { width: right - left, height: bottom - top }
}

function midpoint(left, right) {
  if (!visible(left) || !visible(right)) return null
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }
}

function headCenter(pose) {
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (visible(leftEar) && visible(rightEar)) {
    return { x: (leftEar.x + rightEar.x) / 2, y: (leftEar.y + rightEar.y) / 2 }
  }
  const nose = pose[0]
  return visible(nose) ? nose : null
}

function visible(landmark) {
  return landmark && landmark.visibility >= VISIBILITY_THRESHOLD
}

function pixel(value, size) {
  return Math.round(Math.max(0, Math.min(1, value)) * size)
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function resolveOutputSize(sourceWidth, sourceHeight) {
  const aspectRatio = sourceWidth / sourceHeight
  if (aspectRatio >= 1) {
    return { width: 1280, height: even(Math.round(1280 / aspectRatio)) }
  }
  return { width: even(Math.round(1280 * aspectRatio)), height: 1280 }
}

function even(value) {
  const bounded = Math.max(360, Math.min(1280, value))
  return bounded % 2 === 0 ? bounded : bounded - 1
}

function runFfmpeg(executable, args, task) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    task.child = child
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_LOG_LENGTH)
    })
    child.on('error', (error) => reject(new Error(`FFmpeg 启动失败：${error.message}`)))
    child.on('close', (code) => {
      task.child = null
      if (task.cancelled) reject(new Error('姿态代理生成已取消'))
      else if (code === 0) resolve()
      else reject(new Error(`骨骼视频编码失败：${lastUsefulLine(stderr)}`))
    })
  })
}

function assertNotCancelled(task) {
  if (task.cancelled) throw new Error('姿态代理生成已取消')
}

function progress(taskId, stage, value, message) {
  return { taskId, stage, progress: value, message }
}

function requiredText(value, fieldName, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName}不能为空`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new Error(`${fieldName}过长`)
  return normalized
}

function boundedInteger(value, fieldName, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${fieldName}必须是 ${minimum} 到 ${maximum} 的整数`)
  }
  return number
}

function boundedNumber(value, fieldName, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${fieldName}超出允许范围`)
  }
  return number
}

function lastUsefulLine(value) {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || 'FFmpeg 未返回错误详情'
  )
}

module.exports = { PoseProxyRenderer, buildPoseSvg, renderPoseFrame, validatePoseProxyInput }
