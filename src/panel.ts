import * as vscode from 'vscode';
import { launchCursorRestartHelper, shutdownCursorProcesses } from './cursorProcessManager';
import { CursorInstall, locateCursorInstall, validateCursorRoot } from './cursorLocator';
import { applyNlsMessagePatch, NlsMessagePatchScanResult, restoreNlsMessageBackup, scanNlsMessagePatch, unapplyNlsMessagePatch } from './nlsMessagePatcher';
import { createScopedProgress, ProgressCallback, ProgressUpdate, reportProgress } from './progress';
import { cleanLanguagePackCache, cleanRuntimeState, RuntimeStateScanResult, scanRuntimeState } from './runtimeStateCleaner';
import { applyWorkbenchPatch, PatchBackupInfo, PatchScanResult, restoreWorkbenchBackup, scanWorkbenchPatch, unapplyWorkbenchPatch } from './workbenchPatcher';

interface ManagerProgressState extends ProgressUpdate {
  readonly operation: string;
  readonly startedAt: string;
}

interface ManagerState {
  cursorRoot?: string;
  install?: CursorInstall;
  patch?: PatchScanResult;
  nlsPatch?: NlsMessagePatchScanResult;
  runtimeState?: RuntimeStateScanResult;
  progress?: ManagerProgressState;
  logs: readonly string[];
}

interface WebviewMessage {
  readonly command: 'oneClick' | 'autoLocate' | 'chooseRoot' | 'rescan' | 'applyPatch' | 'cleanRuntimeState' | 'unapplyPatch' | 'restoreWorkbenchBackup' | 'restoreNlsBackup' | 'shutdownCursor' | 'restartCursor';
  readonly backupPath?: string;
}

export class ManagerPanel {
  public static current?: ManagerPanel;

