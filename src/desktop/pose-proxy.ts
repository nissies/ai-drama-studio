import { createDwPoseProxy } from './dwpose'

export type { LocalDwPoseProxyResult as LocalPoseProxyResult } from './dwpose'

// A single verified engine avoids silently falling back to untracked binaries.
export const createLocalPoseProxy = createDwPoseProxy
