import { defineStore } from 'pinia'
import { getStoredToken, projectApi, type CreateProjectInput, type Project } from '../api/client'
import { buildProjectPayload } from '../api/project-payload'
import { deleteBrowserProjectImages } from '../browser/browser-image-store'
import { deleteBrowserProjectMotionAssets } from '../browser/browser-motion-library'
import { isLocalProjectId } from '../api/local-project'

export const useProjectsStore = defineStore('projects', {
  state: () => ({
    items: [] as Project[],
    loading: false,
    error: '',
  }),
  actions: {
    async load() {
      this.loading = true
      this.error = ''
      try {
        const desktop = globalThis.window?.aiDramaDesktop
        if (desktop) {
          const localProjects = (await desktop.listLocalProjects()) as Project[]
          const cloudProjects = getStoredToken()
            ? await projectApi.list().catch(() => [] as Project[])
            : []
          const localIds = new Set(localProjects.map((project) => project.id))
          this.items = [
            ...localProjects,
            ...cloudProjects.filter((project) => !localIds.has(project.id)),
          ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        } else {
          this.items = await projectApi.list()
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '项目加载失败'
      } finally {
        this.loading = false
      }
    },
    async create(input: CreateProjectInput) {
      const payload = buildProjectPayload(input)
      const desktop = globalThis.window?.aiDramaDesktop
      const created =
        desktop && !getStoredToken()
          ? ((await desktop.createLocalProject(payload)) as Project)
          : await projectApi.create(payload)
      this.items.unshift(created)
      return created
    },
    async delete(projectId: string) {
      const desktop = globalThis.window?.aiDramaDesktop
      if (desktop && isLocalProjectId(projectId)) await desktop.deleteLocalProject(projectId)
      else await projectApi.delete(projectId)
      this.items = this.items.filter((project) => project.id !== projectId)
      await Promise.all([
        deleteBrowserProjectImages(projectId).catch(() => undefined),
        deleteBrowserProjectMotionAssets(projectId).catch(() => undefined),
      ])
    },
  },
})
