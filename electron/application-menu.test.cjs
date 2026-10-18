const assert = require('node:assert/strict')
const test = require('node:test')
const { buildApplicationMenuTemplate } = require('./application-menu.cjs')

test('uses Chinese top-level labels and hides developer tools in production', () => {
  const template = buildApplicationMenuTemplate()

  assert.deepEqual(
    template.map((item) => item.label),
    ['文件', '编辑', '视图', '窗口', '帮助'],
  )
  assert.equal(JSON.stringify(template).includes('toggleDevTools'), false)
})

test('shows developer tools only in development mode', () => {
  const template = buildApplicationMenuTemplate({ isDevelopment: true })

  assert.equal(JSON.stringify(template).includes('开发者工具'), true)
})
