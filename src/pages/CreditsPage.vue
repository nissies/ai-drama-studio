<script setup lang="ts">
import {
  CheckCircle2,
  ClipboardList,
  Coins,
  LoaderCircle,
  PackageOpen,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  QrCode,
  ShoppingCart,
  Undo2,
  WalletCards,
  X,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import QRCode from 'qrcode'
import {
  creditApi,
  type CreditLedgerEntry,
  type CreditPackage,
  type CreditPaymentOptions,
  type CreditRechargeOrder,
} from '../api/credits'
import StudioShell from '../layouts/StudioShell.vue'
import { useCreditStore } from '../stores/credits'

type CreditTab = 'packages' | 'orders' | 'ledger'

const credits = useCreditStore()
const activeTab = ref<CreditTab>('packages')
const entries = ref<CreditLedgerEntry[]>([])
const packages = ref<CreditPackage[]>([])
const orders = ref<CreditRechargeOrder[]>([])
const ledgerTotal = ref(0)
const ledgerPage = ref(1)
const orderTotal = ref(0)
const orderPage = ref(1)
const pageSize = 20
const loading = ref(false)
const creatingPackageId = ref('')
const error = ref('')
const notice = ref('')
const cancelTarget = ref<CreditRechargeOrder | null>(null)
const canceling = ref(false)
const refundTarget = ref<CreditRechargeOrder | null>(null)
const refunding = ref(false)
const paymentOptions = ref<CreditPaymentOptions>({ manualTransferEnabled: true, wechatPayEnabled: false })
const payOrder = ref<CreditRechargeOrder | null>(null)
const paying = ref(false)
const qrDataUrl = ref('')
let payPollTimer: number | undefined

const ledgerTotalPages = computed(() => Math.max(1, Math.ceil(ledgerTotal.value / pageSize)))
const orderTotalPages = computed(() => Math.max(1, Math.ceil(orderTotal.value / pageSize)))

onMounted(() => void refresh())

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    await credits.load(true)
    const [ledger, packageRows, orderResult, options] = await Promise.all([
      creditApi.ledger(ledgerPage.value, pageSize),
      creditApi.packages(),
      creditApi.orders(orderPage.value, pageSize),
      creditApi.paymentOptions().catch(() => ({ manualTransferEnabled: true, wechatPayEnabled: false })),
    ])
    paymentOptions.value = options
    entries.value = ledger.items
    ledgerTotal.value = ledger.total
    packages.value = packageRows
    orders.value = orderResult.items
    orderTotal.value = orderResult.total
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '额度中心加载失败'
  } finally {
    loading.value = false
  }
}

