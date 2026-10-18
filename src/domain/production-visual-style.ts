export type ImageGenerationCategory = 'characters' | 'scenes' | 'storyboards'

export type VisualStyleId =
  | 'CINEMATIC_DIGITAL_HUMAN'
  | 'PREMIUM_2_5D_ANIMATION'
  | 'CINEMATIC_2D_ANIMATION'
  | 'STYLIZED_3D_ANIMATION'
  | 'CHINESE_AESTHETIC_ANIMATION'
  | 'CHIBI_ANIMATION'

export interface VisualStylePreset {
  id: VisualStyleId
  label: string
  description: string
  moderationNotice?: string
  aliases: readonly string[]
  imagePrompt: string
  negativePrompt: string
  videoPrompt: string
}

export const DEFAULT_VISUAL_STYLE_ID: VisualStyleId = 'PREMIUM_2_5D_ANIMATION'

const CATEGORY_PROMPT: Record<ImageGenerationCategory, string> = {
  characters:
    '角色资产制作要求：把角色作为可长期复用的虚构视觉角色资产。强化独特剪影、稳定的面部结构、发型轮廓、服装结构、配色和标志性配件；正面、侧面、背面及近景必须属于同一身份并严格使用项目选定的视觉风格。不得复刻任何具体真人、明星或公众人物。',
  scenes:
    '场景资产制作要求：使用与项目角色完全一致的美术体系，空间透视、材质概括、色彩关系和光影层次清晰，保留可供角色表演与运镜的空间。画面是纯环境设定，不出现人物、人体、脸、手、照片人物、雕像或人形剪影。',
  storyboards:
    '关键帧制作要求：画面必须像同一部短剧的正式成片关键帧。严格继承已关联角色图的脸型、五官比例、发型、服装与配色，以及场景图的空间结构和光线逻辑；只改变本镜头需要的姿势、表情、构图和景别，不得改变项目视觉风格或角色身份。',
}

const COMMON_NEGATIVE =
  '具体真人复刻，明星肖像，公众人物相似度，照片换脸，身份漂移，脸型漂移，五官漂移，发型漂移，服装漂移，风格漂移，年龄漂移，多余人物，重复人物，多余手指，缺失手指，融合肢体，断肢，错误关节，畸形五官，文字乱码，随机汉字，水印，平台标志，低清晰度，严重噪点，过曝，死黑阴影'

const CATEGORY_NEGATIVE: Record<ImageGenerationCategory, string> = {
  characters:
    '无辨识度模板脸，普通路人造型，错误三视图，重复视角，姿势合并，人物重叠，裁切头部，裁切脚部，服装结构不一致，发型不一致',
  scenes:
    '人物，人体，脸，手，脚，人群，人影，人形剪影，倒影中的人，人物照片，海报人物，雕像，人体模型',
  storyboards:
    '角色身份不一致，参考人物变脸，场景结构漂移，错误景别，错误机位，人物比例异常，画面风格突变',
}

