const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')

async function main() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <rect width="512" height="512" rx="108" fill="#18212b" />
      <rect x="60" y="60" width="392" height="392" rx="88" fill="#1463d6" />
      <g transform="translate(114 114) scale(11.833333)" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
        <path d="m6.2 5.3 3.1 3.9" />
        <path d="m12.4 3.4 3.1 4" />
        <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </g>
      <circle cx="401" cy="403" r="35" fill="#18212b" />
      <circle cx="401" cy="403" r="23" fill="#ef5b5b" />
    </svg>`
  const outputDirectory = path.join(__dirname, '..', 'build')
  await fs.mkdir(outputDirectory, { recursive: true })
  await sharp(Buffer.from(svg)).png().toFile(path.join(outputDirectory, 'icon.png'))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
