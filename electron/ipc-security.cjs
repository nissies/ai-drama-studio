const { URL } = require('node:url')

function isTrustedRendererUrl(value, { isDevelopment, developmentUrl }) {
  try {
    const candidate = new URL(value)
    if (candidate.protocol === 'app:' && candidate.hostname === 'studio') return true
    if (!isDevelopment) return false
    return candidate.origin === new URL(developmentUrl).origin
  } catch {
    return false
  }
}

function assertTrustedIpc(event, options) {
  if (event.senderFrame?.top && event.senderFrame !== event.senderFrame.top) {
    throw new Error('Subframes cannot invoke privileged IPC')
  }
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || ''
  if (!isTrustedRendererUrl(senderUrl, options)) {
    throw new Error('Untrusted renderer IPC request')
  }
}

module.exports = { assertTrustedIpc, isTrustedRendererUrl }
