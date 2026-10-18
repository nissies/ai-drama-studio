const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  validateAudioExtractionInput,
  validateVideoFrameExtractionInput,
} = require('./audio-extractor.cjs')

test('validates a bounded single-speaker extraction range', () => {
  const result = validateAudioExtractionInput({
    projectId: 'project-1',
    videoAssetId: 'video-1',
    outputName: '角色甲-声音样本',
    startSec: 1.25,
    endSec: 8.5,
  })

  assert.equal(result.startSec, 1.25)
  assert.equal(result.endSec, 8.5)
})

test('rejects mixed or excessively long extraction ranges', () => {
  assert.throws(
    () =>
      validateAudioExtractionInput({
        projectId: 'project-1',
        videoAssetId: 'video-1',
        outputName: 'too-long',
        startSec: 0,
        endSec: 61,
      }),
    /1 到 60 秒/,
  )
})

test('validates a video end-frame extraction request', () => {
  assert.deepEqual(
    validateVideoFrameExtractionInput({
      projectId: 'project-1',
      videoAssetId: 'video-1',
      outputName: 'shot-1-end-frame',
    }),
    {
      projectId: 'project-1',
      videoAssetId: 'video-1',
      outputName: 'shot-1-end-frame',
      position: 'LAST',
    },
  )
  assert.throws(
    () =>
      validateVideoFrameExtractionInput({
        projectId: 'project-1',
        videoAssetId: '',
        outputName: 'shot-1-end-frame',
      }),
    /视频素材/,
  )
  assert.equal(
    validateVideoFrameExtractionInput({
      projectId: 'project-1',
      videoAssetId: 'video-1',
      outputName: 'shot-1-first-frame',
      position: 'FIRST',
    }).position,
    'FIRST',
  )
})
