# 项目启动器（ProjectTool）

管理本地项目的启动/停止/状态、页面地址与账号信息的 Electron 桌面应用。

## 开发

```bash
npm install
npm run dev      # 开发（渲染进程热更新）
npm test         # 单元 + 集成测试
npm run build    # 构建
npm run build:mac # 打包 macOS dmg
```

## 数据存储

默认在 `~/Library/Application Support/project-tool/`。可在应用内「设置 → 更改数据目录」迁移到任意位置（原目录保留为备份）。`storage-pointer.json` 永远留在默认位置，记录当前数据目录。

## 说明

- 退出应用不会停止已启动的项目进程；重新打开应用会自动恢复其运行状态
- 启动成功的判定：命令配置的端口返回 HTTP 响应
- 账号密码明文存储于本地 JSON，仅适合个人使用
