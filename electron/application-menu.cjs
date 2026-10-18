function buildApplicationMenuTemplate({ isDevelopment = false } = {}) {
  const viewItems = [
    { label: '重新加载', accelerator: 'Ctrl+R', role: 'reload' },
    { label: '强制重新加载', accelerator: 'Ctrl+Shift+R', role: 'forceReload' },
  ]
  if (isDevelopment) {
    viewItems.push(
      { type: 'separator' },
      { label: '开发者工具', accelerator: 'Ctrl+Shift+I', role: 'toggleDevTools' },
    )
  }
  viewItems.push(
    { type: 'separator' },
    { label: '实际大小', accelerator: 'Ctrl+0', role: 'resetZoom' },
    { label: '放大', accelerator: 'Ctrl+Plus', role: 'zoomIn' },
    { label: '缩小', accelerator: 'Ctrl+-', role: 'zoomOut' },
    { type: 'separator' },
    { label: '切换全屏', accelerator: 'F11', role: 'togglefullscreen' },
  )

  return [
    {
      label: '文件',
      submenu: [
        { label: '关闭窗口', accelerator: 'Ctrl+W', role: 'close' },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'Ctrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Ctrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'Ctrl+X', role: 'cut' },
        { label: '复制', accelerator: 'Ctrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'Ctrl+V', role: 'paste' },
        { label: '全选', accelerator: 'Ctrl+A', role: 'selectAll' },
      ],
    },
    { label: '视图', submenu: viewItems },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'Ctrl+M', role: 'minimize' },
        { label: '关闭', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 移光漫剧工坊', role: 'about' }],
    },
  ]
}

module.exports = { buildApplicationMenuTemplate }
