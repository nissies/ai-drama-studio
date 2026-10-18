export type MotionShotTemplateId =
  | 'DUAL_FIGHT'
  | 'IMPACT_INSERT'
  | 'GROUP_RUSH'
  | 'WIDE_STANDOFF'
  | 'FINISH_BLOW'

export interface MotionShotTemplate {
  id: MotionShotTemplateId
  title: string
  durationHintSec: number
  summary: string
  recommendedMode: 'direct' | 'pose_proxy'
  prompt: string
}

export const MOTION_SHOT_TEMPLATES: MotionShotTemplate[] = [
  {
    id: 'DUAL_FIGHT',
    title: '双人对打',
    durationHintSec: 4,
    summary: '近身攻防、交错站位、连续出拳踢腿',
    recommendedMode: 'pose_proxy',
    prompt:
      '双人近身武打镜头：两人交错站位，连续出拳、格挡、侧闪与踢腿，镜头中近景跟随击打节奏，动作干脆有力，保持角色身份与服装一致。',
  },
  {
    id: 'IMPACT_INSERT',
    title: '击打特写',
    durationHintSec: 2,
    summary: '拳头/兵器命中瞬间的冲击特写',
    recommendedMode: 'direct',
    prompt:
      '击打冲击特写：拳头或兵器命中瞬间，镜头急推到接触点，衣物与发丝受冲击甩动，强调速度线与节奏停顿，不改变角色脸部与服装材质。',
  },
  {
    id: 'GROUP_RUSH',
    title: '群体冲锋',
    durationHintSec: 5,
    summary: '多人冲锋、围攻与站位压迫',
    recommendedMode: 'pose_proxy',
    prompt:
      '群体冲锋武打镜头：多名角色从纵深向镜头压迫冲锋，前排交锋、后排补位，镜头横移或后退跟随，群体站位清晰，动作同步且层次分明。',
  },
  {
    id: 'WIDE_STANDOFF',
    title: '对峙全景',
    durationHintSec: 3,
    summary: '开战前对峙、气势与站位建立',
    recommendedMode: 'direct',
    prompt:
      '武打对峙全景：双方拉开距离对峙，缓慢调整重心与站位，镜头缓慢环绕或推进，强调气势、空间压迫感与即将爆发的紧张感。',
  },
  {
    id: 'FINISH_BLOW',
    title: '终结一击',
    durationHintSec: 3,
    summary: '蓄力到命中的终结动作',
    recommendedMode: 'pose_proxy',
    prompt:
      '终结一击镜头：主角蓄力、起跳或转身发力，对手防守失位后被命中后退，镜头从中景切到冲击瞬间再拉开，动作轨迹清晰，节奏先慢后快。',
  },
]

export function motionShotTemplateById(id: string) {
  return MOTION_SHOT_TEMPLATES.find((item) => item.id === id)
}