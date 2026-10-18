import type { CharacterViewType } from '../../api/assets'
import type { ImageCompositionType, ImageSize } from '../../api/image-generation'

export interface CharacterReferencePreset {
  value: ImageCompositionType
  label: string
  description: string
  recommendedSize: ImageSize
  viewType: CharacterViewType
  promptSuffix: string
}

/** @deprecated 角色统一按主角规格生成，保留类型仅兼容历史代码 */
export type CharacterDesignTier = 'LEAD' | 'SUPPORTING' | 'EXTRA'

export interface CharacterDesignTierPreset {
  value: CharacterDesignTier
  label: string
  description: string
  promptSuffix: string
  negativePromptSuffix: string
}

const IDENTITY_LOCK =
  '角色身份一致性锁定：所有视角必须是同一个虚构角色，保持完全相同的五官比例、脸型、发型轮廓、发色、年龄、体型、肤色、服装结构、材质、配色、鞋履、饰品和视觉气质；全部视图严格遵循项目选定的视觉风格，不得复刻任何具体真人、明星或公众人物。'

const REFERENCE_IMAGE_LOCK =
  '参考图强制约束：如果提供了参考图，必须严格参考参考图中的人物外貌、五官比例、脸型、发型、发色、体型、肤色、服装结构、配色、材质、鞋履、饰品和整体气质进行精修与多视图展开；不得忽略参考图另起炉灶，不得换成完全不同的脸、发型、服装或风格。可在参考图基础上做专业设定板排版与细节精修，但身份识别特征必须可追溯到参考图。'

const LEAD_QUALITY_PROMPT = `角色精修标准：按商业短剧主角级制作规格设计。根据角色身份、职业、时代、世界观、性格与剧情经历，设计独特且可识别的脸部特征、发型轮廓、身体语言和标志性服装；造型必须有明确的视觉主题、主次配色、材质对比、精细剪裁和具有剧情意义的配件，近看有高级细节，缩小后仍能凭轮廓认出。使用商业短剧主角级脸部设计、发型组织、服装层次、材质表现和视觉焦点，避免模板脸、影楼服、廉价布料、通用古装、灰色路人服与没有身份依据的造型。角色必须是虚构视觉角色，不得复刻具体真人、明星、公众人物或网红。任何图案、徽记或配件都必须来自角色设定，不得擅自添加文字、囚字、号码、胸牌或随机符号。`

const LEAD_NEGATIVE_PROMPT =
  '具体真人复刻，明星脸，公众人物相似度，路人感，模板脸，普通灰衣，无设计感的灰色囚服，随机囚字，随机汉字，随机胸牌，号码牌，无依据徽记，廉价布料，通用影楼服，造型缺乏视觉焦点，忽略参考图，换脸，换发型，换服装结构'

const CHARACTER_DESIGN_EXECUTION_PROMPT = `角色设计深化要求：根据已有身份、职业、年龄、时代、世界观、性格和剧情经历，把角色描述落实为可见且相互统一的生产细节。明确处理身高体型与头身比例；脸型、五官比例、肤色与皮肤材质；眼睛颜色、眼神和符合性格的微表情；发型结构、发色渐变、发丝或发束状态；服装廓形、内外层剪裁、主次配色和剧情合理性；布料、金属、皮革、薄纱、羽毛、宝石等材质的差异；头饰、耳饰、项链、腰饰、手部配件与鞋履；站姿、手势和角色特有的气质。光影、环境效果和装饰元素必须服务角色主题，不得用随机华丽细节掩盖身份。
所有设计细节必须在整张设定板的全部视图中保持一致，不额外添加无法识别的标签、乱码文字或水印。`

/** 历史兼容：普通三视图，仍可解析旧候选，但不再作为生图入口选项 */
const TURNAROUND_PROMPT = `制作一张商业短剧制作级角色三视图设定板。${IDENTITY_LOCK}
${REFERENCE_IMAGE_LOCK}
在同一张横向画布中清晰呈现正面全身、标准侧面全身、背面全身。三个视角彼此独立并保留充足留白，镜头高度、人物尺寸和脚底基线一致；人物采用自然中立站姿，从头顶到鞋底完整可见。重点表现清晰的面部结构、发型分组与轮廓、服装剪裁、材质层次、配色和标志性配件，便于后续图像与视频生成复用。使用符合项目视觉风格的克制概念设计用光和干净中性背景，画面精致、统一、可制作。不要场景叙事、动作连续帧、重叠人物、合并姿势、裁切头部或肢体、边框、网格、蓝图线、重复转场、文字乱码、标签和水印。`

