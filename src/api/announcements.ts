import { request } from './client'

export type AnnouncementLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'CRITICAL'

export interface Announcement {
  id: string
  title: string
  summary?: string | null
  content: string
  level: AnnouncementLevel
  pinned: boolean
  publishAt?: string | null
  expireAt?: string | null
}

export const announcementApi = {
  list: (limit = 5) => request<Announcement[]>(`/announcements?limit=${limit}`),
}