async function createOrder(value: CreditPackage, channel: 'WECHAT_PAY' | 'MANUAL_TRANSFER' = 'WECHAT_PAY') {
  if (channel === 'WECHAT_PAY' && !paymentOptions.value.wechatPayEnabled) {
    error.value = '微信支付尚未开通，请改用人工转账或联系管理员配置'
    return
  }
  creatingPackageId.value = value.id
  error.value = ''
  notice.value = ''
  try {
    const order = await creditApi.createOrder(value.id, createIdempotencyKey(), channel)
    await loadOrders()
    if (channel === 'WECHAT_PAY') {
      await openPayOrder(order)
      notice.value = `已创建微信扫码订单 ${order.orderNo}，请使用微信扫码支付`
    } else {
      activeTab.value = 'orders'
      notice.value = `已提交“${value.name}”人工转账申请，请等待管理员确认收款`
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '充值订单创建失败'
  } finally {
    creatingPackageId.value = ''
  }
}

async function openPayOrder(order: CreditRechargeOrder) {
  payOrder.value = order
  qrDataUrl.value = ''
  error.value = ''
  try {
    await ensureQr(order)
    startPayPolling(order.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '打开微信支付失败'
    // 仍保留弹窗，用户可手动刷新或复制付款链接
    startPayPolling(order.id)
  }
}

async function ensureQr(order: CreditRechargeOrder) {
  let current = order
  if (
    current.paymentChannel === 'WECHAT_PAY' &&
    current.status === 'PENDING' &&
    (!current.codeUrl || !current.codeUrl.trim())
  ) {
    current = await creditApi.refreshWeChatOrder(current.id)
    payOrder.value = current
    replaceOrder(current)
  }
  if (current.codeUrl) {
    qrDataUrl.value = await buildQrDataUrl(current.codeUrl)
  }
}

function startPayPolling(orderId: string) {
  stopPayPolling()
  payPollTimer = globalThis.setInterval(() => {
    void pollPayOrder(orderId)
  }, 3000)
}

function stopPayPolling() {
  if (payPollTimer) {
    globalThis.clearInterval(payPollTimer)
    payPollTimer = undefined
  }
}

async function pollPayOrder(orderId: string) {
  if (!payOrder.value || payOrder.value.id !== orderId || paying.value) return
  paying.value = true
  try {
    const latest =
      payOrder.value.paymentChannel === 'WECHAT_PAY'
        ? await creditApi.refreshWeChatOrder(orderId)
        : await creditApi.getOrder(orderId)
    payOrder.value = latest
    replaceOrder(latest)
    if (latest.status === 'PAID') {
      stopPayPolling()
      notice.value = `${latest.orderNo} 已支付并到账`
      await credits.load(true)
      await loadOrders()
    } else if (latest.status !== 'PENDING') {
      stopPayPolling()
    } else if (latest.codeUrl && !qrDataUrl.value) {
      qrDataUrl.value = await buildQrDataUrl(latest.codeUrl)
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '支付状态刷新失败'
  } finally {
    paying.value = false
  }
}

function replaceOrder(order: CreditRechargeOrder) {
  const index = orders.value.findIndex((item) => item.id === order.id)
  if (index >= 0) orders.value[index] = order
  else orders.value = [order, ...orders.value]
}

function closePayModal() {
  stopPayPolling()
  payOrder.value = null
  qrDataUrl.value = ''
  void loadOrders()
  void credits.load(true)
}

async function buildQrDataUrl(content: string) {
  const value = content?.trim()
  if (!value) return ''
  try {
    return await QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
      color: {
        dark: '#111827',
        light: '#ffffff',
      },
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '付款二维码生成失败'
    return ''
  }
}

onBeforeUnmount(() => stopPayPolling())

function askCancel(order: CreditRechargeOrder) {
  cancelTarget.value = order
  error.value = ''
}

function closeCancel() {
  if (!canceling.value) cancelTarget.value = null
}

async function cancelOrder() {
  if (!cancelTarget.value) return
  canceling.value = true
  error.value = ''
  try {
    await creditApi.cancelOrder(cancelTarget.value.id)
    notice.value = `${cancelTarget.value.orderNo} 已取消`
    cancelTarget.value = null
    await loadOrders()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '充值订单取消失败'
  } finally {
    canceling.value = false
  }
}

function canSelfRefund(order: CreditRechargeOrder) {
  if (order.selfRefundable === true) return true
  return (
    order.status === 'PAID' &&
    Number(order.refundedPoints || 0) <= 0 &&
    Number(order.totalPoints || 0) > 0
  )
}

function askRefund(order: CreditRechargeOrder) {
  refundTarget.value = order
  error.value = ''
}

function closeRefund() {
  if (!refunding.value) refundTarget.value = null
}

async function refundOrder() {
  if (!refundTarget.value) return
  refunding.value = true
  error.value = ''
  try {
    const latest = await creditApi.refundOrder(refundTarget.value.id, '用户自助退款')
    notice.value = `${latest.orderNo} 已退款 ${formatPoints(latest.refundedPoints || latest.totalPoints)} 点` + (latest.paymentChannel === 'WECHAT_PAY' ? '（微信原路退回）' : '')
    refundTarget.value = null
    await Promise.all([loadOrders(), credits.load(true)])
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : '自助退款失败。若额度已使用，请联系管理员处理。'
  } finally {
    refunding.value = false
  }
}

async function loadOrders() {
  const result = await creditApi.orders(orderPage.value, pageSize)
  orders.value = result.items
  orderTotal.value = result.total
}

function changeLedgerPage(next: number) {
  if (next < 1 || next > ledgerTotalPages.value || next === ledgerPage.value) return
  ledgerPage.value = next
  void refresh()
}

function changeOrderPage(next: number) {
  if (next < 1 || next > orderTotalPages.value || next === orderPage.value) return
  orderPage.value = next
  void loadOrders()
}

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `recharge-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatPoints(value: number) {
  return Number(value || 0).toLocaleString('zh-CN')
}

function formatPrice(valueCents: number, currency: string) {
  return `${(valueCents / 100).toFixed(2)} ${currency}`
}

function formatDelta(value: number) {
  if (!value) return '0'
  return `${value > 0 ? '+' : ''}${formatPoints(value)}`
}

function formatDateTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function businessLabel(type: string, id?: string) {
  const labels: Record<string, string> = {
    CHECK_IN: '每日签到',
    TENANT: '租户账户',
    GENERATION_JOB: '生成任务',
    CHAT_MESSAGE: '创作聊天',
    CHAT_PROJECT: '聊天生成剧本',
    RECHARGE_ORDER: '充值订单',
    PUBLIC_MATERIAL: '公共素材',
  }
  const name = labels[type] || type
  if (!id || id === type) return name
  // hide raw technical ids when date-like or uuid-like short display
  if (/^\d{4}-\d{2}-\d{2}$/.test(id)) return `${name} · ${id}`
  if (id === 'local') return `${name} · 本地`
  if (id.length > 18) return `${name} · ${id.slice(0, 8)}…`
  return `${name} · ${id}`
}

function entryLabel(value: string) {
  return (
    {
      SIGNUP_GRANT: '注册赠送',
      ADMIN_ADJUST: '平台调账',
      RESERVE: '生成预冻结',
      SETTLE: '生成结算',
      RELEASE: '失败返还',
      RECHARGE_GRANT: '充值到账',
      RECHARGE_REFUND: '充值退款',
      CHECK_IN: '每日签到',
    }[value] || value
  )
}

function statusLabel(value: CreditRechargeOrder['status']) {
  return ({ PENDING: '待支付/确认', PAID: '已入账', CANCELED: '已取消', EXPIRED: '已过期', PARTIALLY_REFUNDED: '部分退款', REFUNDED: '已退款' } as Record<string, string>)[value] || value
}

function statusClass(value: CreditRechargeOrder['status']) {
  return `recharge-status-${value.toLowerCase()}`
}
</script>

<template>
  <StudioShell>
    <header class="page-header brand-page-hero credits-page-header">
      <div>
        <h1>平台额度</h1>
        <p>平台模型按任务计费，我的 API 始终不消耗平台额度</p>
      </div>
      <button class="icon-button" type="button" title="刷新额度中心" :disabled="loading" @click="refresh">
        <RefreshCw :size="17" :class="{ spin: loading }" />
      </button>
    </header>

    <section class="credit-overview" aria-label="额度概览">
      <div><span><WalletCards :size="17" />可用额度</span><strong>{{ formatPoints(credits.wallet?.availablePoints ?? 0) }}</strong><small>点</small></div>
      <div><span><ShieldCheck :size="17" />任务冻结</span><strong>{{ formatPoints(credits.wallet?.reservedPoints ?? 0) }}</strong><small>点</small></div>
      <div><span><Coins :size="17" />累计发放</span><strong>{{ formatPoints(credits.wallet?.totalGrantedPoints ?? 0) }}</strong><small>点</small></div>
      <div><span><ReceiptText :size="17" />累计消耗</span><strong>{{ formatPoints(credits.wallet?.totalConsumedPoints ?? 0) }}</strong><small>点</small></div>
    </section>

    <section class="credit-user-tabs" aria-label="额度视图">
      <button :class="{ active: activeTab === 'packages' }" type="button" @click="activeTab = 'packages'"><PackageOpen :size="16" />充值套餐</button>
      <button :class="{ active: activeTab === 'orders' }" type="button" @click="activeTab = 'orders'"><ClipboardList :size="16" />充值订单</button>
      <button :class="{ active: activeTab === 'ledger' }" type="button" @click="activeTab = 'ledger'"><ReceiptText :size="16" />额度流水</button>
    </section>

    <main class="credit-user-content">
      <p v-if="notice" class="inline-success" role="status"><CheckCircle2 :size="15" />{{ notice }}</p>
      <p v-if="error || credits.error" class="inline-error" role="alert">{{ error || credits.error }}</p>

      <section v-if="activeTab === 'packages'" class="credit-purchase-section">
        <header class="credit-user-section-header"><div><h2>选择充值套餐</h2><p>{{ paymentOptions.wechatPayEnabled ? '支持微信扫码支付，支付成功后自动入账；也可提交人工转账由管理员确认。' : '当前可提交人工转账充值申请；微信扫码支付配置完成后将自动开放。' }}</p></div><span>{{ packages.length }} 个可用套餐</span></header>
        <div v-if="loading && !packages.length" class="empty-state"><LoaderCircle class="spin" :size="26" /><strong>正在加载充值套餐</strong></div>
        <div v-else-if="!packages.length" class="empty-state"><PackageOpen :size="28" /><strong>暂时没有可用套餐</strong><p>请联系管理员启用充值套餐。</p></div>
        <div v-else class="credit-package-grid">
          <article v-for="item in packages" :key="item.id" class="credit-package-card">
            <header><div><span>{{ item.code }}</span><h3>{{ item.name }}</h3></div><strong>{{ formatPrice(item.priceCents, item.currency) }}</strong></header>
            <p>{{ item.description || '用于 AI 短剧创作的模型生成额度' }}</p>
            <div class="credit-package-points"><strong>{{ formatPoints(item.totalPoints) }} 点</strong><span>基础 {{ formatPoints(item.basePoints) }} 点<span v-if="item.bonusPoints"> + 赠送 {{ formatPoints(item.bonusPoints) }} 点</span></span></div>
            <footer class="credit-package-actions"><button class="button primary wide" type="button" :disabled="creatingPackageId !== '' || !paymentOptions.wechatPayEnabled" @click="createOrder(item, 'WECHAT_PAY')"><QrCode :size="16" />{{ creatingPackageId === item.id ? '正在创建订单' : (paymentOptions.wechatPayEnabled ? '微信扫码支付' : '微信未配置') }}</button><button class="button wide" type="button" :disabled="creatingPackageId !== ''" @click="createOrder(item, 'MANUAL_TRANSFER')"><ShoppingCart :size="16" />人工转账申请</button></footer>
          </article>
        </div>
      </section>

      <section v-else-if="activeTab === 'orders'" class="credit-orders-section">
        <header class="credit-user-section-header"><div><h2>充值订单</h2><p>已入账订单若额度尚未使用，可自助整单退款（微信订单原路退回）；已使用请联系管理员。</p></div><span>共 {{ orderTotal }} 条记录</span></header>
        <div v-if="loading && !orders.length" class="empty-state"><LoaderCircle class="spin" :size="26" /><strong>正在加载充值订单</strong></div>
        <div v-else-if="!orders.length" class="empty-state"><ClipboardList :size="28" /><strong>暂无充值订单</strong><p>提交充值申请后，订单会显示在这里。</p></div>
        <div v-else class="table-wrap credit-user-order-table">
          <table>
            <thead><tr><th>订单号</th><th>套餐</th><th>点数</th><th>金额</th><th>状态</th><th>创建时间</th><th>支付时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="order in orders" :key="order.id">
                <td><strong>{{ order.orderNo }}</strong><code>{{ order.paymentChannel === 'WECHAT_PAY' ? '微信扫码' : order.paymentChannel === 'MANUAL_TRANSFER' ? '人工转账' : order.paymentChannel }}</code></td>
                <td>{{ order.packageName }}</td>
                <td class="credit-entry-delta positive">{{ formatPoints(order.totalPoints) }} 点</td>
                <td>{{ formatPrice(order.amountCents, order.currency) }}</td>
                <td><span class="recharge-status" :class="statusClass(order.status)"><i />{{ statusLabel(order.status) }}</span></td>
                <td>{{ formatDateTime(order.createdAt) }}</td>
                <td>{{ order.paidAt ? formatDateTime(order.paidAt) : '--' }}</td>
                <td class="credit-order-actions">
                  <button v-if="order.status === 'PENDING' && order.paymentChannel === 'WECHAT_PAY'" class="button compact primary" type="button" @click="openPayOrder(order)">继续支付</button>
                  <button v-if="order.status === 'PENDING'" class="button compact" type="button" @click="askCancel(order)">取消</button>
                  <button v-if="canSelfRefund(order)" class="button compact" type="button" @click="askRefund(order)"><Undo2 :size="14" />申请退款</button>
                  <span v-if="order.status !== 'PENDING' && !canSelfRefund(order)" class="muted-text">--</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer v-if="orders.length" class="credit-pagination"><span>第 {{ orderPage }} / {{ orderTotalPages }} 页</span><div><button class="button" type="button" :disabled="orderPage <= 1 || loading" @click="changeOrderPage(orderPage - 1)">上一页</button><button class="button" type="button" :disabled="orderPage >= orderTotalPages || loading" @click="changeOrderPage(orderPage + 1)">下一页</button></div></footer>
      </section>

      <section v-else class="credits-ledger-section credit-ledger-user-section">
        <header><div><h2>额度明细</h2><span>共 {{ ledgerTotal }} 条记录</span></div><p>平台任务创建时预冻结，失败或取消会自动返还；成功后按实际用量结算。</p></header>
        <div v-if="loading && !entries.length" class="empty-state"><LoaderCircle class="spin" :size="26" /><strong>正在加载额度明细</strong></div>
        <div v-else-if="!entries.length" class="empty-state"><ReceiptText :size="28" /><strong>暂无额度记录</strong></div>
        <template v-else>
          <div class="table-wrap credit-ledger-user-table">
            <table>
              <thead><tr><th>时间</th><th>类型</th><th>可用变更</th><th>冻结变更</th><th>变更后余额</th><th>业务</th><th>说明</th></tr></thead>
              <tbody>
                <tr v-for="entry in entries" :key="entry.id">
                  <td>{{ formatDateTime(entry.createdAt) }}</td>
                  <td><span class="credit-entry-type">{{ entryLabel(entry.entryType) }}</span></td>
                  <td class="credit-entry-delta" :class="{ positive: entry.availableDelta > 0, negative: entry.availableDelta < 0 }">{{ formatDelta(entry.availableDelta) }}</td>
                  <td class="credit-entry-delta" :class="{ positive: entry.reservedDelta > 0, negative: entry.reservedDelta < 0 }">{{ formatDelta(entry.reservedDelta) }}</td>
                  <td><strong>{{ formatPoints(entry.availableAfter) }} 可用</strong><small>{{ formatPoints(entry.reservedAfter) }} 冻结</small></td>
                  <td><strong>{{ businessLabel(entry.businessType, entry.businessId) }}</strong></td>
                  <td><span class="credit-entry-remark" :title="entry.remark || ''">{{ entry.remark || '--' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer class="credit-pagination"><span>第 {{ ledgerPage }} / {{ ledgerTotalPages }} 页</span><div><button class="button" type="button" :disabled="ledgerPage <= 1 || loading" @click="changeLedgerPage(ledgerPage - 1)">上一页</button><button class="button" type="button" :disabled="ledgerPage >= ledgerTotalPages || loading" @click="changeLedgerPage(ledgerPage + 1)">下一页</button></div></footer>
        </template>
      </section>
    </main>

    <div v-if="payOrder" class="modal-backdrop" @click.self="closePayModal">
      <section class="modal credit-pay-modal" role="dialog" aria-modal="true" aria-label="微信扫码支付">
        <header>
          <div>
            <h2>微信扫码支付</h2>
            <small>{{ payOrder.orderNo }} · {{ payOrder.packageName }} · {{ formatPrice(payOrder.amountCents, payOrder.currency) }}</small>
          </div>
          <button class="icon-button" type="button" title="关闭" @click="closePayModal"><X :size="18" /></button>
        </header>
        <div class="credit-pay-body">
          <div class="credit-pay-qr">
            <img v-if="qrDataUrl" :src="qrDataUrl" alt="微信支付二维码" />
            <div v-else class="empty-state compact"><LoaderCircle class="spin" :size="22" /><strong>正在生成付款码</strong></div>
          </div>
          <div class="credit-pay-meta">
            <p>请使用微信扫一扫完成支付。支付成功后额度会自动到账，无需管理员确认。</p>
            <p>状态：<strong>{{ statusLabel(payOrder.status) }}</strong></p>
            <p v-if="payOrder.codeUrl" class="credit-pay-link">若二维码无法识别，可复制付款链接到手机打开：<code>{{ payOrder.codeUrl }}</code></p>
            <div class="credit-pay-actions">
              <button class="button" type="button" :disabled="paying" @click="pollPayOrder(payOrder.id)">
                <RefreshCw :size="15" :class="{ spin: paying }" />刷新支付状态
              </button>
              <button class="button primary" type="button" @click="closePayModal">我已完成支付</button>
            </div>
          </div>
        </div>
      </section>
    </div>
    <div v-if="cancelTarget" class="modal-backdrop" @click.self="closeCancel">
      <section class="modal credit-cancel-modal" role="dialog" aria-modal="true" aria-labelledby="credit-cancel-title">
        <header><div><h2 id="credit-cancel-title">取消充值申请</h2><small>{{ cancelTarget.orderNo }} · {{ cancelTarget.packageName }}</small></div><button class="icon-button" type="button" title="关闭" :disabled="canceling" @click="closeCancel"><X :size="18" /></button></header>
        <div class="credit-cancel-body"><p>取消后管理员不能再为此订单确认入账。已经入账的订单不能取消。</p><footer><button class="button" type="button" :disabled="canceling" @click="closeCancel">返回</button><button class="button danger" type="button" :disabled="canceling" @click="cancelOrder"><X :size="16" />{{ canceling ? '正在取消' : '确认取消申请' }}</button></footer></div>
      </section>
    </div>
    <div v-if="refundTarget" class="modal-backdrop" @click.self="closeRefund">
      <section class="modal credit-cancel-modal" role="dialog" aria-modal="true" aria-labelledby="credit-refund-title">
        <header>
          <div>
            <h2 id="credit-refund-title">申请退款</h2>
            <small>{{ refundTarget.orderNo }} · {{ refundTarget.packageName }}</small>
          </div>
          <button class="icon-button" type="button" title="关闭" :disabled="refunding" @click="closeRefund"><X :size="18" /></button>
        </header>
        <div class="credit-cancel-body">
          <p>
            将退回本单全部 <strong>{{ formatPoints(refundTarget.totalPoints) }}</strong> 点
            （{{ formatPrice(refundTarget.amountCents, refundTarget.currency) }}）。
          </p>
          <p>仅当这些充值点尚未使用时才能自助退款。微信订单会原路退回微信；若已消耗，请联系管理员在后台处理。</p>
          <footer>
            <button class="button" type="button" :disabled="refunding" @click="closeRefund">返回</button>
            <button class="button danger" type="button" :disabled="refunding" @click="refundOrder">
              <Undo2 :size="16" />{{ refunding ? '退款中' : '确认退款' }}
            </button>
          </footer>
        </div>
      </section>
    </div>
  </StudioShell>
</template>
