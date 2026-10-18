# AI Drama Studio

一个本地优先的 Windows AI 短剧制作台。用户可以连接自己的文本、图片、
视频和配音模型，在本机管理项目、素材、生成结果，并使用 FFmpeg 合成导出。

本仓库只包含 Electron 用户端，不包含运营后台、平台服务端、数据库、部署配置、
生产密钥或用户数据。HBuilderX 仅用于原项目的移动审核端，本项目不需要 HBuilderX。

## 功能

- 本地项目、剧本、角色、场景、分镜和素材管理
- 用户自定义模型地址、接口路径、模型 ID 和 API Key
- Ollama、OpenAI 兼容接口及多个公开模型服务预设
- 本地调用文本、图片、视频和 TTS 接口
- Windows `safeStorage` 加密保存模型 API Key
- 生成结果下载到本地项目目录
- 使用 FFmpeg 进行抽帧、音频处理和成片合成

云端登录、积分、平台模型和自动更新属于可选集成功能，需要自行提供兼容后端；
本地项目和“我的 API”模型生成不需要该后端。

## 环境要求

- Windows 10/11
- Node.js 22，或当前受支持的 LTS 版本
- npm
- 开发模式下需要把 `ffmpeg` 和 `ffprobe` 加入 `PATH`，才能使用媒体处理与导出

## 启动

```powershell
git clone <your-repository-url>
cd ai-drama-studio
npm ci
Copy-Item .env.example .env.local
npm run dev
```

再打开一个终端启动 Electron：

```powershell
npm run desktop:dev
```

进入“设置 → AI 模型”，新增模型连接并填写：

- 服务类型：文本、图片、视频或配音
- 基础地址：例如本机 Ollama 地址或你信任的模型 API 地址
- 接口路径和模型 ID
- API Key（不需要时可留空）

建议先使用“测试连接”或“获取模型列表”验证配置，再进入图片工坊或视频工坊。

## 常用命令

```powershell
npm run lint
npm run typecheck
npm test
npm run test:desktop
npm run build:desktop
```

Windows 安装包构建前，还需要按 [第三方资源说明](THIRD_PARTY_ASSETS.md)准备来源和
许可证均已核验的 FFmpeg 文件，然后执行：

```powershell
npm run desktop:package
```

## 配置与隐私

- 不要把 API Key 写入 `.env`、源码或 Git 提交。
- 模型 API Key 通过 Electron `safeStorage` 加密后保存在当前 Windows 用户目录。
- 项目、素材、聊天记录和生成结果默认保存在本机；工作目录可在设置页更改。
- 应用会把提示词和选中的参考素材发送给用户配置的模型服务，请只连接可信服务。
- `.env.example` 中的 localhost 后端只用于可选云功能，不会连接原项目生产服务。

## 第三方资源

仓库不包含 FFmpeg 可执行文件、134MB DWPose 模型以及复制的 WASM 运行时。
基础文本、图片、视频、配音生成不依赖 DWPose 模型。详情见
[THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md)。

## 许可证

源码采用 [Apache License 2.0](LICENSE)。提交代码或发布衍生版本前，请确认你对
新增的品牌、图片、模型、字体和其他素材拥有相应权利。第三方依赖仍遵循各自许可证。

## 合作联系

功能合作、模型适配与其他合作事项，请联系：`www02212022@163.com`。
