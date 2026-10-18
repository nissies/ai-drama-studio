import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import { getStoredToken } from './api/client'

const LoginPage = () => import('./pages/LoginPage.vue')
const ProjectsPage = () => import('./pages/ProjectsPage.vue')
const WorkspacePage = () => import('./pages/WorkspacePage.vue')
const SettingsPage = () => import('./pages/SettingsPage.vue')
const CreditsPage = () => import('./pages/CreditsPage.vue')
const PublicMaterialsPage = () => import('./pages/PublicMaterialsPage.vue')
const ChatPage = () => import('./pages/ChatPage.vue')
const DataCenterPage = () => import('./pages/DataCenterPage.vue')
const ImageLabPage = () => import('./pages/ImageLabPage.vue')
const VideoLabPage = () => import('./pages/VideoLabPage.vue')
const LocalAssetsPage = () => import('./pages/LocalAssetsPage.vue')
const TasksPage = () => import('./pages/TasksPage.vue')
const BatchVideoPage = () => import('./pages/BatchVideoPage.vue')

export const router = createRouter({
  history: window.aiDramaDesktop ? createWebHashHistory() : createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginPage, meta: { public: true } },
    { path: '/', redirect: '/projects' },
    { path: '/projects', name: 'projects', component: ProjectsPage },
    { path: '/projects/:projectId', name: 'workspace', component: WorkspacePage },
    { path: '/projects/:projectId/batch-video', name: 'batch-video', component: BatchVideoPage },
    {
      path: '/public-materials',
      name: 'public-materials',
      component: PublicMaterialsPage,
      meta: { cloudOnly: true },
    },
    { path: '/local-assets', name: 'local-assets', component: LocalAssetsPage },
    { path: '/data-center', name: 'data-center', component: DataCenterPage },
    { path: '/chat', name: 'chat', component: ChatPage },
    { path: '/image-lab', name: 'image-lab', component: ImageLabPage },
    { path: '/video-lab', name: 'video-lab', component: VideoLabPage },
    { path: '/tasks', name: 'tasks', component: TasksPage },
    { path: '/settings', name: 'settings', component: SettingsPage },
    { path: '/credits', name: 'credits', component: CreditsPage, meta: { cloudOnly: true } },
  ],
})

router.beforeEach((to) => {
  const authenticated = Boolean(getStoredToken())
  if (to.meta.cloudOnly && !authenticated) {
    return {
      name: 'login',
      query: { redirect: to.fullPath, reason: 'cloud-service' },
    }
  }
  if (to.name === 'login' && authenticated) return { name: 'projects' }
  return true
})
