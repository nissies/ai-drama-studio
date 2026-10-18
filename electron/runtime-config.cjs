const { URL } = require('node:url')

function createRuntimeConfig(environment = process.env) {
  const developmentUrl = environment.AI_DRAMA_STUDIO_DEV_URL || 'http://localhost:5173'
  // The open-source client never contacts a hosted production service by default.
  // Set this only when connecting the optional cloud features to a trusted backend.
  const apiOrigin = new URL(environment.AI_DRAMA_STUDIO_API_ORIGIN || 'http://127.0.0.1:8080')
    .origin
  return Object.freeze({ developmentUrl, apiOrigin })
}

module.exports = { createRuntimeConfig, runtimeConfig: createRuntimeConfig() }
