const fs = require('node:fs')
const path = require('node:path')

const runtimeDirectory = path.resolve(__dirname, '..', 'build', 'ffmpeg')
const requiredBinaries = ['ffmpeg.exe', 'ffprobe.exe']
const files = requiredBinaries.filter((name) => fs.existsSync(path.join(runtimeDirectory, name)))

if (files.length !== requiredBinaries.length) {
  const missing = requiredBinaries.filter((name) => !files.includes(name))
  console.error(`缺少桌面端内置媒体运行库：${missing.join('、')}`)
  console.error(`请将经过许可证核验的文件放入：${runtimeDirectory}`)
  process.exit(1)
}

const licenseFiles = fs
  .readdirSync(runtimeDirectory)
  .filter((name) => /^(license|copying)/i.test(name))
if (!licenseFiles.length) {
  console.error('FFmpeg 运行库缺少许可证或构建说明文件，不能直接打包分发')
  process.exit(1)
}

console.log(`FFmpeg 运行库已就绪：${runtimeDirectory}`)
