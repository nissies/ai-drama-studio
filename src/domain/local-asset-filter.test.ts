import { describe, expect, it } from 'vitest'
import type { LocalAsset } from '../desktop/types'
import { imageAssetsForCategory } from './local-asset-filter'

function asset(id: string, category: LocalAsset['category'], originalName: string): LocalAsset {
  return {
    id,
    category,
    originalName,
    relativePath: `assets/${category}/${originalName}`,
    sizeBytes: 128,
    sha256: id.repeat(64).slice(0, 64),
    mimeType: 'image/png',
    importedAt: '2026-08-05T00:00:00Z',
    fileAvailable: true,
  }
}

describe('imageAssetsForCategory', () => {
  const assets = [
    asset('a', 'characters', 'hero.png'),
    asset('b', 'scenes', 'prison.png'),
    asset('c', 'images', 'loose.png'),
  ]

  it('keeps character and scene libraries isolated', () => {
    expect(imageAssetsForCategory(assets, 'scenes').map((item) => item.id)).toEqual(['b'])
    expect(imageAssetsForCategory(assets, 'characters').map((item) => item.id)).toEqual(['a'])
  })

  it('applies search only inside the selected category', () => {
    expect(imageAssetsForCategory(assets, 'scenes', 'hero')).toEqual([])
    expect(imageAssetsForCategory(assets, 'scenes', 'prison').map((item) => item.id)).toEqual(['b'])
  })
})
