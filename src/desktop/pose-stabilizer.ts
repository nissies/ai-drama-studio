import type { PoseProxyFrame, PoseProxyLandmark, PoseProxyMask } from './types'

const MIN_VISIBLE = 0.28
const MAX_TRACK_DISTANCE = 0.32
const MIN_CURRENT_WEIGHT = 0.54
const MAX_CURRENT_WEIGHT = 0.9

interface PoseCandidate {
  pose: PoseProxyLandmark[]
  mask?: PoseProxyMask
}

interface PoseTrack {
  pose: PoseProxyLandmark[]
  mask?: PoseProxyMask
}

/**
 * Keeps identities stable across frames and smooths only the small recognition jitter.
 * Fast movements deliberately retain a higher current-frame weight.
 */
export function stabilizePoseFrames(frames: PoseProxyFrame[]): PoseProxyFrame[] {
  let previousTracks: PoseTrack[] = []

  return frames.map((frame) => {
    const orderedCandidates = orderCandidates(frame, previousTracks)
    const nextTracks: PoseTrack[] = []

    for (let index = 0; index < orderedCandidates.length; index += 1) {
      const candidate = orderedCandidates[index]
      const previous = previousTracks[index]
      const pose = previous ? smoothPose(previous.pose, candidate.pose) : clonePose(candidate.pose)
      const mask = smoothMask(previous?.mask, candidate.mask, poseMovement(previous?.pose, candidate.pose))
      nextTracks.push({ pose, ...(mask ? { mask } : {}) })
    }

    previousTracks = nextTracks
    return {
      poses: nextTracks.map((track) => track.pose),
      poseMasks: nextTracks.every((track) => track.mask)
        ? nextTracks.map((track) => track.mask!)
        : [],
    }
  })
}

function orderCandidates(frame: PoseProxyFrame, previousTracks: PoseTrack[]): PoseCandidate[] {
  const remaining = frame.poses.map((pose, index) => ({
    pose,
    mask: frame.poseMasks?.[index],
  }))
  const ordered: PoseCandidate[] = []

  for (const previous of previousTracks) {
    const matchIndex = closestCandidateIndex(previous.pose, remaining)
    if (matchIndex < 0) continue
    const [match] = remaining.splice(matchIndex, 1)
    ordered.push(match)
  }

  return [
    ...ordered,
    ...remaining.sort((left, right) => posePriority(right.pose) - posePriority(left.pose)),
  ]
}

function closestCandidateIndex(previous: PoseProxyLandmark[], candidates: PoseCandidate[]) {
  let matchIndex = -1
  let lowestDistance = Number.POSITIVE_INFINITY

  candidates.forEach((candidate, index) => {
    const distance = poseDistance(previous, candidate.pose)
    if (distance < lowestDistance) {
      lowestDistance = distance
      matchIndex = index
    }
  })

  return lowestDistance <= MAX_TRACK_DISTANCE ? matchIndex : -1
}

function smoothPose(previous: PoseProxyLandmark[], current: PoseProxyLandmark[]) {
  return current.map((landmark, index) => {
    const earlier = previous[index]
    if (!earlier) return { ...landmark }
    if (landmark.visibility < MIN_VISIBLE && earlier.visibility >= MIN_VISIBLE) {
      return {
        ...earlier,
        visibility: earlier.visibility * 0.72,
      }
    }
    if (earlier.visibility < MIN_VISIBLE || landmark.visibility < MIN_VISIBLE) return { ...landmark }

    const movement = Math.hypot(landmark.x - earlier.x, landmark.y - earlier.y)
    const currentWeight = clamp(MIN_CURRENT_WEIGHT + movement * 3, MIN_CURRENT_WEIGHT, MAX_CURRENT_WEIGHT)
    return {
      x: mix(earlier.x, landmark.x, currentWeight),
      y: mix(earlier.y, landmark.y, currentWeight),
      z: mix(earlier.z ?? 0, landmark.z ?? 0, currentWeight),
      visibility: Math.max(landmark.visibility, earlier.visibility * 0.92),
    }
  })
}

function smoothMask(previous: PoseProxyMask | undefined, current: PoseProxyMask | undefined, movement: number) {
  if (!current || maskCoverage(current) < 0.012) return previous ? cloneMask(previous) : undefined
  if (!previous || previous.width !== current.width || previous.height !== current.height) return cloneMask(current)

  const previousWeight = clamp(0.38 - movement * 3, 0.08, 0.38)
  const alpha = new Uint8Array(current.alpha.length)
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = Math.round(previous.alpha[index] * previousWeight + current.alpha[index] * (1 - previousWeight))
  }
  return { width: current.width, height: current.height, alpha }
}

function posePriority(pose: PoseProxyLandmark[]) {
  const visible = pose.filter((landmark) => landmark.visibility >= MIN_VISIBLE)
  const center = poseCenter(pose)
  if (!center || !visible.length) return 0
  return visible.length * 10 + poseArea(pose) * 100
}

function poseDistance(left: PoseProxyLandmark[] | undefined, right: PoseProxyLandmark[]) {
  if (!left) return Number.POSITIVE_INFINITY
  const leftCenter = poseCenter(left)
  const rightCenter = poseCenter(right)
  if (!leftCenter || !rightCenter) return Number.POSITIVE_INFINITY
  const centerDistance = Math.hypot(leftCenter.x - rightCenter.x, leftCenter.y - rightCenter.y)
  const scaleDifference = Math.abs(Math.sqrt(poseArea(left)) - Math.sqrt(poseArea(right)))
  return centerDistance + scaleDifference * 0.25
}

function poseMovement(previous: PoseProxyLandmark[] | undefined, current: PoseProxyLandmark[]) {
  if (!previous) return 1
  const previousCenter = poseCenter(previous)
  const currentCenter = poseCenter(current)
  if (!previousCenter || !currentCenter) return 1
  return Math.hypot(previousCenter.x - currentCenter.x, previousCenter.y - currentCenter.y)
}

function poseCenter(pose: PoseProxyLandmark[]) {
  const torsoIndexes = [11, 12, 23, 24]
  const points = torsoIndexes
    .map((index) => pose[index])
    .filter((landmark): landmark is PoseProxyLandmark => Boolean(landmark && landmark.visibility >= MIN_VISIBLE))
  if (!points.length) return null
  return {
    x: points.reduce((sum, landmark) => sum + landmark.x, 0) / points.length,
    y: points.reduce((sum, landmark) => sum + landmark.y, 0) / points.length,
  }
}

function poseArea(pose: PoseProxyLandmark[]) {
  const points = pose.filter((landmark) => landmark.visibility >= MIN_VISIBLE)
  if (!points.length) return 0
  const minX = Math.min(...points.map((landmark) => landmark.x))
  const maxX = Math.max(...points.map((landmark) => landmark.x))
  const minY = Math.min(...points.map((landmark) => landmark.y))
  const maxY = Math.max(...points.map((landmark) => landmark.y))
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
}

function maskCoverage(mask: PoseProxyMask) {
  let sum = 0
  for (const value of mask.alpha) sum += value
  return sum / (mask.alpha.length * 255)
}

function clonePose(pose: PoseProxyLandmark[]) {
  return pose.map((landmark) => ({ ...landmark }))
}

function cloneMask(mask: PoseProxyMask) {
  return {
    width: mask.width,
    height: mask.height,
    alpha: new Uint8Array(mask.alpha),
  }
}

function mix(left: number, right: number, amount: number) {
  return left + (right - left) * amount
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}