export const VISUAL_STYLE_PRESETS: readonly VisualStylePreset[] = [
  {
    id: 'CINEMATIC_DIGITAL_HUMAN',
    label: '电影感半写实数字人',
    description:
      '接近真人比例和影视级 CG 质感，但角色是不存在于现实中的虚构数字演员，适合都市、悬疑、情感和仙侠短剧。',
    moderationNotice:
      '该风格接近真人，部分视频模型仍可能判定为疑似真实人物；使用平滑 CG 肤质并避免上传真人照片可降低风险。',
    aliases: ['半写实', '数字人', '电影感', '写实电影', 'cinematic', 'digital human'],
    imagePrompt:
      '项目视觉风格锁定：电影感半写实数字人短剧，高精度半写实 CG 角色与影视级建模质感。角色采用自然成年人比例、可信的面部结构与克制表情，但必须明确是不存在于现实中的虚构 CG 数字演员。五官精修且略带艺术设计，皮肤细腻通透、具有柔和次表面散射和轻微可见的自然微纹理，避免粗大毛孔与照片级人脸复刻；头发轻盈自然并以清晰发束组织，服装、首饰和鞋履使用可信的丝绸、金属、宝石、皮革、薄纱或羽毛等真实材质反射。使用高级短剧的柔和电影布光、自然景深、清楚眼神光、空气层次和干净色彩分级，呈现高质量 AI 数字演员成片观感。不得复制任何真实人物、明星、网红或参考照片中的具体人脸，不得变成纪实摄影、手机自拍视频、证件照、蜡像或廉价塑料人。',
    negativePrompt:
      '真实人物身份，真实照片复刻，真实人脸换脸，明星脸，网红脸，公众人物，纪实摄影，新闻照片，手机自拍，证件照，粗大毛孔，过量汗毛，摄影噪点，未经设计的真人皮肤，恐怖谷，蜡像感，硅胶脸，廉价塑料人，过度磨皮',
    videoPrompt:
      '视频全程保持电影感半写实数字人制式：角色接近真人比例但始终是虚构 CG 数字演员，使用细腻通透且微纹理稳定的 CG 肤质、稳定的精修五官、自然发束和影视化服装材质。运动中不得突然增加粗大毛孔、汗毛或摄影噪点，不得变成具体真人、明星、网红、蜡像或廉价塑料人。',
  },
  {
    id: 'PREMIUM_2_5D_ANIMATION',
    label: '精品 2.5D 动漫',
    description:
      '设计化五官、图形化皮肤明暗与电影光影结合，兼顾动漫辨识度和短剧沉浸感。',
    aliases: ['2.5d', '2.5d动漫', '动漫短剧', '精品动漫'],
    imagePrompt:
      '项目视觉风格锁定：精品 2.5D 动漫短剧正式成片美术。采用设计化且稳定的五官比例、清晰有记忆点的脸型与轮廓、干净的图形化皮肤明暗、成束设计的发丝，以及动画化概括但层次丰富的服装与材质。使用精确轮廓光、色彩脚本和电影化景深，人物必须始终明显是虚构动漫角色。整体达到商业动画短剧的主角级完成度，精致、统一、可连续生产，不得转为真人摄影、演员定妆照或模板化 AI 人像。',
    negativePrompt:
      '真人，真人演员，真人照片，实拍，摄影棚人像，写实人像，照片级皮肤，皮肤毛孔，自拍，证件照，Cosplay，明星脸，AI网红脸，廉价塑料3D，低幼卡通，模板脸，普通游戏捏脸',
    videoPrompt:
      '视频全程锁定为精品 2.5D 动漫短剧成片：人物始终保持设计化五官、图形化皮肤明暗、成束发丝和动画材质，不得在运动中真人化、照片化或变成演员。避免廉价塑料 3D、脸型漂移、五官漂移和风格漂移。',
  },
  {
    id: 'CINEMATIC_2D_ANIMATION',
    label: '精致二维动画',
    description:
      '清晰线稿、赛璐璐色块和电影构图，适合青春、奇幻、热血与轻喜剧。',
    aliases: ['二维', '2d动画', '二次元', '日漫', 'anime'],
    imagePrompt:
      '项目视觉风格锁定：精致电影化二维动画。使用专业角色线稿、稳定且有设计感的二维五官、清晰发束轮廓、赛璐璐色块与少量柔和渐变，阴影形状简洁准确，色彩具有统一的动画色彩脚本。画面兼具手绘动画的线条表现力与电影镜头的空间、光线和构图，角色轮廓清楚，表情具有动画表演张力。不得出现真人摄影、照片皮肤、三维塑料模型、粗糙网漫截图或低幼简笔画。',
    negativePrompt:
      '真人照片，实拍，照片皮肤，皮肤毛孔，三维模型，塑料3D，游戏建模，低幼简笔画，粗糙线稿，脏乱线条，平涂无光影，廉价网漫截图，低帧动画残影',
    videoPrompt:
      '视频全程保持精致二维动画制式：线稿粗细、赛璐璐色块、阴影形状、发束轮廓和角色比例稳定，动作使用清楚的关键姿势与自然过渡。不得在运动中转为真人、三维模型、塑料材质或粗糙网漫画面。',
  },
  {
    id: 'STYLIZED_3D_ANIMATION',
    label: '高级风格化 3D',
    description:
      '雕塑感五官、风格化 PBR 材质和电影级灯光，适合冒险、奇幻、科幻与喜剧。',
    aliases: ['3d', '3d动画', '三维', '三维动画', 'cg动画', 'stylized 3d'],
    imagePrompt:
      '项目视觉风格锁定：高级风格化 3D 动画短剧。角色使用经过艺术设计的雕塑感五官、清晰轮廓和动画友好的身体比例，皮肤、头发和服装采用风格化 PBR 材质，细节丰富但不追求真人摄影。使用电影级三维灯光、体积层次、可信空间与精致色彩设计，成片应像成熟商业动画制作而不是游戏默认角色。不得出现廉价塑料材质、僵硬游戏捏脸、真人扫描、蜡像、低模穿模或无设计感的通用素材。',
    negativePrompt:
      '真人扫描，真人照片，照片皮肤，廉价塑料3D，蜡像，硅胶脸，默认游戏角色，普通游戏捏脸，低多边形，穿模，材质丢失，僵硬绑定，错误拓扑，低质量渲染',
    videoPrompt:
      '视频全程保持高级风格化 3D 动画制式：雕塑感五官、角色比例、PBR 材质、发型体块和电影灯光稳定，动作符合成熟动画表演。不得转成真人扫描、默认游戏角色、蜡像、廉价塑料材质或低模画面。',
  },
  {
    id: 'CHINESE_AESTHETIC_ANIMATION',
    label: '新国风动画',
    description:
      '东方造型、工笔线性与水墨气韵结合现代电影光影，适合古装、仙侠和志怪故事。',
    aliases: ['国风', '新国风', '水墨', '古风', '仙侠', 'chinese animation'],
    imagePrompt:
      '项目视觉风格锁定：高品质新国风动画短剧。角色造型遵循东方审美与时代依据，使用工笔式清晰线性、含蓄设计化五官、层次分明的衣纹与发冠结构；场景融合水墨气韵、矿物色彩和现代电影光影，虚实关系克制，空间可供表演与运镜。画面精致而非古风影楼写真，不擅自添加无依据的龙凤纹、文字、符咒或繁复装饰。不得变成真人古装剧照、廉价手游立绘、泛黄滤镜或单纯水墨涂抹。',
    negativePrompt:
      '真人古装剧照，影楼古装写真，廉价手游立绘，随机龙凤纹，随机符咒，随机书法，满屏文字，泛黄滤镜，脏水墨，服饰时代混乱，塑料盔甲，廉价仙侠服',
    videoPrompt:
      '视频全程保持新国风动画制式：东方五官设计、工笔线性、衣纹结构、水墨虚实和矿物色彩稳定，运镜具有含蓄的东方空间节奏。不得转成真人古装剧、廉价手游 CG、泛黄滤镜或随机水墨特效。',
  },
  {
    id: 'CHIBI_ANIMATION',
    label: '萌系 Q 版动画',
    description:
      '大头小身、清晰表情和精致玩具感材质，适合轻喜剧、萌系日常和角色小形态。',
    aliases: ['q版', '萌系', '可爱', '小形态', 'chibi'],
    imagePrompt:
      '项目视觉风格锁定：精品萌系 Q 版动画短剧。角色使用稳定的二点五到四头身比例、圆润但有辨识度的脸型、清晰大眼与简洁高效的表情设计；头发、服装和标志性配件保留原角色识别点，并转化为精致、可动画化的简化体块。使用明快但不刺眼的配色、柔和动画光影和高级玩具感材质，画面可爱但不低幼、不粗糙。不得出现真人身体比例、婴儿照片、廉价贴纸感、塑料公仔翻拍或无身份差异的通用萌脸。',
    negativePrompt:
      '真人比例，真人照片，婴儿照片，写实皮肤，低幼简笔画，廉价贴纸，塑料公仔翻拍，通用萌脸，无身份差异，头身比例漂移，四肢过长，恐怖大眼，幼儿园素材',
    videoPrompt:
      '视频全程保持精品 Q 版动画制式：头身比例、圆润脸型、大眼结构、简化发束、服装识别点和高级玩具感材质稳定，动作轻快且重心可信。不得在运动中恢复真人比例、变成婴儿照片、廉价贴纸或塑料公仔翻拍。',
  },
]

