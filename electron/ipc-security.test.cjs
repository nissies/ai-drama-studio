const assert = require('node:assert/strict')
const { test } = require('node:test')
const { assertTrustedIpc, isTrustedRendererUrl } = require('./ipc-security.cjs')

const development = {
  isDevelopment: true,
  developmentUrl: 'http://localhost:5173',
}

test('allows only the configured development renderer origin', () => {
  assert.equal(isTrustedRendererUrl('http://localhost:5173/#/projects', development), true)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/#/projects', development), false)
  assert.equal(isTrustedRendererUrl('https://example.test/', development), false)
})

test('allows the packaged application renderer and rejects lookalikes', () => {
  const production = { isDevelopment: false, developmentUrl: 'http://localhost:5173' }
  assert.equal(isTrustedRendererUrl('app://studio/index.html#/projects', production), true)
  assert.equal(isTrustedRendererUrl('app://evil/index.html', production), false)
  assert.equal(isTrustedRendererUrl('file:///C:/temp/index.html', production), false)
})

test('allows privileged IPC only from the top-level trusted frame', () => {
  const frame = { url: 'app://studio/index.html' }
  frame.top = frame
  assert.doesNotThrow(() =>
    assertTrustedIpc({ senderFrame: frame }, { isDevelopment: false, developmentUrl: '' }),
  )

  const subframe = { url: 'app://studio/embedded.html', top: frame }
  assert.throws(
    () =>
      assertTrustedIpc(
        { senderFrame: subframe },
        { isDevelopment: false, developmentUrl: '' },
      ),
    /Subframes/,
  )
})
