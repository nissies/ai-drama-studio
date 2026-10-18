import { request, requestBinary, requestForm } from './client'

export interface VoiceCatalogOption {
  id: string
  name: string
  description?: string | null
  type: 'SYSTEM' | 'CLONED'
  previewAvailable: boolean
  previewExpiresAt?: string | null
}

export const voiceCatalogApi = {
  list: (projectId: string, platformModelId?: string, characterId?: string) => {
    const query = new URLSearchParams({ projectId })
    if (platformModelId) query.set('platformModelId', platformModelId)
    if (characterId) query.set('characterId', characterId)
    return request<VoiceCatalogOption[]>(`/voice-catalog?${query.toString()}`)
  },
  clone: (input: {
    projectId: string
    platformModelId: string
    characterId?: string
    displayName: string
    transcript?: string
    audio: File
  }) => {
    const body = new FormData()
    body.append('projectId', input.projectId)
    body.append('platformModelId', input.platformModelId)
    if (input.characterId) body.append('characterId', input.characterId)
    body.append('displayName', input.displayName)
    if (input.transcript) body.append('transcript', input.transcript)
    body.append('audio', input.audio, input.audio.name)
    return requestForm<VoiceCatalogOption>('/voice-catalog/clone', body)
  },
  preview: (voiceId: string) =>
    requestBinary(`/voice-catalog/${encodeURIComponent(voiceId)}/preview`, [
      'audio/mpeg',
      'audio/wav',
      'audio/x-wav',
      'audio/mp4',
      'audio/aac',
    ]),
  delete: (voiceId: string) =>
    request<void>(`/voice-catalog/${encodeURIComponent(voiceId)}`, { method: 'DELETE' }),
}
