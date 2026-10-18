import { describe, expect, it } from 'vitest'
import { projectFrameProfile } from './project-frame-profile'

describe('project frame profile', () => {
  it('maps horizontal projects to horizontal image and video sizes', () => {
    expect(projectFrameProfile('16:9')).toMatchObject({
      aspectRatio: '16:9',
      imageSize: '2048x1152',
      videoSize: '1280x720',
      exportWidth: 1920,
      exportHeight: 1080,
      cssAspectRatio: '16 / 9',
    })
  })

  it('keeps the legacy vertical default when the project ratio is unset', () => {
    expect(projectFrameProfile('UNSET')).toMatchObject({
      aspectRatio: '9:16',
      imageSize: '1152x2048',
      videoSize: '720x1280',
    })
  })

  it('provides exact project-ratio image sizes for 4:3 projects', () => {
    expect(projectFrameProfile('4:3').imageSize).toBe('2304x1728')
    expect(projectFrameProfile('3:4').imageSize).toBe('1728x2304')
    expect(projectFrameProfile('4:3')).toMatchObject({ exportWidth: 1920, exportHeight: 1440 })
  })
})
