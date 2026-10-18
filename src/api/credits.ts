import { request } from './client'

export interface CreditCheckInStatus {
  date: string
  checkedInToday: boolean
  rewardMinPoints: number
  rewardMaxPoints: number
  wallet: CreditWallet
}

export interface CreditCheckInResult {
  success: boolean
  date: string
  rewardPoints: number
  message: string
  wallet: CreditWallet
}

export interface CreditWallet {
  tenantId: string
  availablePoints: number
  reservedPoints: number
  totalGrantedPoints: number
  totalConsumedPoints: number
  status: string
  version: number
  updatedAt: string
}

export interface CreditLedgerEntry {
  id: string
  userId?: string
  entryType: string
  availableDelta: number
  reservedDelta: number
  availableAfter: number
  reservedAfter: number
  businessType: string
  businessId: string
  remark?: string
  createdAt: string
}

export interface CreditQuote {
  platformModelId: string
  serviceType: string
  pricingMode: string
  estimatedPoints: number
  maximumPoints: number
  priceVersion: number
  description: string
  expiresAt: string
}

export interface LocalProcessingPrice {
  processingType: 'POSE_PROXY'
  pointsPerItem: number
  description: string
}

export interface LocalProcessingCharge {
  processingType: 'POSE_PROXY'
  pointsPerItem: number
  itemCount: number
  consumedPoints: number
  wallet: CreditWallet
}

export interface CreditPage<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export interface CreditPackage {
  id: string
  code: string
  name: string
  description?: string | null
  basePoints: number
  bonusPoints: number
  totalPoints: number
  priceCents: number
  currency: string
  sortOrder: number
  enabled: boolean
  version: number
}

export type CreditRechargeOrderStatus = 'PENDING' | 'PAID' | 'CANCELED' | 'EXPIRED' | 'PARTIALLY_REFUNDED' | 'REFUNDED'

export interface CreditPaymentOptions {
  manualTransferEnabled: boolean
  wechatPayEnabled: boolean
}

export interface CreditRechargeOrder {
  id: string
  orderNo: string
  packageId: string
  packageCode: string
  packageName: string
  basePoints: number
  bonusPoints: number
  totalPoints: number
  amountCents: number
  currency: string
  paymentChannel: string
  status: CreditRechargeOrderStatus
  providerOrderNo?: string | null
  prepayId?: string | null
  codeUrl?: string | null
  confirmRemark?: string | null
  expiresAt: string
  createdAt: string
  updatedAt: string
  refundedPoints?: number
  refundedAmountCents?: number
  refundablePoints?: number
  refundableAmountCents?: number
  selfRefundable?: boolean
  refundRemark?: string | null
  paidAt?: string | null
  refundedAt?: string | null
}

export const creditApi = {
  wallet: () => request<CreditWallet>('/credits/wallet'),
  checkInStatus: () => request<CreditCheckInStatus>('/credits/check-in'),
  checkIn: () =>
    request<CreditCheckInResult>('/credits/check-in', {
      method: 'POST',
    }),
  packages: () => request<CreditPackage[]>('/credits/packages'),
  paymentOptions: () => request<CreditPaymentOptions>('/credits/payment-options'),
  orders: (page = 1, pageSize = 20) =>
    request<CreditPage<CreditRechargeOrder>>(`/credits/orders?page=${page}&pageSize=${pageSize}`),
  createOrder: (
    packageId: string,
    idempotencyKey: string,
    paymentChannel: 'MANUAL_TRANSFER' | 'WECHAT_PAY' = 'WECHAT_PAY',
  ) =>
    request<CreditRechargeOrder>('/credits/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ packageId, paymentChannel }),
    }),
  getOrder: (orderId: string) =>
    request<CreditRechargeOrder>(`/credits/orders/${encodeURIComponent(orderId)}`),
  refreshWeChatOrder: (orderId: string) =>
    request<CreditRechargeOrder>(`/credits/orders/${encodeURIComponent(orderId)}/wechat/refresh`, {
      method: 'POST',
    }),
  cancelOrder: (orderId: string) =>
    request<CreditRechargeOrder>(`/credits/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
    }),
  refundOrder: (orderId: string, remark?: string) =>
    request<CreditRechargeOrder>(`/credits/orders/${encodeURIComponent(orderId)}/refund`, {
      method: 'POST',
      body: JSON.stringify({ remark: remark || undefined }),
    }),
  ledger: (page = 1, pageSize = 20) =>
    request<CreditPage<CreditLedgerEntry>>(
      `/credits/ledger?page=${page}&pageSize=${pageSize}`,
    ),
  quote: (input: {
    platformModelId: string
    serviceType: string
    parameters?: Record<string, unknown>
    prompt?: string
  }) =>
    request<CreditQuote>('/credits/quotes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  localPoseProxyPrice: () =>
    request<LocalProcessingPrice>('/credits/local-processing/pose-proxy'),
  consumeLocalPoseProxy: (itemCount: number, idempotencyKey: string) =>
    request<LocalProcessingCharge>('/credits/local-processing/pose-proxy/consume', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ itemCount }),
    }),
}
