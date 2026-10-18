import { request, requestForm } from './client'

export type PublicMaterialType = 'IMAGE' | 'TEXT' | 'AUDIO'
export type PublicMaterialStatus = 'PENDING_REVIEW' | 'PUBLISHED' | 'REJECTED' | 'OFFLINE'
export type PublicMaterialSource = 'USER' | 'PLATFORM'
export type ComplaintRightsType = 'PORTRAIT' | 'COPYRIGHT' | 'TRADEMARK' | 'VOICE' | 'OTHER'
export type ComplaintStatus = 'RECEIVED' | 'PROCESSING' | 'RESOLVED' | 'REJECTED'

export interface PublicMaterialPage<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export interface PublicMaterialItem {
  id: string
  materialType: PublicMaterialType
  title: string
  description?: string | null
  category: string
  tags: string[]
  contentText?: string | null
  originalFilename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  publishedAt?: string | null
  updatedAt: string
}

export interface PublicMaterialSubmission extends PublicMaterialItem {
  sourceType: PublicMaterialSource
  status: PublicMaterialStatus
  sortOrder: number
  submittedByUserId: string
  rightsDeclarationVersion?: string | null
  rightsDeclarationText?: string | null
  rightsDeclaredAt?: string | null
  audioSpokenOnly: boolean
  reviewedByUserId?: string | null
  reviewedAt?: string | null
  reviewNote?: string | null
  version: number
  createdAt: string
}

export interface PublicMaterialComplaint {
  id: string
  materialId: string
  materialTitle: string
  materialType: PublicMaterialType | 'UNKNOWN'
  complainantName: string
  complainantContact: string
  rightsType: ComplaintRightsType | string
  statement: string
  evidenceDescription?: string | null
  status: ComplaintStatus
  submittedByUserId?: string | null
  handledByUserId?: string | null
  handledAt?: string | null
  resolutionNote?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export const PUBLIC_MATERIAL_RIGHTS_TEXT =
  '本人承诺对投稿素材拥有合法权利或已取得充分授权，不侵犯第三方肖像权、著作权、商标权及其他合法权益，并愿意承担由此产生的责任。'

export const PUBLIC_MATERIAL_AUDIO_TEXT =
  '本人承诺该音频素材拥有合法权利或已取得充分授权，可用于短剧音效、环境声、旁白或台词等创作场景。'

export const PUBLIC_MATERIAL_TYPE_LABEL: Record<PublicMaterialType, string> = {
  IMAGE: '图片',
  TEXT: '文本',
  AUDIO: '音频素材',
}

export const PUBLIC_MATERIAL_STATUS_LABEL: Record<PublicMaterialStatus, string> = {
  PENDING_REVIEW: '待审核',
  PUBLISHED: '已公开',
  REJECTED: '已拒绝',
  OFFLINE: '已下架',
}

function buildQuery(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  })
  const query = search.toString()
  return query ? `?${query}` : ''
}

export const publicMaterialApi = {
  list: (params: {
    page?: number
    pageSize?: number
    materialType?: PublicMaterialType | ''
    category?: string
    query?: string
  }) =>
    request<PublicMaterialPage<PublicMaterialItem>>(
      `/public-materials${buildQuery({
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 24,
        materialType: params.materialType || undefined,
        category: params.category || undefined,
        query: params.query || undefined,
      })}`,
    ),

  mySubmissions: (params: {
    page?: number
    pageSize?: number
    status?: PublicMaterialStatus | ''
  }) =>
    request<PublicMaterialPage<PublicMaterialSubmission>>(
      `/public-materials/my-submissions${buildQuery({
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 20,
        status: params.status || undefined,
      })}`,
    ),

  submitText: (input: {
    title: string
    description?: string
    category: string
    tags?: string[]
    sortOrder?: number
    contentText: string
    rightsAccepted: boolean
  }) =>
    request<PublicMaterialSubmission>('/public-materials/submissions/text', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  submitFile: (input: {
    materialType: 'IMAGE' | 'AUDIO'
    title: string
    description?: string
    category: string
    tags?: string
    sortOrder?: number
    rightsAccepted: boolean
    audioSpokenOnlyAccepted?: boolean
    file: File
  }) => {
    const body = new FormData()
    body.set('materialType', input.materialType)
    body.set('title', input.title)
    if (input.description) body.set('description', input.description)
    body.set('category', input.category)
    if (input.tags) body.set('tags', input.tags)
    if (input.sortOrder !== undefined) body.set('sortOrder', String(input.sortOrder))
    body.set('rightsAccepted', String(input.rightsAccepted))
    if (input.audioSpokenOnlyAccepted !== undefined) {
      body.set('audioSpokenOnlyAccepted', String(Boolean(input.audioSpokenOnlyAccepted)))
    }
    body.set('file', input.file)
    return requestForm<PublicMaterialSubmission>('/public-materials/submissions/files', body)
  },

  submitComplaint: (
    materialId: string,
    input: {
      complainantName: string
      complainantContact: string
      rightsType: ComplaintRightsType
      statement: string
      evidenceDescription?: string
    },
  ) =>
    request<PublicMaterialComplaint>(
      `/public-materials/${encodeURIComponent(materialId)}/complaints`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),

  fileUrl: (materialId: string, download = false) => {
    const base = import.meta.env.VITE_API_BASE_URL as string
    return `${base}/public-materials/${encodeURIComponent(materialId)}/file${download ? '?download=true' : ''}`
  },
}
