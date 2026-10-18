import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDesktopStore } from '../stores/desktop'
import { useProjectsStore } from '../stores/projects'
import { useWorkspaceStore } from '../stores/workspace'

export function useProjectContextPage(routeName: 'local-assets' | 'data-center') {
  const route = useRoute()
  const router = useRouter()
  const desktop = useDesktopStore()
  const projects = useProjectsStore()
  const workspace = useWorkspaceStore()
  const selectedProjectId = ref('')
  const loadingProject = ref(false)
  const projectError = ref('')
  let loadToken = 0

  const selectedProject = computed(
    () => projects.items.find((project) => project.id === selectedProjectId.value) || null,
  )
  const projectReady = computed(
    () =>
      Boolean(selectedProjectId.value) &&
      workspace.project?.id === selectedProjectId.value &&
      !workspace.loading &&
      !loadingProject.value &&
      !projectError.value,
  )
  const selectedLocalAssetCount = computed(() =>
    desktop.project?.projectId === selectedProjectId.value ? desktop.project.assets.length : 0,
  )

  onMounted(async () => {
    await Promise.all([desktop.initialize(), projects.load()])
    ensureProjectSelection()
  })

  watch(
    () => route.query.projectId,
    () => ensureProjectSelection(),
  )

  watch(
    () => projects.items.map((project) => project.id).join(','),
    () => ensureProjectSelection(),
  )

  watch(selectedProjectId, (projectId) => {
    if (projectId) void prepareProject(projectId)
  })

  function ensureProjectSelection() {
    if (!projects.items.length) {
      selectedProjectId.value = ''
      projectError.value = ''
      return
    }

    const requestedId = String(route.query.projectId || '')
    const requestedProject = projects.items.find((project) => project.id === requestedId)
    const currentProject = projects.items.find((project) => project.id === selectedProjectId.value)
    const rememberedProject = projects.items.find((project) => project.id === workspace.project?.id)
    const fallbackProject = requestedProject || currentProject || rememberedProject || projects.items[0]

    if (fallbackProject && selectedProjectId.value !== fallbackProject.id) {
      selectProject(fallbackProject.id)
    }
  }

  function selectProject(projectId: string) {
    selectedProjectId.value = projectId
    const currentProjectId = String(route.query.projectId || '')
    if (currentProjectId !== projectId) {
      void router.replace({ name: routeName, query: { projectId } })
    }
  }

  async function refreshProjects() {
    await projects.load()
    ensureProjectSelection()
  }

  async function retrySelectedProject() {
    if (selectedProjectId.value) await prepareProject(selectedProjectId.value)
  }

  async function prepareProject(projectId: string) {
    const project = projects.items.find((item) => item.id === projectId)
    if (!project) return

    const token = ++loadToken
    loadingProject.value = true
    projectError.value = ''
    try {
      await workspace.load(projectId)
      if (token !== loadToken) return
      if (workspace.error || workspace.project?.id !== projectId) {
        throw new Error(workspace.error || '项目数据加载失败')
      }

      if (desktop.available) {
        await desktop.ensureProject({ id: project.id, title: project.title })
        if (token !== loadToken) return
        if (desktop.error) throw new Error(desktop.error)
        if (desktop.project?.projectId === projectId) {
          const mappings = await workspace.synchronizeLocalAssets(projectId, desktop.project.assets)
          if (token !== loadToken) return
          await desktop.reconcileAssetIds(
            mappings.filter((item) => item.clientAssetId !== item.assetId),
          )
        }
      }
    } catch (error) {
      if (token === loadToken) {
        projectError.value = error instanceof Error ? error.message : '项目上下文准备失败'
      }
    } finally {
      if (token === loadToken) loadingProject.value = false
    }
  }

  return {
    desktop,
    loadingProject,
    projectError,
    projectReady,
    projects,
    refreshProjects,
    retrySelectedProject,
    selectProject,
    selectedLocalAssetCount,
    selectedProject,
    selectedProjectId,
    workspace,
  }
}
