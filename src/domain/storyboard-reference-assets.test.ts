import { describe, expect, it } from 'vitest'
import { storyboardReferenceAssets } from './storyboard-reference-assets'

describe('storyboard reference assets', () => {
  it('selects the scene overview and the base character reference', () => {
    const result = storyboardReferenceAssets(
      { sceneId: 'scene-1', characterIds: ['character-1'] },
      [
        {
          id: 'character-1',
          name: '许七安',
          forms: [
            {
              id: 'form-1',
              formCode: 'F1',
              formCategory: 'APPEARANCE',
              displayName: '默认形态',
              defaultForm: true,
            },
          ],
        },
      ],
      [{ id: 'scene-1', title: '厢房' }],
      [
        {
          id: 'reference-1',
          characterId: 'character-1',
          assetId: 'asset-character',
          viewType: 'TURNAROUND_PORTRAIT',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
      ],
      [
        {
          id: 'reference-2',
          episodeId: 'episode-1',
          sceneId: 'scene-1',
          assetId: 'asset-scene',
          referenceType: 'OVERVIEW',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
      ],
    )

    expect(result).toEqual([
      { assetId: 'asset-scene', label: '场景：厢房' },
      {
        assetId: 'asset-character',
        label: '角色基础图：许七安（三视图/上半身）',
      },
    ])
  })

  it('prefers the base character image and does not auto-carry costume or weapon forms', () => {
    const result = storyboardReferenceAssets(
      { characterIds: ['character-1'] },
      [
        {
          id: 'character-1',
          name: '许七安',
          forms: [
            {
              id: 'form-a',
              formCode: 'A',
              formCategory: 'APPEARANCE',
              displayName: '本相',
              defaultForm: true,
            },
            {
              id: 'form-c',
              formCode: 'C',
              formCategory: 'COSTUME',
              displayName: '战斗装',
              defaultForm: true,
            },
            {
              id: 'form-w',
              formCode: 'W',
              formCategory: 'WEAPON',
              displayName: '长剑',
              defaultForm: true,
            },
          ],
        },
      ],
      [],
      [
        {
          id: 'base',
          characterId: 'character-1',
          assetId: 'asset-base',
          viewType: 'CHARACTER_SHEET',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
        {
          id: 'r1',
          characterId: 'character-1',
          characterFormId: 'form-a',
          assetId: 'asset-a',
          viewType: 'FRONT',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
        {
          id: 'r2',
          characterId: 'character-1',
          characterFormId: 'form-c',
          assetId: 'asset-c',
          viewType: 'FRONT',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
        {
          id: 'r3',
          characterId: 'character-1',
          characterFormId: 'form-w',
          assetId: 'asset-w',
          viewType: 'FRONT',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
      ],
      [],
    )

    expect(result).toEqual([{ assetId: 'asset-base', label: '角色基础图：许七安（完整设定板）' }])
  })

  it('matches a scene background by storyboard title or location when scene id is missing', () => {
    const result = storyboardReferenceAssets(
      {
        characterIds: [],
        title: 'A点交叉防守与捷风驰援',
        location: '日落之城A点',
      },
      [],
      [
        { id: 'scene-a', title: 'A点——冰墙挡弹', location: '日落之城A点' },
        { id: 'scene-b', title: 'B点墙角——浴火', location: '日落之城B点墙角' },
      ],
      [],
      [
        {
          id: 'reference-scene-a',
          episodeId: 'episode-1',
          sceneId: 'scene-a',
          assetId: 'asset-scene-a',
          referenceType: 'OVERVIEW',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
      ],
    )

    expect(result).toEqual([{ assetId: 'asset-scene-a', label: '场景：A点——冰墙挡弹' }])
  })

  it('falls back only to the default appearance form when no base image exists', () => {
    const result = storyboardReferenceAssets(
      { characterIds: ['character-1'] },
      [
        {
          id: 'character-1',
          name: '许七安',
          forms: [
            {
              id: 'form-a',
              formCode: 'A',
              formCategory: 'APPEARANCE',
              displayName: '本相',
              defaultForm: true,
            },
            {
              id: 'form-w',
              formCode: 'W',
              formCategory: 'WEAPON',
              displayName: '长剑',
              defaultForm: true,
            },
          ],
        },
      ],
      [],
      [
        {
          id: 'r1',
          characterId: 'character-1',
          characterFormId: 'form-a',
          assetId: 'asset-a',
          viewType: 'FRONT',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
        {
          id: 'r2',
          characterId: 'character-1',
          characterFormId: 'form-w',
          assetId: 'asset-w',
          viewType: 'FRONT',
          primaryReference: true,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
      ],
      [],
    )

    expect(result).toEqual([
      { assetId: 'asset-a', label: '角色基础图：许七安/默认形态·本相（正面）' },
    ])
  })

  it('falls back to an available character reference when the default form has none', () => {
    const result = storyboardReferenceAssets(
      { characterIds: ['character-1'] },
      [{ id: 'character-1', name: '角色', forms: [] }],
      [],
      [
        {
          id: 'reference-1',
          characterId: 'character-1',
          assetId: 'asset-front',
          viewType: 'FRONT',
          primaryReference: false,
          sortOrder: 0,
          version: 0,
          updatedAt: '',
        },
      ],
      [],
    )

    expect(result).toEqual([{ assetId: 'asset-front', label: '角色基础图：角色（正面）' }])
  })

  it('deduplicates an asset shared by two selected characters', () => {
    const sharedReference = {
      id: 'reference-1',
      assetId: 'asset-shared',
      viewType: 'FRONT' as const,
      primaryReference: true,
      sortOrder: 0,
      version: 0,
      updatedAt: '',
    }
    const result = storyboardReferenceAssets(
      { characterIds: ['character-1', 'character-2'] },
      [
        { id: 'character-1', name: '甲', forms: [] },
        { id: 'character-2', name: '乙', forms: [] },
      ],
      [],
      [
        { ...sharedReference, characterId: 'character-1' },
        { ...sharedReference, id: 'reference-2', characterId: 'character-2' },
      ],
      [],
    )

    expect(result).toEqual([
      { assetId: 'asset-shared', label: '角色基础图：甲（正面）、角色基础图：乙（正面）' },
    ])
  })
})
