const fs = require('node:fs/promises')
const path = require('node:path')

async function main() {
  const distRoot = path.resolve(__dirname, '..', 'dist')
  await fs.rm(path.join(distRoot, 'onnxruntime'), { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