/**
 * 三视图 + 上半身：
 * 左侧大图 = 上半身近景
 * 右侧 = 正面 / 侧面 / 背面三视图
 * 对齐用户提供的商业角色设定参考排版
 */
const TURNAROUND_PORTRAIT_PROMPT = `创建一张电影感、高级角色艺术书风格的角色身份板。${IDENTITY_LOCK}
${REFERENCE_IMAGE_LOCK}
必须在同一张横向宽幅画布内且只包含四个角色视图，并严格遵守以下左右排版：
左侧区域（约占画布 40%-45%）：放置一个较大的正面上半身近景，作为视觉焦点，清晰展示五官、眼神、发型、头饰、耳饰和上装材质细节；
右侧区域（约占画布 55%-60%）：从左到右依次排列正面全身、标准侧面全身、背面全身三视图，三视图彼此独立、互不遮挡，镜头高度、身体比例和脚底基线一致。
禁止把三视图放在左侧、禁止把上半身近景放到右侧或角落。四个视图必须视觉分离，保持大片留白和专业艺术书排版，不使用僵硬等宽网格。
三个全身视图采用自然中立站姿，从头顶到鞋底完整可见；上半身近景保持同一身份、同一服装和同一光线。画面应清晰展示脸部形状、发型轮廓、身体比例、手部、服装轮廓、材质、配色和具有剧情依据的标志性配件，整体像用于后续图像与视频一致性制作的专业角色圣经。
风格要求：严格使用项目选定的视觉风格和对应材质语言，使用高质量角色概念设计用光；干净、精致、富有表现力，背景简洁中性，主体清晰锐利。不要添加第五个人物视图，不要黑色小轮廓、表情小样、材质色块、服装小样、文字说明或胸牌；不要场景叙事、连续动作帧、人物重叠、姿势合并、隐藏肢体、裁切头部或脚部、网络拼图、蓝图、密集表格、重复视角、装饰边框、文字乱码、标签和水印。`

/**
 * 完整角色设定板：
 * 1. 左侧全身形象
 * 2. 三视图
 * 3. 服装与饰品/武器拆解
 * 4. 表情情绪
 */
const CHARACTER_SHEET_PROMPT = `创建一张专业商业动画/短剧角色完整设定板（Character Design Sheet / Character Bible）。${IDENTITY_LOCK}
${REFERENCE_IMAGE_LOCK}
必须在同一张横向宽幅画布中包含以下四个明确分区，整体像高端角色设定艺术书，分区清楚、互不遮挡、排版精致：

1. 左侧「角色全身形象」：一个较大的完整全身主视觉，展示角色标志性站姿、服装全貌、配色、材质、气质和整体轮廓，作为整张图的视觉锚点。
2. 中上部「三视角图」：正面全身、侧面全身、背面全身，三个视图独立排列，镜头高度、身体比例和脚底基线一致，完整展示服装前后结构与轮廓。
3. 右上部「服装与饰品/武器」：把角色关键服装单品、披肩/外套、鞋履，以及项链、耳饰、手链、头饰、武器等标志性配件拆解成独立小图，清晰展示材质与设计细节；只展示与该角色设定相关的物品，不要编造无关道具。
4. 下部「表情情绪」：同一角色的 4 到 6 个面部表情近景（如冷漠、沉思、微笑、挑衅、忧郁、坚定等，按角色性格选择），保持完全一致的五官、发型、妆造和头饰，仅改变表情与微情绪。

风格要求：严格使用项目选定的视觉风格；干净深色或中性背景；高质量概念设计用光；主体清晰锐利；专业制作级细节。
禁止：场景叙事大场面、连续动作分镜、人物重叠、换脸、换发型、换服装、随机文字乱码、胸牌号码、水印、蓝图网格、低质拼贴、与角色无关的额外物品。`

