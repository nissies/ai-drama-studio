import type { LocalAsset, LocalAssetCategory } from '../desktop/types'

export function imageAssetsForCategory(
  assets: LocalAsset[],
  category: Extract<LocalAssetCategory, 'characters' | 'scenes'>,
  query = '',
) {
  const keyword = query.trim().toLowerCase()
  return assets.filter(
    (asset) =>
      asset.fileAvailable &&
      asset.category === category &&
      asset.mimeType.startsWith('image/') &&
      (!keyword || asset.originalName.toLowerCase().includes(keyword)),
  )
}
