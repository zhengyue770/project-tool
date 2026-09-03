# 项目启动器 · Project Launcher

一个桌面小工具，把本地开发项目的启动/停止/状态/日志/账号集中到一个窗口里管理——不用再为每个项目开一个终端、cd 目录、敲命令、翻资料找账号密码。

> A lightweight macOS desktop app that starts, stops, and monitors all your local dev projects from a single window — no more opening a terminal for every repo, remembering start commands, ports, and test credentials.

<!-- 截图占位：建议放一张主界面截图到这里 -->
<!-- ![screenshot](docs/screenshot.png) -->

## 功能特性

- **项目管理**：选择本地文件夹添加为项目，可删除；一个项目支持配置多条启动命令（如后端 + 前端）
- **一键启停**：整组启动或单条启停；进程以独立进程组运行，停止时整组干净退出，不留占端口的残留进程
- **状态判定**：命令的端口真正响应 HTTP 才算"运行中"；支持**固定端口**和**动态端口**两种模式——端口会被占自动换的项目（如 Vite 默认行为）从启动日志自动识别真实端口
- **实时日志**：每条命令的输出落盘并在应用内查看；退出应用再打开，运行中项目的状态、端口和日志都会恢复
- **页面直达**：每个项目可配置多个页面地址，点击直接用默认浏览器打开
- **账号托管**：每个项目可存多组 用户名/密码/角色，默认遮罩显示，一键复制，登录不用再翻资料
- **数据可迁移**：配置存本地 JSON，数据目录可在设置里随时更换并自动迁移

## 安装

从 [Releases](https://github.com/zhengyue770/project-tool/releases) 下载最新的 `.dmg`，拖入"应用程序"即可。

- 平台：macOS（当前构建为 Intel x64，Apple Silicon 可通过 Rosetta 运行）
- 应用未签名，**首次打开请右键 → 打开**（或在系统设置中允许）

## 快速上手

1. 点右上角「添加项目」，选择项目文件夹（名称会自动填入）
2. 配置启动命令：
   - **固定端口**：填命令实际监听的端口（如 vite 的 5173），用于判定启动成功
   - **动态获取**：端口不固定的项目选它，会从启动日志自动识别真实端口
   - 前后端分离的项目可以添加多条命令，一起启动、分别看状态
3. 可选：配置页面地址（点击直达）和账号（遮罩显示、一键复制）
4. 点卡片上的「启动」——状态变绿即服务就绪；失败时点「日志」可看原因

## 几个设计上的点

- **退出应用不会杀掉你的开发服务器**——进程独立于应用存活；重新打开应用会自动恢复"运行中"状态、真实端口和日志
- 启动成功的判定是端口健康检查（依次尝试 IPv4/IPv6 回环），不依赖进程活着与否
- 所有数据（项目/账号/设置）明文存于本地 JSON，纯个人本机使用场景；数据目录可在设置中迁移

## 开发

```bash
npm install
npm run dev        # 开发模式（渲染进程热更新）
npm test           # 单元 + 集成测试（真实子进程）
npm run build      # 构建
npm run build:mac  # 打包 macOS dmg/zip（产物在 release/）
```

技术栈：Electron + electron-vite + Vue 3 + TypeScript + Element Plus + Vitest。

## 数据存储

默认位于 `~/Library/Application Support/project-tool/`，可在应用内「设置 → 更改数据目录」迁移到任意位置（原目录保留为备份）。`storage-pointer.json` 永远留在默认位置，记录当前数据目录。

## License

[MIT](./LICENSE)