export function resolveVisualStyle(value?: string | null): VisualStylePreset {
  const normalized = value?.trim().toLowerCase() ?? ''
  const compact = compactStyleName(normalized)
  const exact = VISUAL_STYLE_PRESETS.find(
    (preset) =>
      preset.id.toLowerCase() === normalized ||
      compactStyleName(preset.label) === compact ||
      preset.aliases.some((alias) => compactStyleName(alias) === compact),
  )
  if (exact) return exact

  const inferred = VISUAL_STYLE_PRESETS.find((preset) =>
    preset.aliases.some((alias) => compact.includes(compactStyleName(alias))),
  )
  return inferred ?? visualStylePreset(DEFAULT_VISUAL_STYLE_ID)
}

export function visualStylePreset(id: VisualStyleId): VisualStylePreset {
  return (
    VISUAL_STYLE_PRESETS.find((preset) => preset.id === id) ??
    VISUAL_STYLE_PRESETS.find((preset) => preset.id === DEFAULT_VISUAL_STYLE_ID)!
  )
}

export function visualStyleLabel(value?: string | null): string {
  return resolveVisualStyle(value).label
}

export function applyProjectVisualStyle(
  currentPrompt: string,
  category: ImageGenerationCategory,
  visualStyle?: string | null,
): string {
  let normalized = stripImageStyle(currentPrompt)
  const preset = resolveVisualStyle(visualStyle)
  normalized = [normalized, preset.imagePrompt, CATEGORY_PROMPT[category]]
    .filter(Boolean)
    .join('\n\n')
  return normalized
}