/** 角色生图入口仅展示这两项 */
export const CHARACTER_COMPOSITION_OPTIONS: readonly CharacterReferencePreset[] = [
  {
    value: 'TURNAROUND_PORTRAIT',
    label: '三视图 + 上半身',
    description: '左侧上半身近景，右侧正面/侧面/背面三视图，适合角色身份锁定。',
    recommendedSize: '2048x1152',
    viewType: 'TURNAROUND_PORTRAIT',
    promptSuffix: TURNAROUND_PORTRAIT_PROMPT,
  },
  {
    value: 'CHARACTER_SHEET',
    label: '完整角色设定板',
    description: '全身形象 + 三视图 + 服装饰品/武器拆解 + 表情情绪，适合完整角色圣经。',
    recommendedSize: '2048x1152',
    viewType: 'CHARACTER_SHEET',
    promptSuffix: CHARACTER_SHEET_PROMPT,
  },
]

/** 含历史兼容项，供旧候选展示与 prompt 去重 */
export const CHARACTER_REFERENCE_PRESETS: readonly CharacterReferencePreset[] = [
  {
    value: 'SINGLE',
    label: '普通单图',
    description: '生成单个人物画面，适合补充特定姿势或镜头。',
    recommendedSize: '1152x2048',
    viewType: 'FRONT',
    promptSuffix: '',
  },
  {
    value: 'TURNAROUND',
    label: '三视图设定图',
    description: '同一张图包含正面、侧面和背面，使用专业角色设定板排版。',
    recommendedSize: '2048x1152',
    viewType: 'TURNAROUND',
    promptSuffix: TURNAROUND_PROMPT,
  },
  ...CHARACTER_COMPOSITION_OPTIONS,
]

/** @deprecated 角色已统一主角规格，仅保留兼容导出 */
export const CHARACTER_DESIGN_TIERS: readonly CharacterDesignTierPreset[] = [
  {
    value: 'LEAD',
    label: '主角精修',
    description: '电影主角级脸部辨识度、标志性服装与材质细节。',
    promptSuffix: LEAD_QUALITY_PROMPT,
    negativePromptSuffix: LEAD_NEGATIVE_PROMPT,
  },
  {
    value: 'SUPPORTING',
    label: '重要配角',
    description: '已统一按主角规格生成。',
    promptSuffix: LEAD_QUALITY_PROMPT,
    negativePromptSuffix: LEAD_NEGATIVE_PROMPT,
  },
  {
    value: 'EXTRA',
    label: '普通角色',
    description: '已统一按主角规格生成。',
    promptSuffix: LEAD_QUALITY_PROMPT,
    negativePromptSuffix: LEAD_NEGATIVE_PROMPT,
  },
]

export function defaultImageComposition(
  category: 'characters' | 'scenes' | 'storyboards',
): ImageCompositionType {
  return category === 'characters' ? 'TURNAROUND_PORTRAIT' : 'SINGLE'
}

export function referencePreset(value: ImageCompositionType): CharacterReferencePreset {
  return (
    CHARACTER_REFERENCE_PRESETS.find((preset) => preset.value === value) ??
    CHARACTER_COMPOSITION_OPTIONS[0]
  )
}

export function recommendedImageSize(value: ImageCompositionType): ImageSize {
  return referencePreset(value).recommendedSize
}

export function referenceViewType(value: ImageCompositionType): CharacterViewType {
  return referencePreset(value).viewType
}

export function applyCharacterReferencePreset(
  currentPrompt: string,
  value: ImageCompositionType,
  _tier?: CharacterDesignTier,
  options?: { hasReferenceImages?: boolean },
): string {
  const basePrompt = removeTrailingPreset(currentPrompt)
  const compositionSuffix = referencePreset(value).promptSuffix
  const referenceLock =
    options?.hasReferenceImages && compositionSuffix
      ? '请严格参考我提供的参考图进行精修与多视图展开，保持同一人物身份，不得忽略参考图。'
      : options?.hasReferenceImages
        ? REFERENCE_IMAGE_LOCK
        : ''
  return [basePrompt, LEAD_QUALITY_PROMPT, CHARACTER_DESIGN_EXECUTION_PROMPT, referenceLock, compositionSuffix]
    .filter(Boolean)
    .join('\n\n')
}

