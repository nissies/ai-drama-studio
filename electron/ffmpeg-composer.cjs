const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const { assertExistingInside, safeSegment } = require('./local-workspace.cjs')

const EXPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
const MAX_SHOTS = 200
const MAX_LOG_LENGTH = 32 * 1024
const AI_DUB_NATIVE_AUDIO_VOLUME = 0.55
const execFileAsync = promisify(execFile)

class FfmpegComposer {
  constructor({ workspace, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' }) {
    if (!workspace) throw new Error('workspace is required')
    this.workspace = workspace
    this.ffmpegPath = ffmpegPath
    this.ffprobePath = ffprobePath
    this.jobs = new Map()
  }

  async compose(input, onProgress = () => undefined) {
    const values = validateInput(input)
    if (this.jobs.has(values.exportId)) throw new Error('该导出任务正在运行')
    const state = { canceled: false, child: null }
    this.jobs.set(values.exportId, state)
    try {
      const project = await this.workspace.getProject(values.projectId)
      const jobDirectory = path.join(project.directory, 'cache', 'exports', values.exportId)
      await fs.mkdir(jobDirectory, { recursive: true })
      await assertExistingInside(project.directory, jobDirectory)
      const shots = []
      for (let index = 0; index < values.shots.length; index += 1) {
        assertNotCanceled(state)
        const shot = await this.resolveShot(values, values.shots[index])
        const outputName = `shot-${String(index + 1).padStart(3, '0')}.mp4`
        const outputPath = path.join(jobDirectory, outputName)
        const fingerprint = shotFingerprint(shot, values)
        const manifestPath = path.join(jobDirectory, `${outputName}.json`)
        if (!(await isReusableShot(outputPath, manifestPath, fingerprint))) {
          await this.renderShot(
            shot,
            values,
            jobDirectory,
            outputPath,
            state,
            (fraction) => {
              const progress = Math.min(
                94,
                Math.round(((index + fraction) / values.shots.length) * 94),
              )
              onProgress({ exportId: values.exportId, stage: 'RENDERING', progress, shotNo: shot.shotNo })
            },
          )
          await writeJsonAtomic(manifestPath, { fingerprint, completedAt: new Date().toISOString() })
        }
        shots.push(outputName)
        onProgress({
          exportId: values.exportId,
          stage: 'RENDERING',
          progress: Math.min(94, Math.round(((index + 1) / values.shots.length) * 94)),
          shotNo: shot.shotNo,
        })
      }

      assertNotCanceled(state)
      onProgress({ exportId: values.exportId, stage: 'CONCATENATING', progress: 95, shotNo: null })
      const concatPath = path.join(jobDirectory, 'concat.txt')
      await fs.writeFile(concatPath, `${shots.map((name) => `file '${name}'`).join('\n')}\n`, 'utf8')
      const temporaryExport = path.join(jobDirectory, `${values.outputName}.partial.mp4`)
      const completedExport = path.join(jobDirectory, `${values.outputName}.mp4`)
      await fs.rm(temporaryExport, { force: true })
      await runFfmpeg(
        this.ffmpegPath,
        ['-hide_banner', '-y', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', path.basename(temporaryExport)],
        { cwd: jobDirectory, state, expectedDurationMs: totalDuration(values.shots), onProgress: () => undefined },
      )
      await fs.rm(completedExport, { force: true })
      await fs.rename(temporaryExport, completedExport)
      const [asset] = await this.workspace.importFiles(values.projectId, 'exports', [completedExport])
      onProgress({ exportId: values.exportId, stage: 'SUCCEEDED', progress: 100, shotNo: null })
      return { exportId: values.exportId, asset }
    } catch (error) {
      if (state.canceled) throw new Error('导出已取消')
      throw error
    } finally {
      this.jobs.delete(values.exportId)
    }
  }

  cancel(exportId) {
    const state = this.jobs.get(exportId)
    if (!state) return false
    state.canceled = true
    if (state.child && !state.child.killed) state.child.kill()
    return true
  }

  async resolveShot(values, shot) {
    const visual = await this.workspace.resolveAsset(values.projectId, shot.visualAssetId)
    const expectedVisualType = shot.visualType === 'VIDEO' ? 'video/' : 'image/'
    if (!visual.asset.mimeType.startsWith(expectedVisualType)) {
      throw new Error(`镜头 ${shot.shotNo} 的画面素材类型不匹配`)
    }
    const nativeAudio =
      shot.visualType === 'VIDEO' &&
      (await hasAudioStream(this.ffprobePath, visual.path))
    return {
      ...shot,
      visual,
      nativeAudio,
      voice:
        shot.audioMode === 'AI_DUB'
          ? await this.resolveOptionalAudio(values.projectId, shot.voiceAssetId, shot.shotNo)
          : null,
      bgm: await this.resolveOptionalAudio(values.projectId, shot.bgmAssetId, shot.shotNo),
      sfx: await this.resolveOptionalAudio(values.projectId, shot.sfxAssetId, shot.shotNo),
    }
  }

  async resolveOptionalAudio(projectId, assetId, shotNo) {
    if (!assetId) return null
    const resolved = await this.workspace.resolveAsset(projectId, assetId)
    if (!resolved.asset.mimeType.startsWith('audio/')) {
      throw new Error(`镜头 ${shotNo} 的音频素材类型不匹配`)
    }
    return resolved
  }

  async renderShot(shot, values, jobDirectory, outputPath, state, onProgress) {
    const duration = decimal(shot.durationSec)
    const args = ['-hide_banner', '-y']
    if (shot.visualType === 'IMAGE') {
      args.push('-loop', '1', '-framerate', String(values.fps), '-t', duration, '-i', shot.visual.path)
    } else {
      args.push('-i', shot.visual.path)
    }
    args.push('-f', 'lavfi', '-t', duration, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
    const audioInputs = []
    for (const [kind, resolved] of [
      ['voice', shot.voice],
      ['bgm', shot.bgm],
      ['sfx', shot.sfx],
    ]) {
      if (!resolved) continue
      if (kind === 'bgm') args.push('-stream_loop', '-1')
      args.push('-i', resolved.path)
      audioInputs.push({ kind, index: audioInputs.length + 2 })
    }

    const videoFilters = [
      ...(shot.visualType === 'VIDEO'
        ? [`tpad=stop_mode=clone:stop_duration=${duration}`, `trim=duration=${duration}`]
        : [`trim=duration=${duration}`]),
      'setpts=PTS-STARTPTS',
      `scale=${values.width}:${values.height}:force_original_aspect_ratio=decrease`,
      `pad=${values.width}:${values.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `fps=${values.fps}`,
    ]
    if (values.subtitles && shot.subtitle) {
      const subtitlePath = path.join(jobDirectory, `subtitle-${String(shot.shotNo).padStart(3, '0')}.srt`)
      await fs.writeFile(subtitlePath, subtitleFile(shot.subtitle, shot.durationSec), 'utf8')
      videoFilters.push(
        `subtitles=filename='${escapeFilterPath(subtitlePath)}':force_style='FontName=Microsoft YaHei,FontSize=18,Alignment=2,MarginV=120,Outline=2,Shadow=0'`,
      )
    }
    const filterLines = [`[0:v]${videoFilters.join(',')}[video]`, `[1:a]atrim=duration=${duration},asetpts=PTS-STARTPTS[silence]`]
    const mixLabels = ['[silence]']
    if (shot.nativeAudio) {
      const nativeVolume = nativeAudioVolume(shot.audioMode)
      filterLines.push(
        `[0:a]aresample=48000,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${nativeVolume}[native]`,
      )
      mixLabels.push('[native]')
    }
    for (const audio of audioInputs) {
      const volume = audio.kind === 'bgm' ? values.bgmVolume : audio.kind === 'sfx' ? values.sfxVolume : 1
      filterLines.push(
        `[${audio.index}:a]aresample=48000,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${decimal(volume)}[${audio.kind}]`,
      )
      mixLabels.push(`[${audio.kind}]`)
    }
    filterLines.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,atrim=duration=${duration},aresample=48000[audio]`,
    )
    const filterPath = path.join(jobDirectory, `filter-${String(shot.shotNo).padStart(3, '0')}.txt`)
    await fs.writeFile(filterPath, `${filterLines.join(';\n')}\n`, 'utf8')
    const temporary = `${outputPath}.${randomUUID()}.partial.mp4`
    await fs.rm(temporary, { force: true })
    try {
      args.push(
        '-filter_complex_script',
        filterPath,
        '-map',
        '[video]',
        '-map',
        '[audio]',
        '-t',
        duration,
        '-c:v',
        'libx264',
        '-preset',
        values.preset,
        '-crf',
        String(values.crf),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        temporary,
      )
      await runFfmpeg(this.ffmpegPath, args, {
        state,
        expectedDurationMs: shot.durationSec * 1000,
        onProgress,
      })
      await fs.rm(outputPath, { force: true })
      await fs.rename(temporary, outputPath)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
}

function runFfmpeg(executable, args, options) {
  return new Promise((resolve, reject) => {
    assertNotCanceled(options.state)
    const child = spawn(executable, [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args.at(-1)], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    options.state.child = child
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() || ''
      for (const line of lines) {
        const match = /^out_time_(?:ms|us)=(\d+)$/.exec(line)
        if (!match) continue
        const microseconds = Number(match[1])
        const fraction = Math.max(0, Math.min(1, microseconds / 1000 / options.expectedDurationMs))
        options.onProgress(fraction)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_LOG_LENGTH)
    })
    child.on('error', (error) => reject(new Error(`FFmpeg 启动失败：${error.message}`)))
    child.on('close', (code) => {
      options.state.child = null
      if (options.state.canceled) {
        reject(new Error('导出已取消'))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`FFmpeg 执行失败（退出码 ${code}）：${lastUsefulLine(stderr)}`))
      }
    })
  })
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('导出参数无效')
  const exportId = requiredText(input.exportId, '导出标识', 120)
  if (!EXPORT_ID_PATTERN.test(exportId)) throw new Error('导出标识格式无效')
  const shots = Array.isArray(input.shots) ? input.shots.map(validateShot) : []
  if (!shots.length || shots.length > MAX_SHOTS) throw new Error('导出镜头数量超出允许范围')
  return {
    exportId,
    projectId: requiredText(input.projectId, '项目标识', 36),
    episodeId: requiredText(input.episodeId, '分集标识', 36),
    outputName: safeSegment(requiredText(input.outputName, '输出文件名', 120), 'episode-export').slice(0, 100),
    width: integer(input.width, 1080, 360, 2160, '导出宽度'),
    height: integer(input.height, 1920, 640, 3840, '导出高度'),
    fps: integer(input.fps, 30, 20, 60, '导出帧率'),
    crf: integer(input.crf, 18, 14, 30, '导出质量'),
    preset: ['veryfast', 'faster', 'fast', 'medium', 'slow'].includes(input.preset) ? input.preset : 'medium',
    subtitles: input.subtitles !== false,
    bgmVolume: decimalInRange(input.bgmVolume, 0.18, 0, 1, '背景音乐音量'),
    sfxVolume: decimalInRange(input.sfxVolume, 0.7, 0, 2, '音效音量'),
    shots,
  }
}

function validateShot(shot, index) {
  if (!shot || typeof shot !== 'object') throw new Error(`第 ${index + 1} 个镜头参数无效`)
  const visualType = requiredText(shot.visualType, '画面类型', 16).toUpperCase()
  if (!['IMAGE', 'VIDEO'].includes(visualType)) throw new Error(`镜头 ${index + 1} 画面类型无效`)
  return {
    storyboardId: requiredText(shot.storyboardId, '分镜标识', 36),
    shotNo: integer(shot.shotNo, index + 1, 1, MAX_SHOTS, '镜头序号'),
    durationSec: decimalInRange(shot.durationSec, null, 1, 300, '镜头时长'),
    visualType,
    visualAssetId: requiredText(shot.visualAssetId, '画面素材', 36),
    audioMode: normalizeAudioMode(shot.audioMode),
    voiceAssetId: optionalId(shot.voiceAssetId),
    bgmAssetId: optionalId(shot.bgmAssetId),
    sfxAssetId: optionalId(shot.sfxAssetId),
    subtitle: optionalText(shot.subtitle, 10_000),
  }
}

function shotFingerprint(shot, values) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        storyboardId: shot.storyboardId,
        durationSec: shot.durationSec,
        visual: shot.visual.asset.sha256,
        audioMode: shot.audioMode,
        voice: shot.voice?.asset.sha256,
        bgm: shot.bgm?.asset.sha256,
        sfx: shot.sfx?.asset.sha256,
        subtitle: values.subtitles ? shot.subtitle : null,
        width: values.width,
        height: values.height,
        fps: values.fps,
        crf: values.crf,
        preset: values.preset,
        bgmVolume: values.bgmVolume,
        sfxVolume: values.sfxVolume,
      }),
    )
    .digest('hex')
}

