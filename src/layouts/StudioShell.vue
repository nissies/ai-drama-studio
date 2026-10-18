<script setup lang="ts">
import {
  BookOpenText,
  BellRing,
  CalendarCheck2,
  Camera,
  Clapperboard,
  Cloud,
  Database,
  Film,
  FolderKanban,
  ImagePlus,
  Images,
  LayoutList,
  Library,
  ListChecks,
  LogOut,
  LogIn,
  Coins,
  Megaphone,
  MessagesSquare,
  WalletCards,
  X,
  Settings,
  Video,
  UserRound,
  UsersRound,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useDesktopStore } from '../stores/desktop'
import { useWorkspaceStore } from '../stores/workspace'
import { useCreditStore } from '../stores/credits'
import { useChatStore } from '../stores/chat'
import { announcementApi, type Announcement } from '../api/announcements'
import { creditApi, type CreditCheckInStatus } from '../api/credits'

type ProjectTab =
  'script' | 'characters' | 'scenes' | 'storyboards' | 'tasks' | 'compose' | 'assets' | 'data'

const props = defineProps<{ projectTitle?: string; projectId?: string }>()
const auth = useAuthStore()
const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const credits = useCreditStore()
const chatStore = useChatStore()
const announcements = ref<Announcement[]>([])
const dismissedAnnouncementIds = ref(new Set<string>())
const route = useRoute()
const router = useRouter()
const isWorkspaceRoute = computed(() => route.name === 'workspace')
const isGlobalTasksRoute = computed(() => route.name === 'tasks')
const isBatchVideoRoute = computed(() => route.name === 'batch-video')
const isLocalAssetsRoute = computed(() => route.name === 'local-assets')
const isDataCenterRoute = computed(() => route.name === 'data-center')
const routeTab = computed(() => String(route.query.tab || 'script'))
const activeProjectId = computed(() => props.projectId || workspace.project?.id || '')
const userLabel = computed(() => auth.displayName || auth.account || '云端账号')
const userSub = computed(() => (desktop.available ? '本地工作区已连接云端' : '网页模式'))
const projectTabLabels: Record<ProjectTab, string> = {
  script: '剧本',
  characters: '角色',
  scenes: '场景',
  storyboards: '分镜',
  tasks: '项目生成任务',
  compose: '合成与导出',
  assets: '本地素材库',
  data: '数据中心',
}

const announcementOpen = ref(false)
const selectedAnnouncement = ref<Announcement | null>(null)
const checkIn = ref<CreditCheckInStatus | null>(null)
const checkingIn = ref(false)
const topbarNotice = ref('')
const topbarError = ref('')
const projectRequiredError = ref('')

const unreadCount = computed(
  () => announcements.value.filter((item) => !dismissedAnnouncementIds.value.has(item.id)).length,
)
const checkInLabel = computed(() => {
  if (!checkIn.value) return '签到'
  if (checkIn.value.checkedInToday) return '已签到'
  return '签到'
})

let creditRefreshTimer: number | undefined

watch(
  () => auth.token,
  (token) => {
    if (token) {
      startCloudHeader()
      return
    }
    stopCloudHeader()
    announcements.value = []
    checkIn.value = null
    credits.clear()
  },
  { immediate: true },
)

watch(
  () => [chatStore.lastNotice, chatStore.lastError] as const,
  ([nextNotice, nextError]) => {
    if (nextNotice) {
      topbarNotice.value = nextNotice
      chatStore.lastNotice = ''
    }
    if (nextError) {
      topbarError.value = nextError
      chatStore.lastError = ''
    }
  },
)

watch(
  () => route.name,
  () => {
    if (projectRequiredError.value && topbarError.value === projectRequiredError.value) {
      topbarError.value = ''
    }
    projectRequiredError.value = ''
    if (route.name !== 'projects') {
      globalThis.sessionStorage?.removeItem('ai-drama-project-required-notice')
    }
  },
)

onMounted(() => {
  void desktop.initialize()
  void auth.restoreSession()
})

onBeforeUnmount(() => {
  stopCloudHeader()
})