  private readonly logs: string[] = [];
  private state: ManagerState = { logs: this.logs };
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel.onDidDispose(() => this.dispose(), undefined, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewMessage), undefined, this.context.subscriptions);
    void this.refresh(true, '管理器加载');
  }

  public static reveal(context: vscode.ExtensionContext): void {
    if (ManagerPanel.current) {
      ManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      void ManagerPanel.current.refresh(false, '管理器刷新');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'cursorZhCnManager',
      'Cursor 汉化管理器',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ManagerPanel.current = new ManagerPanel(panel, context);
  }

  private dispose(): void {
    this.disposed = true;
    ManagerPanel.current = undefined;
  }

  private async runOperation<T>(operation: string, task: (progress: ProgressCallback) => Promise<T>): Promise<T | undefined> {
    if (this.state.progress) {
      this.log(`已有操作正在进行：${this.state.progress.operation}`);
      this.render();
      return undefined;
    }

    const startedAt = new Date().toISOString();
    const progress: ProgressCallback = update => {
      this.updateState({
        progress: {
          ...update,
          operation,
          startedAt
        }
      });
      this.render();
    };

    try {
      await reportProgress(progress, { message: '准备开始', percent: 0 });
      return await task(progress);
    } finally {
      this.updateState({ progress: undefined });
      this.render();
    }
  }

  private updateState(update: Omit<Partial<ManagerState>, 'logs'>): void {
    this.state = {
      ...this.state,
      ...update,
      logs: this.logs
    };
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.command) {
        case 'oneClick':
          await this.oneClick();
          break;
        case 'autoLocate':
          await this.autoLocate();
          break;
        case 'chooseRoot':
          await this.chooseRoot();
          break;
        case 'rescan':
          await this.refresh(true, '重新扫描');
          break;
        case 'applyPatch':
          await this.applyPatch();
          break;
        case 'cleanRuntimeState':
          await this.cleanRuntimeState();
          break;
        case 'unapplyPatch':
          await this.unapplyPatch();
          break;
        case 'restoreWorkbenchBackup':
          await this.restoreWorkbenchBackup(message.backupPath);
          break;
        case 'restoreNlsBackup':
          await this.restoreNlsBackup(message.backupPath);
          break;
        case 'shutdownCursor':
          await this.shutdownCursor();
          break;
        case 'restartCursor':
          await this.restartCursor();
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(message);
      void vscode.window.showErrorMessage(message);
      this.render();
    }
  }

  private async refresh(scanOnly: boolean, operation = scanOnly ? '重新扫描' : '管理器刷新'): Promise<void> {
    await this.runOperation(operation, async progress => {
      const configuredRoot = vscode.workspace.getConfiguration('cursorZhCn').get<string>('cursorRoot')?.trim();

      if (!configuredRoot && scanOnly) {
        await this.autoLocateCore(createScopedProgress(progress, 5, 100, '自动识别'));
        return;
      }

      if (configuredRoot) {
        await this.loadRoot(configuredRoot, '已保存配置', progress);
      } else {
        this.updateState({ cursorRoot: undefined, install: undefined, patch: undefined, nlsPatch: undefined, runtimeState: undefined });
        await reportProgress(progress, { message: '未配置 Cursor 安装目录', percent: 100 });
      }
    });
  }

  private async oneClick(): Promise<void> {
    await this.runOperation('一键汉化', async progress => {
      // 第 1 步：自动识别安装目录（0%–18%）
      await this.autoLocateCore(createScopedProgress(progress, 0, 18, '识别安装目录'));
      if (!this.state.install?.valid) {
        await reportProgress(progress, { message: '未识别到 Cursor 安装目录，已停止。', percent: 100 });
        this.log('一键汉化已停止：未识别到 Cursor 安装目录。');
        return;
      }

      // 第 2 步：应用补丁（18%–80%）
      const allowed = vscode.workspace.getConfiguration('cursorZhCn').get<boolean>('enableWorkbenchPatch', true);
      if (!allowed) {
        throw new Error('配置 cursorZhCn.enableWorkbenchPatch 已禁用，未执行补丁。');
      }

      const result = await applyWorkbenchPatch(this.state.install.root, this.context, createScopedProgress(progress, 18, 58, 'Workbench 补丁'));
      const nlsResult = await applyNlsMessagePatch(this.state.install.root, this.context, createScopedProgress(progress, 58, 78, 'NLS 消息表补丁'));
      const runtimeState = await scanRuntimeState(createScopedProgress(progress, 78, 80, '扫描运行时状态库'));
      this.updateState({ patch: result.after, nlsPatch: nlsResult.after, runtimeState });
      this.log(`Workbench 补丁：本次写入 ${result.appliedRuleIds.length} 项/${result.appliedOccurrences} 处。`);
      this.log(`NLS 消息表补丁：本次写入 ${nlsResult.appliedRuleIds.length} 项/${nlsResult.appliedOccurrences} 处。`);

      // 第 3 步：重启并清理（80%–100%）
      await reportProgress(progress, { message: '准备重启并清理 Cursor', percent: 82 });
      const restartResult = await launchCursorRestartHelper(this.state.install.root, this.context, { cleanRuntimeState: true }, createScopedProgress(progress, 82, 100, '重启并清理'));
      this.log(`独立助手已启动，Cursor 即将关闭并重启: ${restartResult.executablePath}`);
      this.log(`助手日志: ${restartResult.logPath}`);
      await reportProgress(progress, { message: '一键汉化完成，Cursor 正在重启', percent: 100 });
      void vscode.window.showInformationMessage('一键汉化完成：Cursor 即将关闭、清理运行时状态、重建语言包缓存并重新启动。');
    });
  }

  private async autoLocate(): Promise<void> {
    await this.runOperation('自动识别', progress => this.autoLocateCore(progress));
  }

  private async autoLocateCore(progress: ProgressCallback | undefined): Promise<void> {
    this.log('开始自动识别 Cursor 安装目录。');
    const configuredRoot = vscode.workspace.getConfiguration('cursorZhCn').get<string>('cursorRoot');
    const result = await locateCursorInstall(configuredRoot, createScopedProgress(progress, 0, 70, '识别安装目录'));

    if (!result.install) {
      this.updateState({ cursorRoot: undefined, install: undefined, patch: undefined, nlsPatch: undefined });
      this.log(`自动识别失败，已检查 ${result.candidates.length} 个候选路径。`);
      await reportProgress(progress, {
        message: `自动识别失败，已检查 ${result.candidates.length} 个候选路径`,
        percent: 100,
        current: result.candidates.length,
        total: result.candidates.length
      });
      return;
    }

    await reportProgress(progress, { message: '保存识别到的 Cursor 路径', percent: 72 });
    await saveCursorRoot(result.install.root);
    await this.loadInstall(result.install, createScopedProgress(progress, 75, 99, '加载安装数据'));
    this.log(`已识别 Cursor ${result.install.version ?? '未知版本'}: ${result.install.root}`);
    await reportProgress(progress, { message: '自动识别完成', percent: 100 });
  }

  private async chooseRoot(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择 Cursor 安装目录'
    });

    const folder = selected?.[0]?.fsPath;
    if (!folder) {
      return;
    }

    await this.runOperation('手动选择 Cursor 路径', async progress => {
      const install = await validateCursorRoot(folder, '手动选择', createScopedProgress(progress, 0, 35, '校验安装目录'));
      if (!install.valid) {
        this.log(`目录校验失败: ${install.problems.join('；')}`);
        void vscode.window.showErrorMessage('所选目录不是有效的 Cursor 安装根目录。');
        this.updateState({ cursorRoot: folder, install, patch: undefined, nlsPatch: undefined });
        await reportProgress(progress, { message: '目录校验失败', percent: 100, current: 0, total: 1 });
        return;
      }

      await reportProgress(progress, { message: '保存手动选择路径', percent: 40, current: 1, total: 1 });
      await saveCursorRoot(install.root);
      await this.loadInstall(install, createScopedProgress(progress, 45, 99, '加载安装数据'));
      this.log(`已保存手动选择路径: ${install.root}`);
      await reportProgress(progress, { message: '手动选择完成', percent: 100, current: 1, total: 1 });
    });
  }

  private async applyPatch(): Promise<void> {
    await this.runOperation('应用补丁', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const allowed = vscode.workspace.getConfiguration('cursorZhCn').get<boolean>('enableWorkbenchPatch', true);
      if (!allowed) {
        throw new Error('配置 cursorZhCn.enableWorkbenchPatch 已禁用，未执行补丁。');
      }

      const result = await applyWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 0, 58, 'Workbench 补丁'));
      const nlsResult = await applyNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 58, 92, 'NLS 消息表补丁'));
      const runtimeState = await scanRuntimeState(createScopedProgress(progress, 92, 100, '扫描运行时状态库'));
      this.updateState({ patch: result.after, nlsPatch: nlsResult.after, runtimeState });
      this.log(`Cursor 根目录: ${result.after.cursorRoot}`);
      this.log(`Workbench 文件: ${result.after.filePath}`);
      this.log(`NLS 消息表: ${nlsResult.after.filePath}`);
      this.log(`Workbench 补丁命中: 英文源 ${result.before.sourceHits} 处，已翻译 ${result.before.targetHits} 处，本次写入 ${result.appliedRuleIds.length} 项/${result.appliedOccurrences} 处。`);
      this.log(`NLS 补丁命中: 英文源 ${nlsResult.before.sourceHits} 处，已翻译 ${nlsResult.before.targetHits} 处，本次写入 ${nlsResult.appliedRuleIds.length} 项/${nlsResult.appliedOccurrences} 处。`);
      this.log(result.changed
        ? `Workbench 补丁已应用，备份: ${result.backupPath}`
        : `Workbench 补丁未写入：英文源 ${result.before.sourceHits} 处，已翻译 ${result.before.targetHits} 处。`);
      this.log(nlsResult.changed
        ? `NLS 消息表补丁已应用，备份: ${nlsResult.backupPath}`
        : `NLS 消息表补丁未写入：英文源 ${nlsResult.before.sourceHits} 处，已翻译 ${nlsResult.before.targetHits} 处。`);
      this.log(runtimeState.state === 'dirty'
        ? '运行时 UI 状态仍有缓存：请点击「一键重启并清理 Cursor」。'
        : `运行时 UI 状态：${runtimeState.message}`);
    });
  }

  private async cleanRuntimeState(): Promise<void> {
    await this.runOperation('清理运行时 UI 状态', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await cleanRuntimeState(install.root, createScopedProgress(progress, 0, 82, '清理运行时 UI 状态'));
      const languagePackCache = result.state === 'cursor-running'
        ? undefined
        : await cleanLanguagePackCache(createScopedProgress(progress, 82, 96, '重建语言包缓存'));
      const runtimeState = await scanRuntimeState(createScopedProgress(progress, 96, 100, '复扫运行时状态库'));
      this.updateState({ runtimeState });
      this.log(formatRuntimeCleanLog(result));
      if (languagePackCache) {
        this.log(languagePackCache.message);
        if (languagePackCache.backupRoot) {
          this.log(`语言包缓存备份: ${languagePackCache.backupRoot}`);
        }
      }
    });
  }

  private async unapplyPatch(): Promise<void> {
    await this.runOperation('卸载补丁', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await unapplyWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 0, 62, 'Workbench 补丁'));
      const nlsResult = await unapplyNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 62, 100, 'NLS 消息表补丁'));
      this.updateState({ patch: result.after, nlsPatch: nlsResult.after });
      this.log(`Workbench 文件: ${result.after.filePath}`);
      this.log(`NLS 消息表: ${nlsResult.after.filePath}`);
      this.log(result.changed
        ? `Workbench 补丁已卸载，反向处理 ${result.unappliedRuleIds.length} 项，卸载前快照: ${result.safetyBackupPath}`
        : 'Workbench 补丁未卸载：当前文件没有命中已应用的中文补丁。');
      this.log(nlsResult.changed
        ? `NLS 消息表补丁已卸载，反向处理 ${nlsResult.unappliedRuleIds.length} 项，卸载前快照: ${nlsResult.safetyBackupPath}`
        : 'NLS 消息表补丁未卸载：当前文件没有命中已应用的中文补丁。');
    });
  }

  private async restoreWorkbenchBackup(backupPath?: string): Promise<void> {
    await this.runOperation('恢复 Workbench 备份', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const selectedBackupPath = backupPath ?? this.state.patch?.backups.find(backup => backup.currentMetadataBackup)?.path ?? this.state.patch?.backups[0]?.path;
      if (!selectedBackupPath) {
        throw new Error('没有可恢复的 Workbench 备份文件。');
      }

      const result = await restoreWorkbenchBackup(install.root, this.context, selectedBackupPath, progress);
      this.updateState({ patch: result.after });
      this.log(`Workbench 已从备份恢复: ${result.backupPath}`);
      this.log(`Workbench 恢复前快照: ${result.safetyBackupPath}`);
    });
  }

  private async restoreNlsBackup(backupPath?: string): Promise<void> {
    await this.runOperation('恢复 NLS 消息表备份', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const selectedBackupPath = backupPath ?? this.state.nlsPatch?.backups.find(backup => backup.currentMetadataBackup)?.path ?? this.state.nlsPatch?.backups[0]?.path;
      if (!selectedBackupPath) {
        throw new Error('没有可恢复的 NLS 消息表备份文件。');
      }

      const result = await restoreNlsMessageBackup(install.root, this.context, selectedBackupPath, progress);
      this.updateState({ nlsPatch: result.after });
      this.log(`NLS 消息表已从备份恢复: ${result.backupPath}`);
      this.log(`NLS 消息表恢复前快照: ${result.safetyBackupPath}`);
    });
  }

  private async shutdownCursor(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      '将关闭当前识别到的 Cursor 安装对应的所有 Cursor.exe 进程。未保存的编辑器内容可能丢失，请先保存重要内容。',
      { modal: true },
      '强制关闭 Cursor'
    );
    if (confirmed !== '强制关闭 Cursor') {
      return;
    }

    await this.runOperation('强制关闭 Cursor', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await shutdownCursorProcesses(install.root, progress);
      this.log(`强制关闭 Cursor: 发现 ${result.before.length} 个进程，已关闭 ${result.closedCount} 个，强制结束 ${result.forcedCount} 个，剩余 ${result.after.length} 个。`);
      if (result.after.length > 0) {
        this.log(`仍未关闭的进程: ${result.after.map(item => item.id).join(', ')}`);
      }
    });
  }

  private async restartCursor(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      '将启动独立助手接管后续操作：关闭当前 Cursor、清理 state.vscdb 运行时 UI 缓存、重建 zh-cn 语言包合成缓存，然后重新启动 Cursor。未保存内容可能丢失，请先保存重要内容。',
      { modal: true },
      '重启并清理 Cursor'
    );
    if (confirmed !== '重启并清理 Cursor') {
      return;
    }

    await this.runOperation('重启并清理 Cursor', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await launchCursorRestartHelper(install.root, this.context, { cleanRuntimeState: true }, progress);
      this.log(`独立助手已启动，Cursor 即将关闭并重启: ${result.executablePath}`);
      this.log(`助手日志: ${result.logPath}`);
      void vscode.window.showInformationMessage('独立助手已接管：Cursor 即将关闭、清理运行时状态、重建语言包缓存并重新启动。');
    });
  }

  private async loadRoot(root: string, source: string, progress?: ProgressCallback): Promise<void> {
    const install = await validateCursorRoot(root, source, createScopedProgress(progress, 0, 30, '校验安装目录'));
    await this.loadInstall(install, createScopedProgress(progress, 30, 100, '加载安装数据'));
  }

  private async loadInstall(install: CursorInstall, progress?: ProgressCallback): Promise<void> {
    let patch: PatchScanResult | undefined;
    let nlsPatch: NlsMessagePatchScanResult | undefined;
    let runtimeState: RuntimeStateScanResult | undefined;
    await reportProgress(progress, { message: '准备加载安装数据', percent: 0 });

    if (install.valid) {
      try {
        patch = await scanWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 10, 45, '扫描 Workbench 补丁数据'));
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }

      try {
        nlsPatch = await scanNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 45, 78, '扫描 NLS 消息表补丁数据'));
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }

      try {
        runtimeState = await scanRuntimeState(createScopedProgress(progress, 78, 95, '扫描运行时状态库'));
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }
    }

    this.updateState({
      cursorRoot: install.root,
      install,
      patch,
      nlsPatch,
      runtimeState
    });
    await reportProgress(progress, {
      message: install.valid ? '安装数据加载完成' : '安装目录无效',
      percent: 100,
      current: install.valid ? 1 : 0,
      total: 1
    });
  }

  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.unshift(`[${timestamp}] ${message}`);
    this.logs.splice(80);
  }

  private render(): void {
    if (this.disposed) {
      return;
    }

    this.panel.webview.html = getHtml(this.panel.webview, this.state);
  }
}