export function applyCharacterNegativePreset(
  currentPrompt: string,
  tier?: CharacterDesignTier,
): string {
  void tier
  let normalized = currentPrompt.trim()
  for (const preset of CHARACTER_DESIGN_TIERS) {
    if (preset.negativePromptSuffix && normalized.endsWith(preset.negativePromptSuffix)) {
      normalized = normalized
        .slice(0, -preset.negativePromptSuffix.length)
        .replace(/,\s*$/, '')
        .trim()
    }
  }
  // 去重：旧版不同 tier 负向词
  const legacyNegatives = [
    '路人感，随机汉字，随机胸牌，号码牌，无依据徽记，服装结构敷衍',
    '随机汉字，随机胸牌，号码牌，无依据徽记，错误服装结构',
  ]
  for (const legacy of legacyNegatives) {
    if (normalized.endsWith(legacy)) {
      normalized = normalized.slice(0, -legacy.length).replace(/,\s*$/, '').trim()
    }
  }
  return [normalized, LEAD_NEGATIVE_PROMPT].filter(Boolean).join(', ')
}

export function characterDesignTier(value?: CharacterDesignTier): CharacterDesignTierPreset {
  void value
  return CHARACTER_DESIGN_TIERS[0]
}

export function defaultCharacterDesignTier(roleType?: string): CharacterDesignTier {
  void roleType
  return 'LEAD'
}

function removeTrailingPreset(prompt: string): string {
  let normalized = prompt.trim()
  // 先移除构图后缀（从长到短更稳妥：当前数组已含全部）
  for (const preset of [...CHARACTER_REFERENCE_PRESETS].reverse()) {
    if (preset.promptSuffix && normalized.endsWith(preset.promptSuffix)) {
      normalized = normalized.slice(0, -preset.promptSuffix.length).trim()
    }
  }
  // 旧版参考图锁 / 新版参考图锁
  if (normalized.endsWith(REFERENCE_IMAGE_LOCK)) {
    normalized = normalized.slice(0, -REFERENCE_IMAGE_LOCK.length).trim()
  }
  const legacyReferenceLock =
    '请严格参考我提供的参考图进行精修与多视图展开，保持同一人物身份，不得忽略参考图。'
  if (normalized.endsWith(legacyReferenceLock)) {
    normalized = normalized.slice(0, -legacyReferenceLock.length).trim()
  }
  if (normalized.endsWith(CHARACTER_DESIGN_EXECUTION_PROMPT)) {
    normalized = normalized.slice(0, -CHARACTER_DESIGN_EXECUTION_PROMPT.length).trim()
  }
  // 新旧精修后缀
  const tierSuffixes = [
    LEAD_QUALITY_PROMPT,
    ...CHARACTER_DESIGN_TIERS.map((item) => item.promptSuffix),
    // 旧版文案（若仍残留）
    '主角精修标准：这是能承担整部短剧视觉记忆点的核心主角。根据角色身份、职业、时代、世界观、性格与剧情经历，设计独特且可识别的脸部特征、发型轮廓、身体语言和标志性服装；造型必须有明确的视觉主题、主次配色、材质对比、精细剪裁和具有剧情意义的配件，近看有高级细节，缩小后仍能凭轮廓认出。使用商业短剧主角级脸部设计、发型组织、服装层次、材质表现和视觉焦点，避免模板脸、影楼服、廉价布料、通用古装、灰色路人服与没有身份依据的造型。角色必须是虚构视觉角色，不得复刻具体真人、明星、公众人物或网红。任何图案、徽记或配件都必须来自角色设定，不得擅自添加文字、囚字、号码、胸牌或随机符号。',
    '重要配角标准：造型必须符合角色身份、职业、时代和剧情功能，并拥有一到两个稳定、可复用的视觉识别点。服装剪裁、配色和材质应完整可信，与主角处于同一世界观和制作水准，但视觉复杂度略低于主角。不得使用无剧情依据的文字、号码、胸牌或随机符号。',
    '普通角色标准：优先保证身份准确、轮廓清楚、服装结构可信和后续生成稳定。造型简洁但不能敷衍，不使用随机文字、号码、胸牌、夸张标志或与角色身份无关的装饰。',
  ]
  for (const suffix of tierSuffixes) {
    if (suffix && normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).trim()
    }
  }
  return normalized
}