function startCloudHeader() {
  if (!auth.token) return
  void credits.load()
  void loadAnnouncements()
  void loadCheckInStatus()
  if (!creditRefreshTimer) {
    creditRefreshTimer = globalThis.setInterval(() => {
      if (!auth.token) return
      void credits.load()
      void loadCheckInStatus()
    }, 30_000)
  }
}

function stopCloudHeader() {
  if (creditRefreshTimer) globalThis.clearInterval(creditRefreshTimer)
  creditRefreshTimer = undefined
}

function openCloudLogin() {
  void router.push({
    name: 'login',
    query: { redirect: route.fullPath, reason: 'cloud-service' },
  })
}

const avatarInput = ref<HTMLInputElement | null>(null)
const avataring = ref(false)

function triggerAvatar() {
  if (avataring.value) return
  avatarInput.value?.click()
}

async function onAvatarSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    topbarError.value = '请选择 PNG / JPG / WEBP 图片作为头像'
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    topbarError.value = '头像大小不能超过 2MB'
    return
  }
  avataring.value = true
  topbarError.value = ''
  topbarNotice.value = ''
  try {
    await auth.uploadAvatar(file)
    topbarNotice.value = '头像已更新'
  } catch (error) {
    topbarError.value = error instanceof Error ? error.message : '头像上传失败'
  } finally {
    avataring.value = false
  }
}

async function removeAvatar() {
  if (!auth.hasAvatar || avataring.value) return
  if (!window.confirm('确定移除当前头像吗？')) return
  avataring.value = true
  topbarError.value = ''
  topbarNotice.value = ''
  try {
    await auth.deleteAvatar()
    topbarNotice.value = '头像已移除'
  } catch (error) {
    topbarError.value = error instanceof Error ? error.message : '移除头像失败'
  } finally {
    avataring.value = false
  }
}

function openProjectTab(tab: ProjectTab) {
  if (!activeProjectId.value) {
    const message = `${projectTabLabels[tab]}需要先打开一个项目`
    projectRequiredError.value = message
    topbarError.value = message
    globalThis.sessionStorage?.setItem('ai-drama-project-required-notice', message)
    void router.push({ name: 'projects' })
    return
  }
  void router.push({
    name: 'workspace',
    params: { projectId: activeProjectId.value },
    query: { tab },
  })
}

async function loadAnnouncements() {
  if (!auth.token) return
  const stored = globalThis.localStorage?.getItem('ai-drama-dismissed-announcements')
  try {
    if (stored) dismissedAnnouncementIds.value = new Set(JSON.parse(stored) as string[])
  } catch {
    dismissedAnnouncementIds.value = new Set()
  }
  try {
    announcements.value = await announcementApi.list(20)
  } catch {
    announcements.value = []
  }
}

async function loadCheckInStatus() {
  if (!auth.token) return
  try {
    checkIn.value = await creditApi.checkInStatus()
    if (checkIn.value?.wallet) credits.wallet = checkIn.value.wallet
  } catch {
    // keep previous state
  }
}

function openAnnouncementCenter() {
  announcementOpen.value = true
  selectedAnnouncement.value = announcements.value[0] || null
  topbarError.value = ''
}

function closeAnnouncementCenter() {
  announcementOpen.value = false
  selectedAnnouncement.value = null
}

function openAnnouncementDetail(item: Announcement) {
  selectedAnnouncement.value = item
  markAnnouncementRead(item.id)
}

function markAnnouncementRead(id: string) {
  if (dismissedAnnouncementIds.value.has(id)) return
  const next = new Set(dismissedAnnouncementIds.value)
  next.add(id)
  dismissedAnnouncementIds.value = next
  globalThis.localStorage?.setItem(
    'ai-drama-dismissed-announcements',
    JSON.stringify([...next].slice(-100)),
  )
}

function markAllRead() {
  const next = new Set(dismissedAnnouncementIds.value)
  announcements.value.forEach((item) => next.add(item.id))
  dismissedAnnouncementIds.value = next
  globalThis.localStorage?.setItem(
    'ai-drama-dismissed-announcements',
    JSON.stringify([...next].slice(-100)),
  )
}

