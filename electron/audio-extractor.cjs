const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { assertExistingInside, safeSegment } = require('./local-workspace.cjs')

const MAX_LOG_LENGTH = 32 * 1024

class AudioExtractor {
  constructor({ workspace, ffmpegPath = 'ffmpeg' }) {
    if (!workspace) throw new Error('workspace is required')
    this.workspace = workspace
    this.ffmpegPath = ffmpegPath
  }

  async extractVoiceSample(input) {
    const values = validateAudioExtractionInput(input)
    const project = await this.workspace.getProject(values.projectId)
    const source = await this.workspace.resolveAsset(values.projectId, values.videoAssetId)
    if (!source.asset.mimeType.startsWith('video/')) {
      throw new Error('声音样本只能从视频素材中提取')
    }

    const temporaryDirectory = path.join(project.directory, 'cache', 'audio-extractions')
    await fs.mkdir(temporaryDirectory, { recursive: true })
    await assertExistingInside(project.directory, temporaryDirectory)
    const outputName = `${safeSegment(values.outputName, 'voice-sample').slice(0, 80)}-${randomUUID().slice(0, 8)}.wav`
    const outputPath = path.join(temporaryDirectory, outputName)
    try {
      await runFfmpeg(this.ffmpegPath, [
        '-hide_banner',
        '-y',
        '-i',
        source.path,
        '-ss',
        decimal(values.startSec),
        '-t',
        decimal(values.endSec - values.startSec),
        '-map',
        '0:a:0',
        '-vn',
        '-c:a',
        'pcm_s16le',
        '-ar',
        '24000',
        '-ac',
        '1',
        outputPath,
      ])
      const [asset] = await this.workspace.importFiles(values.projectId, 'audio', [outputPath])
      if (!asset) throw new Error('声音样本写入本地项目失败')
      return asset
    } finally {
      await fs.rm(outputPath, { force: true })
    }
  }

  async extractLastVideoFrame(input) {
    return this.extractVideoFrame({ ...input, position: 'LAST' })
  }

  async extractVideoFrame(input) {
    const values = validateVideoFrameExtractionInput(input)
    const project = await this.workspace.getProject(values.projectId)
    const source = await this.workspace.resolveAsset(values.projectId, values.videoAssetId)
    if (!source.asset.mimeType.startsWith('video/')) {
      throw new Error('视频帧只能从视频素材中提取')
    }

    const temporaryDirectory = path.join(project.directory, 'cache', 'frame-extractions')
    await fs.mkdir(temporaryDirectory, { recursive: true })
    await assertExistingInside(project.directory, temporaryDirectory)
    const fallbackName = values.position === 'FIRST' ? 'start-frame' : 'end-frame'
    const outputName = `${safeSegment(values.outputName, fallbackName).slice(0, 80)}-${randomUUID().slice(0, 8)}.png`
    const outputPath = path.join(temporaryDirectory, outputName)
    try {
      const seekArguments = values.position === 'FIRST' ? [] : ['-sseof', '-1']
      const frameArguments =
        values.position === 'FIRST'
          ? ['-frames:v', '1', '-update', '1']
          : ['-fps_mode', 'passthrough', '-update', '1']
      await runFfmpeg(this.ffmpegPath, [
        '-hide_banner',
        '-y',
        ...seekArguments,
        '-i',
        source.path,
        '-map',
        '0:v:0',
        ...frameArguments,
        '-c:v',
        'png',
        outputPath,
      ])
      const [asset] = await this.workspace.importFiles(values.projectId, 'storyboards', [
        outputPath,
      ])
      if (!asset) throw new Error('视频帧图片写入本地项目失败')
      return asset
    } finally {
      await fs.rm(outputPath, { force: true })
    }
  }
}

function validateAudioExtractionInput(input) {
  if (!input || typeof input !== 'object') throw new Error('声音样本提取参数无效')
  const startSec = finiteNumber(input.startSec, '开始时间')
  const endSec = finiteNumber(input.endSec, '结束时间')
  if (startSec < 0 || endSec <= startSec) throw new Error('声音样本时间范围无效')
  if (endSec - startSec < 1 || endSec - startSec > 60) {
    throw new Error('单个声音样本时长必须是 1 到 60 秒')
  }
  return {
    projectId: requiredText(input.projectId, '项目标识', 36),
    videoAssetId: requiredText(input.videoAssetId, '视频素材', 36),
    outputName: requiredText(input.outputName, '声音样本名称', 100),
    startSec,
    endSec,
  }
}

function validateVideoFrameExtractionInput(input) {
  if (!input || typeof input !== 'object') throw new Error('视频帧提取参数无效')
  const position = input.position == null ? 'LAST' : requiredText(input.position, '帧位置', 8)
  if (!['FIRST', 'LAST'].includes(position)) throw new Error('帧位置必须是 FIRST 或 LAST')
  return {
    projectId: requiredText(input.projectId, '项目标识', 36),
    videoAssetId: requiredText(input.videoAssetId, '视频素材', 36),
    outputName: requiredText(input.outputName, '视频帧名称', 100),
    position,
  }
}

function runFfmpeg(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_LOG_LENGTH)
    })
    child.on('error', (error) => reject(new Error(`FFmpeg 启动失败：${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`音频提取失败：${lastUsefulLine(stderr)}`))
    })
  })
}

function requiredText(value, fieldName, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName}不能为空`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new Error(`${fieldName}过长`)
  return normalized
}

function finiteNumber(value, fieldName) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${fieldName}无效`)
  return number
}

function decimal(value) {
  return Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function lastUsefulLine(value) {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || '视频没有可提取的音轨'
  )
}

module.exports = { AudioExtractor, validateAudioExtractionInput, validateVideoFrameExtractionInput }
