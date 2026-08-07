# Cursor 简体中文语言包

面向 Windows 版 Cursor 的**补充**语言包扩展：只处理 Cursor 专用扩展和 Cursor 私有硬编码界面；VS Code 基础翻译请使用官方扩展 `MS-CEINTL.vscode-language-pack-zh-hans`。

当前版本：**1.2.0**（以 `package.json` 为准）。

## 覆盖范围

| 层级 | 目标 | 说明 |
|------|------|------|
| 扩展 NLS | `anysphere.cursor-*` | 通过标准 Language Pack 机制加载 |
| Workbench 硬编码 | `workbench.desktop.main.js` | 主界面（设置、Composer、菜单等） |
| Agents Window | `workbench.glass.main.js` | 智能体窗口界面及其内置 Settings |
| NLS 消息表 | `nls.messages.json` | 少量未进入扩展包的私有文案 |

标准 Language Pack 资源**不会**修改 Cursor 安装目录。只有在命令面板打开 **Cursor 汉化管理器** 并点击 **应用汉化补丁** 时，才会写入上述目标文件；写入前会自动备份，并支持从管理器恢复。

建议 Cursor 版本 **≥ 3.4.17**（已在 3.8.x 上验证 Agents Window 双 bundle 补丁）。

## 安装和启用

先安装官方 VS Code 简体中文语言包，再安装本扩展：

```powershell
cursor --install-extension MS-CEINTL.vscode-language-pack-zh-hans
cursor --install-extension .\cursor-zh-cn-pack-1.2.0.vsix
```

安装后在 Cursor 中：

1. 命令面板运行 `Configure Display Language`，选择 `zh-cn` / `简体中文`，重启 Cursor
2. 打开 **Cursor 汉化管理器**，识别安装目录并 **应用汉化补丁**
3. 使用 **一键重启并清理 Cursor**，然后重新打开 **智能体窗口**（若使用 Agents Window）

## Cursor 汉化管理器

命令面板运行 `Cursor 汉化管理器`，提供一站式流程：

- 自动 / 手动识别 Cursor 安装目录
- 扫描 Workbench（desktop + glass）、NLS 消息表、运行时 UI 缓存状态
- **应用汉化补丁**（Workbench + NLS 一并处理，写入前自动备份）
- **卸载补丁**、分别恢复 Workbench / NLS 备份
- **清理运行时 UI 状态**（`state.vscdb` 中英文界面缓存）
- **一键重启并清理 Cursor**（关闭进程 → 清理缓存 → 重启）
- 操作日志与备份列表

### 推荐流程

1. **识别目录** — 一键识别或手动选择
2. **重新扫描状态** — 只读，不写入
3. **应用汉化补丁** — 写入并备份
4. **一键重启并清理 Cursor** — 刷新已加载界面与 UI 缓存
5. **恢复备份**（可选）— Workbench 与 NLS 备份分开恢复

## 配置项

| 键 | 说明 | 默认 |
|----|------|------|
| `cursorZhCn.cursorRoot` | Cursor 安装根目录，如 `D:\cursor` | 空（由管理器识别） |
| `cursorZhCn.enableWorkbenchPatch` | 是否允许管理器修改 Workbench bundle | `true` |

## 已知限制

- 不复制官方 VS Code 中文包，也不接管完整主界面翻译
- 远程 Web 内容、API 动态返回、未纳入规则的低置信度硬编码仍可能显示英文
- 补丁依赖当前 Cursor 版本的 bundle 结构，大版本升级后可能需要重新扫描并更新规则
- 修改安装目录文件可能触发 Cursor 完整性提示；按管理器流程应用补丁即可，一般可忽略或选择「不再显示」

---

维护者与贡献者请参阅 [AGENTS.md](./AGENTS.md)，了解补丁机制、扫描/打包脚本与数据文件约定。
