# AGENTS.md

本文件面向维护者与 AI 编码代理（coding agent），记录补丁机制、扫描/打包脚本、数据文件约定与开发流程。终端用户文档见 [README.md](./README.md)。

## 项目概览

本仓库是一个 VS Code/Cursor 扩展，为 Cursor 提供**补充**简体中文翻译，分四层处理：

1. **扩展 NLS** — 通过标准 Language Pack 机制加载 `translations/extensions/anysphere.cursor-*.i18n.json`（不改安装目录）。
2. **Workbench 硬编码补丁** — 对 `workbench.desktop.main.js` 中未走标准 NLS 的硬编码文案做上下文匹配替换。
3. **Agents Window 补丁** — 对 `workbench.glass.main.js`（若存在）做同样处理。
4. **NLS 消息表补丁** — 对 `nls.messages.json` 中少量私有文案做替换。

补丁逻辑代码在 `src/`，可写补丁数据在 `data/`，提取/扫描脚本在 `scripts/`。

## 补丁目标与目录校验

补丁写入的文件（相对 `<cursor-root>/resources/app`）：

| 文件 | 路径 |
|------|------|
| 主 Workbench | `out/vs/workbench/workbench.desktop.main.js` |
| Agents Window | `out/vs/workbench/workbench.glass.main.js`（存在则自动补丁，较旧版本跳过） |
| NLS 消息表 | `out/nls.messages.json`（依赖 `out/nls.keys.json` 索引） |

有效 Cursor 根目录需包含：

- `resources/app/package.json`
- `resources/app/out/nls.keys.json`
- `resources/app/out/nls.messages.json`
- `resources/app/out/vs/workbench/workbench.desktop.main.js`

自动识别顺序：已保存配置 → 运行中的 `Cursor.exe` → `PATH` → 注册表 → 常见安装路径。

## 补丁机制与运行时安全策略

补丁针对 Cursor 私有界面中**未走标准 NLS** 的硬编码文案（设置页 General/Models/Indexing/Network/Beta、Composer/Agent 菜单、Agents Window 菜单栏与侧栏、完整性提示改写等）。

- 修改前计算目标文件 SHA-256；首次应用在同目录生成带版本与时间戳的备份。
- desktop 与 glass **各自独立备份**（前缀分别为 `workbench.desktop.main.js.cursor-zh-cn-pack.*` 与 `workbench.glass.main.js.cursor-zh-cn-pack.*`）。
- 规则按**模块上下文前缀**匹配（如 `label:`、`settings.*` 块），**不做裸词全局替换**。
- 加载时校验每条规则 `source` / `target` **括号结构一致**，避免破坏 bundle 语法。
- 应用前校验命中数、变更行数与受保护运行时关键字（见 `data/workbench-patch-runtime-policy.json`：安全前缀、命中上限、受保护关键字）。
- 汉化后会触发 Cursor 完整性校验；扩展替换相关提示文案，并在可能时抑制误导性的 “installation corrupt” 弹窗。
- desktop 与 glass 压缩符号不同（如菜单栏 `ka`/`B` 与 desktop 的 `Vl`/`P`），部分 UI 需分别维护规则。

当前规则规模（随版本迭代）：Workbench 补丁规则约 **900** 条，NLS 消息表规则约 **17** 条。

> Cursor 升级后 bundle 可能被覆盖或压缩符号变化，需重新扫描并应用补丁。若状态为 **未知** 或 **部分应用**，先确认版本与路径，勿盲目重复写入。

## 数据文件参考

| 文件 | 用途 |
|------|------|
| `data/workbench-patches.json` | 正式 Workbench 补丁替换表 |
| `data/nls-message-patches.json` | NLS 消息表补丁 |
| `data/workbench-patch-runtime-policy.json` | 运行时安全策略（安全前缀、命中上限、受保护关键字） |
| `data/workbench-untranslated-scan-config.json` | 扫描范围与过滤 |
| `data/workbench-hardcoded-needles.json` | 重点观察词 |
| `data/nls-exact-translations.json` | 提取脚本用的精确翻译表 |
| `data/nls-unit-translations.json` | NLS 单元翻译表 |

## 开发环境提示

- 扫描脚本自动探测 Cursor 安装目录（顺序：`C:\Program Files\Cursor` → 用户级 `%LOCALAPPDATA%\Programs\Cursor` → 其他盘 `X:\Program Files\Cursor` → 旧默认 `D:\cursor`），可通过环境变量 `CURSOR_ROOT` 或命令行参数覆盖（例：`node ./scripts/scan-workbench-untranslated.mjs D:\cursor`）。
- 扫描覆盖全部三个 workbench bundle：`workbench.desktop.main.js`（主界面）、`workbench.glass.main.js`（Agents 窗口）、`workbench.anysphere-ui-automations.js`（Automations 面板，存在才扫）。提取锚点只使用语义稳定特征（UI 键名、DOM class、路由名），**不要写入压缩符号锚点**（如 `z\(gX,`、`=me\(`、`anh=`，它们随 Cursor 构建变化会导致漏扫）。
- 版本以 `package.json` 为准；打包前自动执行 `version:sync` 同步到各处，**不要手动改其他文件的版本号**。
- 生成产物（`reports/`、`data/*.staging.json`）不入库，需对照 `reports/` 报告整理补丁规则后再写入正式 `data/*.json`。

## 构建与打包

```powershell
npm install
npm run compile      # 编译 TypeScript 扩展
npm run package      # 生成当前版本 .vsix
npm run release:build # 在 artifacts/release/ 生成 GitHub Release 资产
```

| 命令 | 说明 |
|------|------|
| `npm run compile` | 编译 TypeScript 扩展 |
| `npm run build` | 同步版本 + 提取扩展翻译 + 编译 |
| `npm run package` | 生成当前版本 `.vsix` |
| `npm run release:build` | 在 `artifacts/release/` 生成 GitHub Release 资产 |

## 扫描与规则维护

### 提取 Cursor 专用扩展翻译

```powershell
npm run extract
```

产物：`translations/extensions/anysphere.cursor-*.i18n.json`、`reports/untranslated-extensions.json`。运行时会清理旧的 `translations/main.i18n.json` 及非 Cursor 专用扩展翻译，避免与官方语言包冲突。

### 扫描 Workbench 未汉化硬编码

```powershell
npm run scan:workbench
```

产物：`reports/workbench-untranslated.json`、`reports/workbench-untranslated.md`。

### 提取可写入补丁表的 source 候选

```powershell
npm run scan:patch-sources
```

产物：`reports/workbench-patch-source-candidates.json` / `.md`、`data/workbench-patches.staging.json`。

> 流程：先 `scan:workbench` 找出未汉化硬编码 → `scan:patch-sources` 生成候选 → 人工/对照翻译后写入 `data/workbench-patches.json`。

## 发布

推到 `main` / `master` 时，若提交信息符合发布格式，工作流（`.github/workflows/release.yml`）会自动创建或更新 GitHub Release。提交信息示例：

```text
v1.2.0
- 支持 Agents Window（workbench.glass.main.js）双 bundle 补丁
- 补充设置页与 NLS 消息表汉化规则
```
