import { request } from './client'
import type { AiServiceType } from '../desktop/types'

export interface PlatformModelCatalogItem {
  id: string
  serviceType: AiServiceType
  modelCode: string
  displayName: string
  protocolProfile?: string
  capabilities: string[]
  defaultParameters: Record<string, unknown>
  creditPrice?: {
    pricingMode: string
    basePoints: number
    unitPoints: number
    input1kTokenPoints: number
    output1kTokenPoints: number
    minimumPoints: number
    billingMultiplier: number
    version: number
    description: string
  } | null
  routeCount: number
  updatedAt: string
}

export const platformModelCatalogApi = {
  list: async (serviceType?: AiServiceType) =>
    normalizePlatformModelCatalog(
      await request<unknown>(
        `/ai-model-catalog${serviceType ? `?serviceType=${encodeURIComponent(serviceType)}` : ''}`,
      ),
    ),
}

export function normalizePlatformModelCatalog(value: unknown): PlatformModelCatalogItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Partial<PlatformModelCatalogItem>
    if (
      typeof item.id !== 'string' ||
      typeof item.modelCode !== 'string' ||
      typeof item.displayName !== 'string' ||
      !isServiceType(item.serviceType)
    ) {
      return []
    }
    return [{
      id: item.id,
      serviceType: item.serviceType,
      modelCode: item.modelCode,
      displayName: item.displayName,
      protocolProfile:
        typeof item.protocolProfile === 'string' ? item.protocolProfile : undefined,
      capabilities: Array.isArray(item.capabilities)
        ? item.capabilities.filter((entry): entry is string => typeof entry === 'string')
        : [],
      defaultParameters:
        item.defaultParameters && typeof item.defaultParameters === 'object'
          ? item.defaultParameters
          : {},
      creditPrice: item.creditPrice ?? null,
      routeCount: Number.isFinite(item.routeCount) ? Number(item.routeCount) : 0,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    }]
  })
}

function isServiceType(value: unknown): value is AiServiceType {
  return value === 'TEXT' || value === 'IMAGE' || value === 'VIDEO' || value === 'TTS'
}

export function platformModelPriceLabel(model: PlatformModelCatalogItem) {
  const price = model.creditPrice
  if (!price) return '未配置额度价格'
  if (price.description) return price.description
  switch (price.pricingMode) {
    case 'PER_IMAGE':
      return `${price.unitPoints} 点/张`
    case 'VIDEO_SECOND':
      return `${price.unitPoints} 点/秒`
    case 'TTS_1K_CHAR':
      return `${price.unitPoints} 点/千字`
    case 'TOKEN':
      if (price.input1kTokenPoints === price.output1kTokenPoints) {
        return `${price.input1kTokenPoints} 点/千 Token`
      }
      return `输入 ${price.input1kTokenPoints} / 输出 ${price.output1kTokenPoints} 点/千 Token`
    default:
      return `${Math.max(price.minimumPoints, price.basePoints + price.unitPoints)} 点/次`
  }
}

export function platformModelOptionLabel(model: PlatformModelCatalogItem) {
  const price = platformModelPriceLabel(model)
  return `${model.displayName} · ${price}`
}
