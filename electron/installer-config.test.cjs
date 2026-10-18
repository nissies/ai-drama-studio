const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('NSIS build recreates the Start Menu shortcut after updates', () => {
  const root = path.resolve(__dirname, '..')
  const config = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
  const include = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8')

  assert.match(config, /include:\s*build\/installer\.nsh/)
  assert.match(include, /!macro customInstall/)
  assert.match(include, /Delete "\$newStartMenuLink"/)
  assert.match(
    include,
    /CreateShortCut "\$newStartMenuLink" "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/,
  )
  assert.match(include, /WinShell::SetLnkAUMI/)
  assert.match(include, /SHChangeNotify/)
})
