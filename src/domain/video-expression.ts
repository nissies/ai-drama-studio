export type ExpressionEmotion =
  'RESTRAINED_ANGER' | 'GRIEF' | 'FEAR' | 'SHOCK' | 'DISTANT' | 'GENTLE_JOY' | 'CUSTOM'

export type ExpressionGaze = 'LOCK_TARGET' | 'AVOID' | 'CAMERA' | 'DOWN' | 'FOLLOW_ACTION'

export interface ExpressionControlInput {
  emotion: ExpressionEmotion
  intensity: number
  gaze: ExpressionGaze
  performanceNote?: string
}

const EMOTION_DETAILS: Record<ExpressionEmotion, string> = {
  RESTRAINED_ANGER: '压抑愤怒；眉头内收并轻微下压，上眼睑收紧，下颌绷紧，嘴唇闭合',
  GRIEF: '悲伤克制；眉头内侧抬起，眼眶湿润，嘴角轻微下压，呼吸不稳但不夸张哭喊',
  FEAR: '紧张恐惧；眉毛抬起并靠拢，眼睛略微睁大，嘴唇轻启，呼吸短促',
  SHOCK: '震惊错愕；眉毛快速抬起，眼睛睁大，嘴唇短暂张开，随后保持僵住',
  DISTANT: '冷漠疏离；面部肌肉放松，眼神缺少回应，嘴唇平直，动作幅度很小',
  GENTLE_JOY: '温柔喜悦；眼轮匝肌轻微收紧，嘴角自然上扬，目光柔和，避免夸张大笑',
  CUSTOM: '按补充要求控制面部表演，保持五官结构稳定并避免夸张表情',
}

const GAZE_DETAILS: Record<ExpressionGaze, string> = {
  LOCK_TARGET: '目光持续锁定对方',
  AVOID: '视线有意识避开对方，偶尔短暂回看',
  CAMERA: '目光看向镜头',
  DOWN: '目光下垂，避免频繁抬眼',
  FOLLOW_ACTION: '视线自然跟随手部动作和场面焦点',
}

export function buildExpressionPrompt(input: ExpressionControlInput) {
  const intensity = Math.max(1, Math.min(5, Math.round(Number(input.intensity) || 1)))
  const note = String(input.performanceNote || '').trim()
  return [
    `面部表演：${EMOTION_DETAILS[input.emotion]}；强度 ${intensity}/5`,
    GAZE_DETAILS[input.gaze],
    note ? `补充表演要求：${note}` : '',
    '保持角色身份、脸型和五官一致；表情变化连续自然；避免喜剧化、过度扭曲和无关口型',
  ]
    .filter(Boolean)
    .join('；')
}

export function normalizeAiExpression(value: string) {
  return String(value || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:优化结果|表情提示词|提示词)\s*[：:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_200)
}