async function doCheckIn() {
  if (!auth.token) {
    openCloudLogin()
    return
  }
  if (checkingIn.value || checkIn.value?.checkedInToday) return
  checkingIn.value = true
  topbarError.value = ''
  topbarNotice.value = ''
  try {
    const result = await creditApi.checkIn()
    credits.wallet = result.wallet
    checkIn.value = {
      date: result.date,
      checkedInToday: true,
      rewardMinPoints: checkIn.value?.rewardMinPoints ?? result.rewardPoints,
      rewardMaxPoints: checkIn.value?.rewardMaxPoints ?? result.rewardPoints,
      wallet: result.wallet,
    }
    topbarNotice.value = result.message || `签到成功，获得 ${result.rewardPoints} 点`
    globalThis.setTimeout(() => {
      if (topbarNotice.value.startsWith('签到')) topbarNotice.value = ''
    }, 2500)
  } catch (cause) {
    topbarError.value = cause instanceof Error ? cause.message : '签到失败'
  } finally {
    checkingIn.value = false
  }
}

function formatDateTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function levelLabel(level: Announcement['level']) {
  return (
    {
      INFO: '通知',
      SUCCESS: '成功',
      WARNING: '提醒',
      CRITICAL: '重要',
    }[level] || level
  )
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand-mark"><Clapperboard :size="23" /><span>移光漫剧工坊</span></div>
      <nav class="primary-nav" aria-label="主导航">
        <div class="nav-group">
          <span class="nav-group-label">工作台</span>
          <RouterLink to="/chat"><MessagesSquare :size="18" /><span>聊天</span></RouterLink>
          <RouterLink to="/image-lab"><ImagePlus :size="18" /><span>生图</span></RouterLink>
          <RouterLink to="/video-lab"><Video :size="18" /><span>生视频</span></RouterLink>
          <RouterLink to="/projects"><FolderKanban :size="18" /><span>项目</span></RouterLink>
          <RouterLink to="/settings"><Settings :size="18" /><span>设置</span></RouterLink>
        </div>
        <div class="nav-group">
          <span class="nav-group-label">项目创作</span>
          <button
            type="button"
            :class="{ active: isWorkspaceRoute && activeProjectId && routeTab === 'script' }"
            :title="activeProjectId ? '打开剧本' : '请先进入项目'"
            @click="openProjectTab('script')"
          >
            <BookOpenText :size="18" /><span>剧本</span>
          </button>
          <button
            type="button"
            :class="{ active: isWorkspaceRoute && activeProjectId && routeTab === 'characters' }"
            :title="activeProjectId ? '打开角色资产' : '请先进入项目'"
            @click="openProjectTab('characters')"
          >
            <UsersRound :size="18" /><span>角色</span>
          </button>
          <button
            type="button"
            :class="{ active: isWorkspaceRoute && activeProjectId && routeTab === 'scenes' }"
            :title="activeProjectId ? '打开场景' : '请先进入项目'"
            @click="openProjectTab('scenes')"
          >
            <LayoutList :size="18" /><span>场景</span>
          </button>
          <button
            type="button"
            :class="{ active: isWorkspaceRoute && activeProjectId && routeTab === 'storyboards' }"
            :title="activeProjectId ? '打开分镜' : '请先进入项目'"
            @click="openProjectTab('storyboards')"
          >
            <Clapperboard :size="18" /><span>分镜</span>
          </button>
          <button
            type="button"
            :class="{ active: isBatchVideoRoute }"
            :title="activeProjectId ? '打开批量视频工作台' : '请先进入项目'"
            @click="
              activeProjectId
                ? router.push({ name: 'batch-video', params: { projectId: activeProjectId } })
                : openProjectTab('storyboards')
            "
          >
            <Film :size="18" /><span>批量视频</span>
          </button>
          <RouterLink
            to="/tasks"
            :class="{ active: isGlobalTasksRoute || (isWorkspaceRoute && routeTab === 'tasks') }"
            title="查看全局生成任务"
          >
            <ListChecks :size="18" /><span>生成任务</span>
          </RouterLink>
        </div>
        <div class="nav-group">
          <span class="nav-group-label">项目交付</span>
          <button
            type="button"
            :class="{ active: isWorkspaceRoute && activeProjectId && routeTab === 'compose' }"
            :title="activeProjectId ? '打开合成与导出' : '请先进入项目'"
            @click="openProjectTab('compose')"
          >
            <Film :size="18" /><span>合成与导出</span>
          </button>
        </div>
        <div class="nav-group">
          <span class="nav-group-label">素材与数据</span>
          <RouterLink v-if="auth.isAuthenticated" to="/credits"
            ><WalletCards :size="18" /><span>额度中心</span></RouterLink
          >
          <RouterLink v-if="auth.isAuthenticated" to="/public-materials"
            ><Library :size="18" /><span>公共素材区</span></RouterLink
          >
          <RouterLink
            to="/local-assets"
            :class="{ active: isLocalAssetsRoute || (isWorkspaceRoute && routeTab === 'assets') }"
            title="打开本地素材库"
          >
            <Images :size="18" /><span>本地素材库</span>
          </RouterLink>
          <RouterLink
            to="/data-center"
            :class="{ active: isDataCenterRoute || (isWorkspaceRoute && routeTab === 'data') }"
            title="打开数据中心"
          >
            <Database :size="18" /><span>数据中心</span>
          </RouterLink>
        </div>
      </nav>

      <div v-if="projectTitle" class="sidebar-project">
        <span>当前项目</span>
        <strong>{{ projectTitle }}</strong>
        <small><i />项目已打开</small>
      </div>
    </aside>

    <div class="shell-main">
      <header class="shell-topbar">
        <div class="shell-topbar-left">
          <span class="shell-mode-dot" :class="{ online: auth.isAuthenticated }" />
          <span>{{
            auth.isAuthenticated
              ? desktop.available
                ? '本地工作区 · 云端已登录'
                : '云端已登录'
              : desktop.available
                ? '本地创作模式'
                : '网页预览'
          }}</span>
          <span v-if="projectTitle" class="shell-project-chip">{{ projectTitle }}</span>
        </div>
        <div class="shell-topbar-right">
          <button
            v-if="auth.isAuthenticated"
            class="topbar-action"
            type="button"
            title="公告中心"
            @click="openAnnouncementCenter"
          >
            <span class="topbar-action-icon">
              <Megaphone :size="15" />
              <i v-if="unreadCount" class="topbar-badge">{{
                unreadCount > 9 ? '9+' : unreadCount
              }}</i>
            </span>
            <span class="topbar-action-text">
              <small>公告</small>
              <strong>{{ unreadCount ? `${unreadCount} 条未读` : '查看' }}</strong>
            </span>
          </button>

          <button
            v-if="auth.isAuthenticated"
            class="topbar-action"
            type="button"
            :class="{ done: checkIn?.checkedInToday }"
            :disabled="checkingIn || Boolean(checkIn?.checkedInToday)"
            :title="checkIn?.checkedInToday ? '今日已签到' : '每日签到领取额度'"
            @click="doCheckIn"
          >
            <span class="topbar-action-icon"><CalendarCheck2 :size="15" /></span>
            <span class="topbar-action-text">
              <small>签到</small>
              <strong>{{ checkingIn ? '签到中' : checkInLabel }}</strong>
            </span>
          </button>

          <RouterLink
            v-if="auth.isAuthenticated"
            class="topbar-action recharge"
            to="/credits"
            title="充值额度"
          >
            <span class="topbar-action-icon"><WalletCards :size="15" /></span>
            <span class="topbar-action-text">
              <small>充值</small>
              <strong>去充值</strong>
            </span>
          </RouterLink>

          <RouterLink
            v-if="auth.isAuthenticated"
            class="topbar-credit"
            to="/credits"
            title="查看平台额度明细"
          >
            <span class="topbar-credit-icon"><Coins :size="15" /></span>
            <span class="topbar-credit-body">
              <small>平台额度</small>
              <strong>
                {{
                  credits.wallet
                    ? Number(credits.wallet.availablePoints).toLocaleString('zh-CN')
                    : '--'
                }}
                <i>点</i>
              </strong>
            </span>
            <span
              v-if="credits.wallet?.reservedPoints"
              class="topbar-credit-frozen"
              :title="`任务冻结 ${credits.wallet.reservedPoints} 点`"
            >
              冻 {{ Number(credits.wallet.reservedPoints).toLocaleString('zh-CN') }}
            </span>
          </RouterLink>

          <div v-if="auth.isAuthenticated" class="topbar-user">
            <input
              ref="avatarInput"
              class="avatar-file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              @change="onAvatarSelected"
            />
            <button
              type="button"
              class="user-avatar user-avatar-button"
              title="上传头像"
              :disabled="avataring"
              @click="triggerAvatar"
            >
              <img
                v-if="auth.avatarObjectUrl"
                :src="auth.avatarObjectUrl"
                alt="用户头像"
                class="user-avatar-image"
              />
              <UserRound v-else :size="15" />
              <span class="user-avatar-overlay">
                <Camera :size="12" />
              </span>
            </button>
            <span class="topbar-user-body">
              <strong>{{ userLabel }}</strong>
              <small>{{ userSub }}</small>
            </span>
            <button
              v-if="auth.hasAvatar"
              type="button"
              class="topbar-logout"
              title="移除头像"
              :disabled="avataring"
              @click="removeAvatar"
            >
              <X :size="14" />
            </button>
            <button type="button" class="topbar-logout" title="退出登录" @click="auth.logout">
              <LogOut :size="14" />
            </button>
          </div>
          <button
            v-else
            class="topbar-cloud-login"
            type="button"
            title="登录后可使用平台模型、额度和公共素材"
            @click="openCloudLogin"
          >
            <span><Cloud :size="16" /></span>
            <div>
              <small>平台服务</small>
              <strong>登录云端</strong>
            </div>
            <LogIn :size="15" />
          </button>
        </div>
      </header>

      <p v-if="topbarNotice" class="shell-top-toast success" role="status">{{ topbarNotice }}</p>
      <p v-if="topbarError" class="shell-top-toast error" role="alert">{{ topbarError }}</p>

      <main class="main-surface">
        <slot />
      </main>
    </div>

    <div
      v-if="auth.isAuthenticated && announcementOpen"
      class="modal-backdrop"
      @click.self="closeAnnouncementCenter"
    >
      <section
        class="modal announcement-center-modal"
        role="dialog"
        aria-modal="true"
        aria-label="公告中心"
      >
        <header>
          <div>
            <h2>公告中心</h2>
            <small>平台通知与活动说明</small>
          </div>
          <div class="announcement-center-actions">
            <button v-if="unreadCount" class="button compact" type="button" @click="markAllRead">
              全部已读
            </button>
            <button class="icon-button" type="button" title="关闭" @click="closeAnnouncementCenter">
              <X :size="18" />
            </button>
          </div>
        </header>

        <div v-if="!announcements.length" class="announcement-empty">
          <BellRing :size="28" />
          <strong>暂无公告</strong>
          <p>有新通知时会显示在这里。</p>
        </div>

        <div v-else class="announcement-center-body">
          <aside class="announcement-list">
            <button
              v-for="item in announcements"
              :key="item.id"
              type="button"
              class="announcement-list-item"
              :class="{
                active: selectedAnnouncement?.id === item.id,
                unread: !dismissedAnnouncementIds.has(item.id),
              }"
              @click="openAnnouncementDetail(item)"
            >
              <div>
                <strong>{{ item.title }}</strong>
                <span>{{ item.summary || item.content }}</span>
              </div>
              <small>
                <em :class="`level-${item.level.toLowerCase()}`">{{ levelLabel(item.level) }}</em>
                {{ formatDateTime(item.publishAt) || '刚刚' }}
              </small>
            </button>
          </aside>
          <article v-if="selectedAnnouncement" class="announcement-detail">
            <header>
              <span :class="`level-chip level-${selectedAnnouncement.level.toLowerCase()}`">
                {{ levelLabel(selectedAnnouncement.level) }}
              </span>
              <h3>{{ selectedAnnouncement.title }}</h3>
              <small>{{ formatDateTime(selectedAnnouncement.publishAt) }}</small>
            </header>
            <p v-if="selectedAnnouncement.summary" class="announcement-detail-summary">
              {{ selectedAnnouncement.summary }}
            </p>
            <div class="announcement-detail-content">{{ selectedAnnouncement.content }}</div>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>