export function applyProjectVisualNegativeStyle(
  currentPrompt: string,
  category: ImageGenerationCategory,
  visualStyle?: string | null,
): string {
  let normalized = stripNegativeStyle(currentPrompt)
  const preset = resolveVisualStyle(visualStyle)
  normalized = [normalized, COMMON_NEGATIVE, preset.negativePrompt, CATEGORY_NEGATIVE[category]]
    .filter(Boolean)
    .join('，')
  return normalized
}

export function projectVideoStylePrompt(visualStyle?: string | null): string {
  const preset = resolveVisualStyle(visualStyle)
  return `${preset.imagePrompt}\n${preset.videoPrompt}\n参考素材只用于锁定角色身份、造型、场景结构和所选美术制式，不得复刻任何具体真人、明星或公众人物。`
}

function stripImageStyle(value: string): string {
  let normalized = value.trim()
  for (const suffix of Object.values(CATEGORY_PROMPT)) {
    normalized = removeTrailingBlock(normalized, suffix)
  }
  for (const preset of VISUAL_STYLE_PRESETS) {
    normalized = removeTrailingBlock(normalized, preset.imagePrompt)
  }
  return normalized
}

function stripNegativeStyle(value: string): string {
  let normalized = value.trim()
  for (const suffix of Object.values(CATEGORY_NEGATIVE)) {
    normalized = removeTrailingListItem(normalized, suffix)
  }
  for (const preset of VISUAL_STYLE_PRESETS) {
    normalized = removeTrailingListItem(normalized, preset.negativePrompt)
  }
  return removeTrailingListItem(normalized, COMMON_NEGATIVE)
}

function removeTrailingBlock(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length).trim() : value
}

function removeTrailingListItem(value: string, suffix: string): string {
  return value.endsWith(suffix)
    ? value.slice(0, -suffix.length).replace(/[，,\s]+$/u, '').trim()
    : value
}

function compactStyleName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}
