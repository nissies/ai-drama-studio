const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  escapeFilterPath,
  nativeAudioVolume,
  subtitleFile,
  validateInput,
} = require('./ffmpeg-composer.cjs')

test('validates a bounded, resumable episode export request', () => {
  const result = validateInput({
    exportId: 'export-123',
    projectId: 'project-1',
    episodeId: 'episode-1',
    outputName: '第一集.mp4',
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 18,
    preset: 'medium',
    subtitles: true,
    bgmVolume: 0.18,
    sfxVolume: 0.7,
    shots: [
      {
        storyboardId: 'shot-1',
        shotNo: 1,
        durationSec: 5,
        visualType: 'VIDEO',
        visualAssetId: 'video-1',
        audioMode: 'VIDEO_NATIVE',
        subtitle: '快跑！',
      },
    ],
  })

  assert.equal(result.outputName, '第一集.mp4')
  assert.equal(result.shots[0].visualType, 'VIDEO')
  assert.equal(result.shots[0].durationSec, 5)
  assert.equal(result.shots[0].audioMode, 'VIDEO_NATIVE')
})

test('defaults legacy export requests to dedicated AI dubbing', () => {
  const result = validateInput({
    exportId: 'export-legacy',
    projectId: 'project-1',
    episodeId: 'episode-1',
    outputName: 'legacy',
    shots: [
      {
        storyboardId: 'shot-1',
        shotNo: 1,
        durationSec: 5,
        visualType: 'VIDEO',
        visualAssetId: 'video-1',
      },
    ],
  })

  assert.equal(result.shots[0].audioMode, 'AI_DUB')
  assert.equal(nativeAudioVolume(result.shots[0].audioMode), 0.55)
  assert.equal(nativeAudioVolume('VIDEO_NATIVE'), 1)
})

test('escapes Windows subtitle paths and writes bounded SRT timing', () => {
  assert.equal(
    escapeFilterPath("D:\\AI Drama\\cache[1]\\it's.srt"),
    "D\\:/AI Drama/cache\\[1\\]/it\\'s.srt",
  )
  assert.equal(
    subtitleFile('第一行\n第二行', 5),
    '1\n00:00:00,000 --> 00:00:05,000\n第一行\n第二行\n',
  )
})

test('rejects exports without a visual source for every shot', () => {
  assert.throws(
    () =>
      validateInput({
        exportId: 'export-123',
        projectId: 'project-1',
        episodeId: 'episode-1',
        outputName: 'episode',
        shots: [{ storyboardId: 'shot-1', shotNo: 1, durationSec: 5 }],
      }),
    /画面类型/,
  )
})