async function saveCursorRoot(root: string): Promise<void> {
  await vscode.workspace.getConfiguration('cursorZhCn').update('cursorRoot', root, vscode.ConfigurationTarget.Global);
}

type PatchLikeScanResult = PatchScanResult | NlsMessagePatchScanResult;

function getHtml(webview: vscode.Webview, state: ManagerState): string {
  const nonce = getNonce();
  const cspSource = webview.cspSource;
  const install = state.install;
  const patch = state.patch;
  const nlsPatch = state.nlsPatch;
  const runtimeState = state.runtimeState;
  const patchStatusText: Record<string, string> = {
    'not-applied': '未应用',
    applied: '已应用',
    partial: '部分应用',
    unknown: '未知'
  };
  const busyAttribute = state.progress ? ' disabled' : '';
  const nextAction = getNextAction(state, patchStatusText);
  const overallState = getOverallState(state);
  const helpItems = getHelpItems();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursor 汉化管理器</title>
  <style>
    /* 主题变量：精简 / 白底 / 发丝线 / 黑红配色，全部跟随 VS Code 主题 */
    :root {
      --bg: var(--vscode-editor-background);
      --bg-sub: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground));
      --bg-sunken: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground));
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --faint: color-mix(in srgb, var(--vscode-descriptionForeground) 60%, transparent);
      --border: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
      --border-strong: color-mix(in srgb, var(--vscode-foreground) 26%, transparent);
      --accent: var(--vscode-errorForeground);
      --accent-soft: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent);
      --success: var(--vscode-testing-iconPassed);
      --warn: var(--vscode-testing-iconQueued);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg-sub); color: var(--fg); font-family: var(--vscode-font-family); font-size: 14px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
    .mono { font-family: var(--vscode-editor-font-family); font-size: 12.5px; }
    h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
    h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0; }
    h3 { margin: 0; font-size: 13px; font-weight: 600; }
    p { margin: 0; }

    .wrap { max-width: 1040px; margin: 0 auto; padding: 28px 24px 56px; }
    .card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; }
    .card-pad { padding: 20px; }
    .stack > * + * { margin-top: 16px; }
    .gap-top { margin-top: 16px; }

    /* 头部 */
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
    .subtitle { color: var(--muted); max-width: 620px; margin-top: 8px; }
    .status-mini { text-align: right; min-width: 180px; }
    .status-mini .label { font-size: 11.5px; color: var(--muted); }
    .status-mini .value { font-weight: 600; margin-top: 2px; }

    /* 按钮 */
    button { font: inherit; font-size: 13px; font-weight: 500; border-radius: 6px; padding: 8px 14px; cursor: pointer; border: 1px solid transparent; transition: background .12s, border-color .12s, color .12s; }
    button.btn { background: var(--bg); border-color: var(--border-strong); color: var(--fg); }
    button.btn:hover { border-color: var(--fg); }
    button.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    button.btn-primary:hover { opacity: .88; }
    button.btn-danger { background: transparent; border-color: var(--accent); color: var(--accent); }
    button.btn-danger:hover { background: var(--accent); color: #fff; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }

    /* 状态点 */
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    .dot.ok { background: var(--success); }
    .dot.warn { background: var(--warn); }
    .dot.bad { background: var(--accent); }
    .dot.idle { background: var(--faint); }
    .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; color: var(--muted); white-space: nowrap; }
    .ok { color: var(--success); }
    .warn { color: var(--warn); }
    .bad { color: var(--accent); }
    .muted { color: var(--muted); }

    /* 下一步提示 */
    .next { margin-top: 16px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-sub); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .next .t { font-size: 12px; color: var(--muted); }
    .next .v { font-weight: 500; margin-top: 2px; }

    /* 区块标题 */
    .section-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .section-title .left { display: flex; align-items: center; gap: 8px; }

    /* 5 步引导 */
    .steps { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; }
    .step { position: relative; padding-right: 14px; }
    .step:not(:last-child)::after { content: ""; position: absolute; top: 13px; left: 28px; right: 0; height: 1px; background: var(--border); }
    .step.done:not(:last-child)::after { background: var(--success); }
    .step .num { width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--bg); border: 1px solid var(--border-strong); color: var(--muted); position: relative; z-index: 1; }
    .step.done .num { background: var(--success); border-color: var(--success); color: #fff; }
    .step.active .num { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .step .st-title { font-weight: 600; margin-top: 10px; display: flex; align-items: center; gap: 6px; }
    .step .st-desc { color: var(--muted); font-size: 12px; line-height: 1.5; margin-top: 4px; padding-right: 8px; }

    /* 两列 */
    .cols { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; align-items: start; }

    /* 目标卡片 */
    .target { padding: 18px 20px; }
    .target + .target { border-top: 1px solid var(--border); }
    .target-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .target-title { display: flex; align-items: center; gap: 8px; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin-top: 14px; }
    .metric { padding: 0 12px; }
    .metric:not(:last-child) { border-right: 1px solid var(--border); }
    .metric:first-child { padding-left: 0; }
    .metric .m-label { font-size: 11.5px; color: var(--muted); }
    .metric .m-value { font-size: 18px; font-weight: 600; margin-top: 2px; letter-spacing: -0.02em; }

    /* 侧栏 */
    .safety { padding: 16px 20px; }
    .safety ul, .problem-list { margin: 10px 0 0; padding-left: 16px; color: var(--muted); }
    .safety li, .problem-list li { margin-bottom: 6px; line-height: 1.55; }
    .backup { padding: 16px 20px; }
    .backup + .backup { border-top: 1px solid var(--border); }
    .backup-head { display: flex; justify-content: space-between; align-items: center; }
    .backup-title { display: flex; align-items: center; gap: 8px; }
    .select { width: 100%; margin-top: 10px; padding: 7px 10px; background: var(--bg-sunken); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 12.5px; }
    .backup-detail { min-height: 32px; margin-top: 8px; color: var(--muted); overflow-wrap: anywhere; line-height: 1.5; }
    .backup-foot { display: flex; justify-content: flex-end; margin-top: 10px; }
    .unapply { padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .unapply .u-desc { color: var(--muted); font-size: 12.5px; margin-top: 2px; }

    /* 进度 */
    .progress { padding: 14px 20px; }
    .progress-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .progress-title { font-weight: 600; }
    .track { height: 4px; background: var(--bg-sunken); border-radius: 999px; margin-top: 10px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); border-radius: inherit; transition: width 120ms ease-out; }
    .progress-msg { color: var(--muted); margin-top: 8px; font-size: 12.5px; overflow-wrap: anywhere; }
    .progress-count { color: var(--muted); margin-top: 6px; font-size: 12px; }

    /* 日志 */
    .log-box { padding: 16px 20px; }
    .log { margin-top: 12px; max-height: 240px; overflow: auto; background: var(--bg-sunken); border: 1px solid var(--border); border-radius: 6px; padding: 12px; color: var(--muted); line-height: 1.7; overflow-wrap: anywhere; }

    /* 弹窗 */
    dialog { width: min(560px, calc(100vw - 48px)); border: 1px solid var(--border); border-radius: 10px; padding: 0; color: var(--fg); background: var(--bg); }
    dialog::backdrop { background: rgba(0, 0, 0, 0.4); }
    .modal-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
    .modal-lead { color: var(--muted); margin-top: 6px; }
    .modal-body { padding: 18px 20px; color: var(--muted); line-height: 1.7; }
    .modal-body ul { padding-left: 18px; }
    .modal-body li { margin-bottom: 6px; }
    .modal-foot { display: flex; justify-content: flex-end; padding: 0 20px 18px; }

    @media (max-width: 880px) { .cols { grid-template-columns: 1fr; } .steps { grid-template-columns: repeat(2, 1fr); gap: 18px 8px; } .step:not(:last-child)::after { display: none; } .head { flex-direction: column; } .status-mini { text-align: left; } }
    @media (max-width: 620px) { .wrap { padding: 16px; } .metrics { grid-template-columns: 1fr; } .metric:not(:last-child) { border-right: 0; border-bottom: 1px solid var(--border); padding-bottom: 8px; } .actions { flex-direction: column; } button:not(.btn-icon) { width: 100%; } }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card card-pad">
      <div class="head">
        <div>
          <h1>Cursor 汉化管理器</h1>
          <p class="subtitle">一键把 Cursor 界面汉化成简体中文。改动前自动备份，可随时恢复。</p>
        </div>
        <div class="status-mini">
          <div class="label">当前状态</div>
          <div class="value ${overallState.className}"><span class="dot ${overallState.dotClass}"></span>${escapeHtml(overallState.text)}</div>
          ${renderHelpButton('overall')}
        </div>
      </div>
      <div class="actions">
        <button class="btn-primary" data-command="oneClick"${busyAttribute}>一键汉化</button>
        <button class="btn" data-command="autoLocate"${busyAttribute}>一键识别 Cursor</button>
        <button class="btn" data-command="rescan"${busyAttribute}>重新扫描状态</button>
        <button class="btn" data-command="applyPatch"${busyAttribute}>应用汉化补丁</button>
        <button class="btn" data-command="cleanRuntimeState"${busyAttribute}>清理运行时 UI 状态</button>
        <button class="btn-danger" data-command="restartCursor"${busyAttribute}>一键重启并清理 Cursor</button>
        <button class="btn" data-command="shutdownCursor"${busyAttribute}>强制关闭 Cursor</button>
        <button class="btn" data-command="chooseRoot"${busyAttribute}>手动选择目录</button>
      </div>
      <div class="next">
        <div>
          <div class="t">建议下一步</div>
          <div class="v">${escapeHtml(nextAction)}</div>
        </div>
        ${renderHelpButton('next-action')}
      </div>
    </section>

    ${renderProgressSection(state.progress)}

    <section class="card card-pad gap-top">
      <div class="section-title">
        <div class="left"><h2>引导</h2>${renderHelpButton('guide')}</div>
      </div>
      ${renderStepGuide(state)}
    </section>

    <section class="cols gap-top">
      <div class="card stack">
        ${renderTargetCard({
          title: 'Workbench 补丁',
          helpId: 'workbench-patch',
          scan: patch,
          patchStatusText
        })}
        ${renderTargetCard({
          title: 'NLS 消息表补丁',
          helpId: 'nls-patch',
          scan: nlsPatch,
          patchStatusText
        })}
        ${renderRuntimeStateCard(runtimeState)}
        ${install && !install.valid ? renderProblems(install.problems) : ''}
      </div>

      <aside class="card stack">
        <div class="safety">
          <div class="section-title"><div class="left"><h2>安全提示</h2>${renderHelpButton('safety')}</div></div>
          ${renderSafetyList()}
        </div>
        ${renderBackupCard({
          title: 'Workbench 备份恢复',
          helpId: 'workbench-backup',
          selectId: 'workbenchBackupSelect',
          command: 'restoreWorkbenchBackup',
          backups: patch?.backups ?? [],
          patchStatusText,
          busyAttribute
        })}
        ${renderBackupCard({
          title: 'NLS 消息表备份恢复',
          helpId: 'nls-backup',
          selectId: 'nlsBackupSelect',
          command: 'restoreNlsBackup',
          backups: nlsPatch?.backups ?? [],
          patchStatusText,
          busyAttribute
        })}
        <div class="unapply">
          <div>
            <h3>卸载当前补丁</h3>
            <div class="u-desc">移除已写入的汉化，操作前自动备份。</div>
          </div>
          <button class="btn-danger" data-command="unapplyPatch"${busyAttribute}>卸载补丁</button>
        </div>
      </aside>
    </section>

    <section class="card log-box gap-top">
      <div class="section-title"><div class="left"><h2>操作日志</h2>${renderHelpButton('logs')}</div></div>
      <div class="log mono">${state.logs.length ? state.logs.map(escapeHtml).join('<br>') : '暂无日志。执行识别、扫描、应用或恢复后，这里会显示结果摘要。'}</div>
    </section>
  </main>

  <dialog id="helpDialog">
    <div class="modal-head">
      <div>
        <h2 id="helpTitle">说明</h2>
        <p id="helpLead" class="modal-lead"></p>
      </div>
      <button id="helpCloseX" class="btn-icon" aria-label="关闭说明">i</button>
    </div>
    <div id="helpBody" class="modal-body"></div>
    <div class="modal-foot">
      <button id="helpClose" class="btn-primary">我知道了</button>
    </div>
  </dialog>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const helpItems = ${JSON.stringify(helpItems)};
    const dialog = document.getElementById('helpDialog');
    const helpTitle = document.getElementById('helpTitle');
    const helpLead = document.getElementById('helpLead');
    const helpBody = document.getElementById('helpBody');
    const closeDialog = () => dialog instanceof HTMLDialogElement ? dialog.close() : undefined;

    document.querySelectorAll('button[data-command]').forEach(button => {
      button.addEventListener('click', () => {
        const command = button.dataset.command;
        const backupSelectId = command === 'restoreWorkbenchBackup'
          ? 'workbenchBackupSelect'
          : command === 'restoreNlsBackup'
            ? 'nlsBackupSelect'
            : undefined;
        const backupSelect = backupSelectId ? document.getElementById(backupSelectId) : undefined;
        vscode.postMessage({
          command,
          backupPath: backupSelect instanceof HTMLSelectElement ? backupSelect.value : undefined
        });
      });
    });

    document.querySelectorAll('button[data-help]').forEach(button => {
      button.addEventListener('click', () => {
        const item = helpItems[button.dataset.help];
        if (!item || !(dialog instanceof HTMLDialogElement)) {
          return;
        }
        helpTitle.textContent = item.title;
        helpLead.textContent = item.lead;
        helpBody.innerHTML = '<ul>' + item.points.map(point => '<li>' + point + '</li>').join('') + '</ul>';
        dialog.showModal();
      });
    });

    document.getElementById('helpClose')?.addEventListener('click', closeDialog);
    document.getElementById('helpCloseX')?.addEventListener('click', closeDialog);
    dialog?.addEventListener('click', event => {
      if (event.target === dialog) {
        closeDialog();
      }
    });
  </script>
</body>
</html>`;
}

function renderHelpButton(id: string): string {
  return `<button class="btn-icon" data-help="${escapeHtml(id)}" title="查看详细说明" aria-label="查看详细说明">i</button>`;
}

function getOverallState(state: ManagerState): { text: string; className: string; dotClass: string } {
  if (state.progress) {
    return { text: `正在执行：${state.progress.operation}`, className: 'warn', dotClass: 'warn' };
  }

  if (!state.install?.valid) {
    return { text: '等待识别 Cursor 安装目录', className: 'warn', dotClass: 'warn' };
  }

  if (state.patch?.state === 'applied' && state.nlsPatch?.state === 'applied') {
    return { text: '两个补丁目标均已应用', className: 'ok', dotClass: 'ok' };
  }

  if (state.patch?.state === 'partial' || state.nlsPatch?.state === 'partial') {
    return { text: '检测到部分应用，需要重新应用或恢复', className: 'warn', dotClass: 'warn' };
  }

  if (state.patch || state.nlsPatch) {
    return { text: '已完成扫描，可按需应用补丁', className: '', dotClass: 'idle' };
  }

  return { text: '已识别目录，等待扫描状态', className: 'warn', dotClass: 'warn' };
}

function getNextAction(state: ManagerState, patchStatusText: Record<string, string>): string {
  if (state.progress) {
    return `请等待「${state.progress.operation}」完成，当前步骤会自动更新。`;
  }

  if (!state.install?.valid) {
    return '新手直接点「一键汉化」，自动跑完全部步骤。';
  }

  if (!state.patch || !state.nlsPatch) {
    return '目录已确认，点击「重新扫描状态」读取当前补丁状态。';
  }

  if (state.patch.state !== 'applied' || state.nlsPatch.state !== 'applied') {
    return `当前 Workbench 为「${patchStatusText[state.patch.state]}」，NLS 为「${patchStatusText[state.nlsPatch.state]}」。建议点击「应用汉化补丁」。`;
  }

  return '补丁已应用。若界面仍是旧文本，点击「一键重启并清理 Cursor」；如需回退，在右侧选择对应目标的备份恢复。';
}

function renderStepGuide(state: ManagerState): string {
  const hasInstall = Boolean(state.install?.valid);
  const hasScan = Boolean(state.patch || state.nlsPatch);
  const bothApplied = state.patch?.state === 'applied' && state.nlsPatch?.state === 'applied';
  const hasBackup = Boolean((state.patch?.backups.length ?? 0) + (state.nlsPatch?.backups.length ?? 0));
  const steps = [
    { id: 'locate', title: '识别目录', done: hasInstall, active: !hasInstall, desc: '自动找到 Cursor 安装位置。' },
    { id: 'scan', title: '扫描状态', done: hasScan, active: hasInstall && !hasScan, desc: '看看哪些还没汉化。' },
    { id: 'apply', title: '应用补丁', done: bothApplied, active: hasScan && !bothApplied, desc: '一键写入汉化，自动备份。' },
    { id: 'restart', title: '重启生效', done: bothApplied, active: bothApplied, desc: '重启 Cursor 看到中文。' },
    { id: 'restore', title: '需要时恢复', done: hasBackup, active: false, desc: '不满意可随时还原。' }
  ];

  return `<div class="steps">${steps.map((step, index) => `<div class="step ${step.done ? 'done' : ''} ${step.active ? 'active' : ''}">
    <span class="num">${index + 1}</span>
    <div class="st-title"><span>${escapeHtml(step.title)}</span>${renderHelpButton(`step-${step.id}`)}</div>
    <div class="st-desc">${escapeHtml(step.desc)}</div>
  </div>`).join('')}</div>`;
}

function renderTargetCard(input: {
  title: string;
  helpId: string;
  scan: PatchLikeScanResult | undefined;
  patchStatusText: Record<string, string>;
}): string {
  const stateText = input.scan ? input.patchStatusText[input.scan.state] : '未扫描';
  const dotClass = input.scan?.state === 'applied' ? 'ok' : input.scan?.state === 'partial' ? 'warn' : 'idle';

  return `<article class="target">
    <div class="target-head">
      <div class="target-title"><h2>${escapeHtml(input.title)}</h2>${renderHelpButton(input.helpId)}</div>
      <span class="pill"><span class="dot ${dotClass}"></span>${escapeHtml(stateText)}</span>
    </div>
    <div class="metrics">
      <div class="metric"><div class="m-label">已汉化</div><div class="m-value">${input.scan?.targetHits ?? '-'}</div></div>
      <div class="metric"><div class="m-label">待翻译</div><div class="m-value">${input.scan?.sourceHits ?? '-'}</div></div>
      <div class="metric"><div class="m-label">规则数</div><div class="m-value">${input.scan?.totalRules ?? '-'}</div></div>
    </div>
  </article>`;
}

function renderRuntimeStateCard(runtimeState: RuntimeStateScanResult | undefined): string {
  const stateText = runtimeState ? runtimeStateStatusText(runtimeState.state) : '未扫描';
  const dotClass = runtimeState?.state === 'clean' || runtimeState?.state === 'cleaned' || runtimeState?.state === 'not-found'
    ? 'ok'
    : runtimeState?.state === 'dirty' || runtimeState?.state === 'cursor-running'
      ? 'warn'
      : 'idle';

  return `<article class="target">
    <div class="target-head">
      <div class="target-title"><h2>运行时 UI 缓存</h2>${renderHelpButton('runtime-state')}</div>
      <span class="pill"><span class="dot ${dotClass}"></span>${escapeHtml(stateText)}</span>
    </div>
    <div class="metrics">
      <div class="metric"><div class="m-label">命中记录</div><div class="m-value">${runtimeState?.matchedRecords ?? '-'}</div></div>
      <div class="metric"><div class="m-label">可清理字段</div><div class="m-value">${runtimeState?.matchedFields ?? '-'}</div></div>
      <div class="metric"><div class="m-label">状态库</div><div class="m-value">${runtimeState?.exists === undefined ? '-' : runtimeState.exists ? '存在' : '未找到'}</div></div>
    </div>
  </article>`;
}

function runtimeStateStatusText(state: RuntimeStateCleanStateLike): string {
  const text: Record<RuntimeStateCleanStateLike, string> = {
    'not-found': '未找到',
    clean: '无需清理',
    dirty: '待清理',
    'cursor-running': 'Cursor 运行中',
    cleaned: '已清理',
    failed: '失败'
  };
  return text[state];
}

type RuntimeStateCleanStateLike = RuntimeStateScanResult['state'];

function renderBackupCard(input: {
  title: string;
  helpId: string;
  selectId: string;
  command: 'restoreWorkbenchBackup' | 'restoreNlsBackup';
  backups: readonly PatchBackupInfo[];
  patchStatusText: Record<string, string>;
  busyAttribute: string;
}): string {
  const selectedBackup = getSelectedBackup(input.backups);
  return `<article class="backup">
    <div class="backup-head">
      <div class="backup-title"><h3>${escapeHtml(input.title)}</h3>${renderHelpButton(input.helpId)}</div>
      <span class="pill">${input.backups.length} 个备份</span>
    </div>
    <select id="${escapeHtml(input.selectId)}" class="select" ${input.backups.length ? '' : 'disabled'}>
      ${renderBackupOptions(input.backups, input.patchStatusText)}
    </select>
    ${selectedBackup ? `<div class="backup-detail mono">${escapeHtml(formatBackupDetail(selectedBackup, input.patchStatusText))}</div>` : '<div class="backup-detail mono">暂无备份记录。应用、卸载或恢复时会自动生成相关备份。</div>'}
    <div class="backup-foot"><button data-command="${input.command}" class="btn"${input.busyAttribute} ${input.backups.length ? '' : 'disabled'}>恢复此备份</button></div>
  </article>`;
}

function renderSafetyList(): string {
  return `<ul>
    <li>改动前自动备份，可随时恢复。</li>
    <li>只改 Cursor 文件，不碰你的项目代码。</li>
  </ul>`;
}

function renderProblems(problems: readonly string[]): string {
  return `<div class="safety"><div class="section-title"><div class="left"><h2>路径问题</h2>${renderHelpButton('path-problems')}</div></div><ul class="problem-list">${problems.map(problem => `<li>${escapeHtml(problem)}</li>`).join('')}</ul></div>`;
}

function getHelpItems(): Record<string, { title: string; lead: string; points: readonly string[] }> {
  return {
    overall: {
      title: '当前状态怎么看',
      lead: '这里把目录、扫描、补丁和正在执行的操作合并成一个总览。',
      points: ['等待识别：还没有确认 Cursor 安装目录。', '已完成扫描：可以安全判断是否需要应用补丁。', '两个补丁目标均已应用：Workbench 与 NLS 消息表都已写入汉化。', '部分应用：通常是升级、手动修改或旧补丁残留导致，可以重新应用或从备份恢复。']
    },
    locate: {
      title: '识别 Cursor 安装目录',
      lead: '补丁必须写入 Cursor 安装目录，而不是你的项目目录。',
      points: ['一键识别会优先查找常见安装位置和已保存配置。', '手动选择时请选择 Cursor 的安装根目录，例如包含 resources/app 的目录。', '本扩展不会扫描或修改你的工作区项目文件。']
    },
    'next-action': {
      title: '建议下一步',
      lead: '这里会根据当前状态给出最保守的下一步。',
      points: ['未识别目录时，先识别或手动选择目录。', '已识别但未扫描时，先重新扫描。', '扫描后发现未应用或部分应用时，再应用补丁。', '补丁完成后使用一键重启并清理。']
    },
    guide: {
      title: '引导说明',
      lead: '按步骤走即可，不需要理解内部文件结构。',
      points: ['第 1 步确认 Cursor 安装位置。', '第 2 步读取两个目标文件的当前状态。', '第 3 步应用补丁并自动备份。', '第 4 步启动独立助手清理运行时状态并重新打开 Cursor。', '第 5 步仅在需要回退时使用备份恢复。']
    },
    'step-locate': { title: '步骤 1：识别目录', lead: '确认补丁要作用在哪个 Cursor 安装。', points: ['推荐先点一键识别。', '如果电脑里有多个 Cursor 或识别失败，再手动选择。', '目录无效时会显示具体问题。'] },
    'step-scan': { title: '步骤 2：扫描状态', lead: '扫描不会写入文件，只读取状态。', points: ['会同时检查 Workbench 主界面和 NLS 消息表。', '会统计英文源、中文目标和可用备份。', '扫描结果用于判断下一步是否需要应用或恢复。'] },
    'step-apply': { title: '步骤 3：应用补丁', lead: '真正写入汉化内容的步骤。', points: ['写入前会备份目标文件。', '规则按模块和上下文匹配，不做裸词替换。', '如果已经应用过，会尽量保持幂等，不重复破坏文件。'] },
    'step-restart': { title: '步骤 4：重启生效', lead: 'Cursor 已加载的界面资源不会自动刷新。', points: ['应用、卸载、恢复后都建议完全退出 Cursor 再打开。', '如果只是关闭窗口但后台进程仍在，可能仍看到旧界面。', '一键重启并清理会启动独立助手：先关闭当前识别安装对应的 Cursor.exe，再清理 state.vscdb UI 缓存，最后重新启动同一个 Cursor.exe。'] },
    'step-restore': { title: '步骤 5：恢复备份', lead: '需要回退时再使用。', points: ['Workbench 备份只恢复 Workbench。', 'NLS 备份只恢复 NLS 消息表。', '恢复前也会生成安全快照，方便再次回退。'] },
    'workbench-patch': {
      title: 'Workbench 主界面补丁',
      lead: '处理 Cursor 工作台主 bundle 中的私有硬编码 UI。',
      points: ['目标通常是 out/vs/workbench/workbench.desktop.main.js。', '适合处理按钮、菜单、面板标题、提示文字等 bundle 内文本。', '不会覆盖 VS Code 官方语言包能正常处理的通用文本。']
    },
    'nls-patch': {
      title: 'NLS 消息表补丁',
      lead: '处理运行时消息表里的私有文本，例如 Chat History。',
      points: ['目标是 out/nls.messages.json，同时依赖 out/nls.keys.json 做索引对齐。', '规则按 module/key/source 精确匹配，不会靠裸词搜索替换。', 'Chat History (Ctrl+Alt+\') 的文字部分来自这里，快捷键部分由 Cursor 运行时拼接。']
    },
    safety: {
      title: '安全策略',
      lead: '这个扩展按可回退、可扫描、可解释的方式工作。',
      points: ['所有写入动作都会尽量先生成备份或安全快照。', '只处理 Cursor 安装目录内明确目标文件。', '不会翻译聊天内容、项目文件、配置值、命令 ID 或内部标识。', '一键重启并清理会启动独立助手接管关闭、清理和重启流程。', '如果 Cursor 升级后文件结构变化，应先扫描再决定是否应用。']
    },
    'runtime-state': {
      title: '运行时 UI 缓存清理',
      lead: '处理 Cursor 写入 state.vscdb 的 UI 文本缓存。',
      points: ['不会把数据库里的英文替换成中文。', '不再额外创建 state.vscdb 副本，回退依赖 Cursor 自带的 state.vscdb.backup。', '只删除或清空命中完整英文 UI 文案的缓存字段，让 Cursor 下次从已补丁的默认配置重新生成。', '推荐使用「一键重启并清理 Cursor」；独立助手会在 Cursor 退出后再写入数据库，避免扩展宿主中断或运行时覆盖。']
    },
    'workbench-backup': {
      title: 'Workbench 备份恢复',
      lead: '只用于恢复 workbench.desktop.main.js。',
      points: ['优先选择标记为原始官方备份或当前补丁备份的记录。', '恢复前会保存当前文件作为安全快照。', '恢复后需要重启 Cursor。']
    },
    'nls-backup': {
      title: 'NLS 消息表备份恢复',
      lead: '只用于恢复 nls.messages.json。',
      points: ['不要用 Workbench 备份恢复 NLS，也不要反过来使用。', '恢复会替换消息表文件，并重新扫描状态。', '恢复后需要重启 Cursor。']
    },
    logs: {
      title: '操作日志',
      lead: '这里记录最近操作的关键结果。',
      points: ['应用补丁后会显示命中数量、写入数量和备份路径。', '失败时会显示错误摘要。', '如果仍有残留英文，日志可以帮助判断下一步该查哪个目标。']
    },
    'path-problems': {
      title: '路径问题',
      lead: '所选目录未通过 Cursor 安装校验时会出现。',
      points: ['常见原因是选到了项目目录、resources/app 目录或快捷方式目录。', '应选择 Cursor 安装根目录。', '可以重新点击手动选择修正。']
    }
  };
}

function renderProgressSection(progress: ManagerProgressState | undefined): string {
  if (!progress) {
    return '';
  }

  const count = progress.current !== undefined && progress.total !== undefined
    ? `<div class="progress-count mono">当前条数：${progress.current} / ${progress.total}</div>`
    : '';

  return `<section class="card progress gap-top" aria-live="polite">
    <div class="progress-head">
      <div class="progress-title">${escapeHtml(progress.operation)}</div>
      <div class="mono">${progress.percent}%</div>
    </div>
    <div class="progress-msg">${escapeHtml(progress.message)}</div>
    <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}">
      <div class="fill" style="width: ${progress.percent}%"></div>
    </div>
    ${count}
  </section>`;
}

function getSelectedBackup(backups: readonly PatchBackupInfo[]): PatchBackupInfo | undefined {
  return backups.find(backup => backup.currentMetadataBackup) ?? backups[0];
}

function renderBackupOptions(backups: readonly PatchBackupInfo[], patchStatusText: Record<string, string>): string {
  if (backups.length === 0) {
    return '<option value="">暂无备份记录</option>';
  }

  const selectedBackup = getSelectedBackup(backups);
  return backups.map(backup => {
    const selected = selectedBackup?.path === backup.path ? ' selected' : '';
    return `<option value="${escapeHtml(backup.path)}"${selected}>${escapeHtml(formatBackupOption(backup, patchStatusText))}</option>`;
  }).join('');
}

function formatBackupOption(backup: PatchBackupInfo, patchStatusText: Record<string, string>): string {
  const markers = [formatBackupKind(backup), patchStatusText[backup.status.state] ?? backup.status.state];

  if (backup.currentMetadataBackup) {
    markers.push('当前补丁备份');
  }

  return `${markers.join(' / ')} · ${formatDateTime(backup.modifiedAt)} · ${backup.name}`;
}

function formatBackupDetail(backup: PatchBackupInfo, patchStatusText: Record<string, string>): string {
  const patchState = patchStatusText[backup.status.state] ?? backup.status.state;
  return `${formatBackupKind(backup)}；补丁状态: ${patchState}；中文目标 ${backup.status.targetHits} / 英文源 ${backup.status.sourceHits}；${backup.path}`;
}

function formatBackupKind(backup: PatchBackupInfo): string {
  if (backup.isOriginal) {
    return '原始官方备份';
  }

  if (backup.kind === 'original') {
    return '原始备份候选';
  }

  if (backup.kind === 'before-restore') {
    return '恢复前快照';
  }

  if (backup.kind === 'before-uninstall') {
    return '卸载前快照';
  }

  return '未知备份';
}

function formatRuntimeCleanLog(result: Awaited<ReturnType<typeof cleanRuntimeState>>): string {
  if (result.changed) {
    return `运行时 UI 状态已清理：字段 ${result.cleanedFields.length} 个，删除记录 ${result.deletedRecords} 条。${result.runningProcessIds.length > 0 ? `Cursor 正在运行，进程 ${result.runningProcessIds.join(', ')}。` : ''}`;
  }

  return `运行时 UI 状态未写入：${result.message}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}