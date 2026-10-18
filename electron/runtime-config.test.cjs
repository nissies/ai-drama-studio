const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createRuntimeConfig } = require('./runtime-config.cjs')

test('defaults packaged desktop api origin to local optional backend', () => {
  const config = createRuntimeConfig({})

  assert.equal(config.apiOrigin, 'http://127.0.0.1:8080')
})

test('keeps desktop runtime addresses in one configuration module', () => {
  const config = createRuntimeConfig({
    AI_DRAMA_STUDIO_DEV_URL: 'http://localhost:5190',
    AI_DRAMA_STUDIO_API_ORIGIN: 'https://api.example.test/v1',
  })

  assert.equal(config.developmentUrl, 'http://localhost:5190')
  assert.equal(config.apiOrigin, 'https://api.example.test')
})
