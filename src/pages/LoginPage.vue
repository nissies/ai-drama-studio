<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowLeft, Clapperboard, Eye, EyeOff, LogIn, Mail, UserPlus } from 'lucide-vue-next'
import { useAuthStore } from '../stores/auth'
import { getRememberedAuthState, getStoredToken, hydrateStoredAuth } from '../api/client'
import { useRoute, useRouter } from 'vue-router'

type AuthMode = 'login' | 'register'

const mode = ref<AuthMode>('login')
const displayName = ref('')
const account = ref('')
const emailCode = ref('')
const password = ref('')
const confirmPassword = ref('')
const showPassword = ref(false)
const rememberPassword = ref(false)
const localError = ref('')
const sendingCode = ref(false)
const codeCooldown = ref(0)
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const desktopAvailable = Boolean(globalThis.window?.aiDramaDesktop)
const redirectTo = computed(() => {
  const value = String(route.query.redirect || '')
  return value.startsWith('/') && !value.startsWith('//') ? value : undefined
})
const cloudReason = computed(() => route.query.reason === 'cloud-service')
let cooldownTimer: number | undefined

onMounted(async () => {
  await hydrateStoredAuth()
  if (getStoredToken()) {
    const restored = await auth.restoreSession()
    if (restored) {
      await router.replace(redirectTo.value || '/projects')
      return
    }
    if (auth.token) return
  }
  const remembered = getRememberedAuthState()
  if (!remembered) return
  account.value = remembered.account
  password.value = remembered.password
  rememberPassword.value = true
  void auth.login(remembered.account, remembered.password, true, redirectTo.value)
})

function switchMode(nextMode: AuthMode) {
  mode.value = nextMode
  localError.value = ''
  auth.error = ''
  emailCode.value = ''
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

async function sendCode() {
  localError.value = ''
  auth.error = ''
  const email = account.value.trim()
  if (!isEmail(email)) {
    localError.value = '请输入有效的邮箱地址'
    return
  }
  if (sendingCode.value || codeCooldown.value > 0) return
  sendingCode.value = true
  try {
    const result = await auth.sendEmailCode(email)
    startCooldown(result.resendIntervalSeconds || 60)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : '验证码发送失败'
  } finally {
    sendingCode.value = false
  }
}

function startCooldown(seconds: number) {
  codeCooldown.value = Math.max(1, seconds)
  if (cooldownTimer) globalThis.clearInterval(cooldownTimer)
  cooldownTimer = globalThis.setInterval(() => {
    codeCooldown.value -= 1
    if (codeCooldown.value <= 0 && cooldownTimer) {
      globalThis.clearInterval(cooldownTimer)
      cooldownTimer = undefined
    }
  }, 1000)
}

function submit() {
  localError.value = ''
  const normalizedAccount = account.value.trim()
  if (!normalizedAccount || !password.value || auth.loading) return
  if (mode.value === 'login') {
    void auth.login(normalizedAccount, password.value, rememberPassword.value, redirectTo.value)
    return
  }
  if (!isEmail(normalizedAccount)) {
    localError.value = '当前仅支持邮箱注册'
    return
  }
  if (displayName.value.trim().length < 2) {
    localError.value = '昵称至少需要 2 个字符'
    return
  }
  if (!/^\d{6}$/.test(emailCode.value.trim())) {
    localError.value = '请输入 6 位邮箱验证码'
    return
  }
  if (
    password.value.length < 8 ||
    !/[A-Za-z]/.test(password.value) ||
    !/[0-9]/.test(password.value)
  ) {
    localError.value = '密码至少 8 位，并且同时包含字母和数字'
    return
  }
  if (password.value !== confirmPassword.value) {
    localError.value = '两次输入的密码不一致'
    return
  }
  void auth.register(
    {
      email: normalizedAccount,
      code: emailCode.value.trim(),
      displayName: displayName.value.trim(),
      password: password.value,
    },
    redirectTo.value,
  )
}

onBeforeUnmount(() => {
  if (cooldownTimer) globalThis.clearInterval(cooldownTimer)
})
</script>

<template>
  <main class="login-layout">
    <section class="login-panel auth-panel">
      <div class="login-brand"><Clapperboard :size="24" />移光漫剧工坊</div>
      <div class="auth-switch" role="tablist" aria-label="账号操作">
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'login'"
          :class="{ active: mode === 'login' }"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'register'"
          :class="{ active: mode === 'register' }"
          @click="switchMode('register')"
        >
          注册
        </button>
      </div>
      <div class="auth-heading">
        <h1>{{ mode === 'login' ? '登录制作台' : '创建创作者账号' }}</h1>
        <p>
          {{
            cloudReason
              ? '平台模型由移光漫剧工坊提供，登录后可使用平台额度生成。'
              : mode === 'login'
                ? '使用邮箱或已有账号密码登录'
                : '使用邮箱验证码注册（手机号验证码稍后接入）'
          }}
        </p>
      </div>
      <form @submit.prevent="submit">
        <label v-if="mode === 'register'">
          昵称
          <input v-model="displayName" maxlength="40" autocomplete="name" placeholder="" />
        </label>
        <label>
          {{ mode === 'register' ? '邮箱' : '邮箱或手机号' }}
          <input
            v-model="account"
            maxlength="254"
            autocomplete="username"
            :placeholder="mode === 'register' ? '请输入邮箱' : '请输入邮箱或手机号'"
          />
        </label>
        <label v-if="mode === 'register'" class="email-code-field">
          邮箱验证码
          <span class="email-code-control">
            <input
              v-model="emailCode"
              maxlength="6"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="6 位验证码"
            />
            <button
              class="button code-send-button"
              type="button"
              :disabled="sendingCode || codeCooldown > 0"
              @click="sendCode"
            >
              <Mail :size="15" />
              {{
                sendingCode ? '发送中' : codeCooldown > 0 ? `${codeCooldown}s 后重发` : '获取验证码'
              }}
            </button>
          </span>
        </label>
        <label>
          密码
          <span class="password-control">
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
              maxlength="72"
              placeholder="请输入密码"
            />
            <button
              type="button"
              :title="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <EyeOff v-if="showPassword" :size="17" />
              <Eye v-else :size="17" />
            </button>
          </span>
          <small v-if="mode === 'register'">至少 8 位，同时包含字母和数字</small>
        </label>
        <label v-if="mode === 'register'">
          确认密码
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            maxlength="72"
            placeholder="再次输入密码"
          />
        </label>
        <label v-if="mode === 'login' && desktopAvailable" class="remember-password-option">
          <input v-model="rememberPassword" type="checkbox" />
          <span>记住密码</span>
        </label>
        <p v-if="localError || auth.error" class="form-error">{{ localError || auth.error }}</p>
        <button class="button primary wide" type="submit" :disabled="auth.loading">
          <UserPlus v-if="mode === 'register'" :size="17" />
          <LogIn v-else :size="17" />
          {{ auth.loading ? '提交中' : mode === 'login' ? '登录' : '创建账号' }}
        </button>
        <RouterLink class="button wide auth-local-entry" to="/projects">
          <ArrowLeft :size="16" />暂不登录，继续本地创作
        </RouterLink>
      </form>
    </section>
  </main>
</template>