async function isReusableShot(outputPath, manifestPath, fingerprint) {
  try {
    const [stat, manifest] = await Promise.all([
      fs.stat(outputPath),
      fs.readFile(manifestPath, 'utf8').then(JSON.parse),
    ])
    return stat.isFile() && stat.size > 0 && manifest.fingerprint === fingerprint
  } catch {
    return false
  }
}

function subtitleFile(text, durationSec) {
  return `1\n00:00:00,000 --> ${srtTime(durationSec)}\n${String(text).replace(/\r?\n/g, '\n')}\n`
}

function srtTime(seconds) {
  const milliseconds = Math.max(1, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const secs = Math.floor((milliseconds % 60_000) / 1000)
  const millis = milliseconds % 1000
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${String(millis).padStart(3, '0')}`
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function escapeFilterPath(value) {
  return value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

function totalDuration(shots) {
  return shots.reduce((sum, shot) => sum + shot.durationSec * 1000, 0)
}

function assertNotCanceled(state) {
  if (state.canceled) throw new Error('导出已取消')
}

function lastUsefulLine(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || '未返回错误详情'
}

function requiredText(value, fieldName, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName}不能为空`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new Error(`${fieldName}过长`)
  return normalized
}

function optionalText(value, maximum) {
  if (value == null || value === '') return null
  const normalized = String(value).trim()
  if (!normalized) return null
  if (normalized.length > maximum) throw new Error('文本内容过长')
  return normalized
}

function optionalId(value) {
  return value == null || value === '' ? null : requiredText(value, '素材标识', 36)
}

function normalizeAudioMode(value) {
  const normalized = value == null || value === '' ? 'AI_DUB' : String(value).trim().toUpperCase()
  if (!['AI_DUB', 'VIDEO_NATIVE'].includes(normalized)) {
    throw new Error('镜头声音制作方式无效')
  }
  return normalized
}

async function hasAudioStream(executable, filePath) {
  try {
    const { stdout } = await execFileAsync(
      executable,
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        filePath,
      ],
      { timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 },
    )
    return Boolean(stdout.trim())
  } catch (error) {
    throw new Error(`无法检查视频原声音轨：${error.message}`)
  }
}

function integer(value, fallback, minimum, maximum, fieldName) {
  const number = value == null ? fallback : Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${fieldName}超出允许范围`)
  return number
}

function decimalInRange(value, fallback, minimum, maximum, fieldName) {
  const number = value == null ? fallback : Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${fieldName}超出允许范围`)
  return number
}

function decimal(value) {
  return Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function nativeAudioVolume(audioMode) {
  return audioMode === 'AI_DUB' ? AI_DUB_NATIVE_AUDIO_VOLUME : 1
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    await fs.rename(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

module.exports = {
  FfmpegComposer,
  validateInput,
  escapeFilterPath,
  nativeAudioVolume,
  subtitleFile,
}
