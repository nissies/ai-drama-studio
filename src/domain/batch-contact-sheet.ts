import type { Storyboard } from '../api/workspace'

export function buildContactSheetImagePrompt(storyboard: Storyboard, plan: string) {
  return [
    '生成一张电影分镜九宫格参考图，严格为 3 列 x 3 行，共 9 个等尺寸画格。',
    '九格按从左到右、从上到下的时间顺序表现同一个连续视频镜头，不是九张无关海报。',
    `目标视频时长：${Math.max(1, storyboard.durationSec || 5)} 秒。`,
    '保持所有画格中角色脸、发型、服装、身材比例、场景结构、关键道具和光线方向一致。',
    '每格清楚表现构图、动作阶段、视线、人物站位和镜头衔接；允许剧情需要的自然转场。',
    '画格之间使用细窄中性分隔线。画面内禁止标题、数字、水印、对白框、字幕和说明文字。',
    '九格规划：',
    plan.trim(),
  ]
    .filter(Boolean)
    .join('\n')
}

export function contactSheetRecommended(storyboard: Storyboard) {
  return (storyboard.durationSec || 0) >= 10
}

export function contactSheetTimeline(durationSec: number) {
  const duration = Math.max(1, durationSec || 5)
  return Array.from({ length: 9 }, (_, index) => {
    const start = (duration * index) / 9
    const end = (duration * (index + 1)) / 9
    return {
      cell: index + 1,
      start,
      end,
      label: `${formatSecond(start)}-${formatSecond(end)} 秒`,
    }
  })
}

export function contactSheetTimelineInstruction(durationSec: number) {
  return contactSheetTimeline(durationSec)
    .map((item) => `第 ${item.cell} 格=${item.label}`)
    .join('；')
}

export function hasNineContactSheetBeats(plan: string, durationSec?: number) {
  const beats = extractContactSheetBeats(plan)
  if (!beats) return false
  return durationSec === undefined || normalizeContactSheetPlan(plan, durationSec) !== null
}

export function normalizeContactSheetPlan(plan: string, durationSec: number) {
  const beats = extractContactSheetBeats(plan)
  if (!beats) return null
  const timeline = contactSheetTimeline(durationSec)
  return beats
    .map((beat, index) => `${index + 1}. ${timeline[index].label}｜${beat.description}`)
    .join('\n')
}

function extractContactSheetBeats(plan: string) {
  const normalized = plan.replace(
    /(?:；|;)\s*(?=(?:第\s*)?[1-9](?:\s*格)?\s*[.、):：])/g,
    '\n',
  )
  const entries = new Map<number, string>()
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '')
    const match = line.match(/^(?:第\s*)?([1-9])(?:\s*格)?\s*[.、):：]\s*(.+)$/)
    if (!match) continue
    const cell = Number(match[1])
    if (entries.has(cell)) return null
    const description = stripLeadingTimeRange(match[2])
    if (!description) return null
    entries.set(cell, description)
  }
  if (entries.size !== 9 || Array.from({ length: 9 }, (_, index) => !entries.has(index + 1)).some(Boolean)) {
    return null
  }
  return Array.from({ length: 9 }, (_, index) => ({
    cell: index + 1,
    description: entries.get(index + 1)!,
  }))
}

function stripLeadingTimeRange(value: string) {
  return value
    .trim()
    .replace(
      /^\s*(?:\[|【)?\s*\d+(?:\.\d+)?\s*(?:-|~|至|到|—|–)\s*\d+(?:\.\d+)?\s*(?:秒|s)?\s*(?:\]|】)?\s*[｜|:：,，-]?\s*/i,
      '',
    )
    .replace(/^[｜|:：,，-]+\s*/, '')
    .trim()
}

function formatSecond(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '')
}
