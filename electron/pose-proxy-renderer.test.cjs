const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const sharp = require('sharp')
const { buildPoseSvg, renderPoseFrame, validatePoseProxyInput } = require('./pose-proxy-renderer.cjs')

function landmark(x = 0.5, y = 0.5, visibility = 1) {
  return { x, y, visibility }
}

function fullPose() {
  const pose = Array.from({ length: 33 }, () => landmark(0.5, 0.5, 0.2))
  pose[0] = landmark(0.5, 0.15)
  pose[7] = landmark(0.43, 0.17)
  pose[8] = landmark(0.57, 0.17)
  pose[11] = landmark(0.38, 0.3)
  pose[12] = landmark(0.62, 0.3)
  pose[13] = landmark(0.3, 0.46)
  pose[14] = landmark(0.7, 0.46)
  pose[15] = landmark(0.24, 0.62)
  pose[16] = landmark(0.76, 0.62)
  pose[17] = landmark(0.22, 0.65)
  pose[18] = landmark(0.78, 0.65)
  pose[19] = landmark(0.22, 0.66)
  pose[20] = landmark(0.78, 0.66)
  pose[21] = landmark(0.24, 0.64)
  pose[22] = landmark(0.76, 0.64)
  pose[23] = landmark(0.43, 0.55)
  pose[24] = landmark(0.57, 0.55)
  pose[25] = landmark(0.42, 0.75)
  pose[26] = landmark(0.58, 0.75)
  pose[27] = landmark(0.4, 0.92)
  pose[28] = landmark(0.6, 0.92)
  pose[29] = landmark(0.38, 0.95)
  pose[30] = landmark(0.62, 0.95)
  pose[31] = landmark(0.44, 0.96)
  pose[32] = landmark(0.56, 0.96)
  return pose
}

test('rejects empty and excessive pose proxy frames', () => {
  assert.throws(
    () =>
      validatePoseProxyInput({
        taskId: 'task_1',
        sourceWidth: 720,
        sourceHeight: 1280,
        fps: 12,
        frames: [],
      }),
    /姿态代理帧数/,
  )

  assert.throws(
    () =>
      validatePoseProxyInput({
        taskId: 'task_1',
        sourceWidth: 720,
        sourceHeight: 1280,
        fps: 12,
        frames: Array.from({ length: 451 }, () => ({ poses: [fullPose()] })),
      }),
    /姿态代理帧数/,
  )
})

test('rejects low pose detection ratio', () => {
  assert.throws(
    () =>
      validatePoseProxyInput({
        taskId: 'task_2',
        sourceWidth: 720,
        sourceHeight: 1280,
        fps: 12,
        frames: [
          { poses: [fullPose()] },
          { poses: [] },
          { poses: [] },
          { poses: [] },
        ],
      }),
    /动作识别率过低/,
  )
})

test('clamps out-of-frame landmarks instead of rejecting pose proxy frames', () => {
  const pose = fullPose()
  pose[12] = landmark(0.5, 1.6, 1)

  const result = validatePoseProxyInput({
    taskId: 'task_3',
    sourceWidth: 720,
    sourceHeight: 1280,
    fps: 12,
    frames: [{ poses: [pose] }],
  })

  assert.equal(result.frames[0].poses[0][12].y, 1)
  assert.equal(result.frames[0].poses[0][12].visibility, 0)
})

test('accepts compact human masks alongside pose landmarks', () => {
  const alpha = new Uint8Array(32 * 48)
  alpha.fill(180)

  const result = validatePoseProxyInput({
    taskId: 'task_4',
    sourceWidth: 720,
    sourceHeight: 1280,
    fps: 12,
    frames: [{ poses: [fullPose()], poseMasks: [{ width: 32, height: 48, alpha }] }],
  })

  assert.equal(result.frames[0].poseMasks.length, 1)
  assert.equal(result.frames[0].poseMasks[0].alpha.length, 32 * 48)
})

test('renders a soft grayscale depth body proxy without stick-figure skeleton lines', () => {
  const svg = buildPoseSvg(720, 1280, [fullPose()])

  assert.match(svg, /data-layer="depth-body"/)
  assert.match(svg, /data-layer="depth-limb"/)
  assert.match(svg, /data-layer="depth-torso"/)
  assert.match(svg, /data-layer="depth-head"/)
  assert.match(svg, /filter id="depthSoft"/)
  assert.match(svg, /<path /)
  assert.match(svg, /<ellipse /)
  assert.doesNotMatch(svg, /data-layer="skeleton"/)
  assert.doesNotMatch(svg, /<line /)
  assert.doesNotMatch(svg, /<text /)
})

test('renders a mask-driven frame as a grayscale human silhouette png', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pose-proxy-mask-'))
  const outputPath = path.join(directory, 'frame.png')
  const alpha = new Uint8Array(48 * 80)
  for (let y = 0; y < 80; y += 1) {
    for (let x = 0; x < 48; x += 1) {
      const dx = (x - 24) / 13
      const dy = (y - 38) / 30
      alpha[y * 48 + x] = dx * dx + dy * dy <= 1 ? 230 : 0
    }
  }

  await renderPoseFrame(360, 640, [fullPose()], [{ width: 48, height: 80, alpha }], outputPath)
  const metadata = await sharp(outputPath).metadata()

  assert.equal(metadata.width, 360)
  assert.equal(metadata.height, 640)
  await fs.rm(directory, { recursive: true, force: true })
})
