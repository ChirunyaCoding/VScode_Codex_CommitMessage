import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CodexCliError, ReasoningEffort, generateCommitMessageWithCodex } from './codexCli';
import { collectDiffForPrompt } from './diffCollector';
import { GitAPI, GitRepository, getGitApi, repositoryKey, resolveRepository } from './gitApi';
import { buildCommitMessagePrompt } from './prompt';
import { PendingCommitState } from './state';

const COMMAND_ID = 'codexCommitPush.generateCommitMessage';
const CONFIG_NAMESPACE = 'codexCommitPush';
const OUTPUT_CHANNEL_NAME = 'Codex Commit Push';
const execFileAsync = promisify(execFile);

interface ExtensionSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  includeUntracked: boolean;
  diffMaxChars: number;
  timeoutSeconds: number;
  codexCommandPath: string;
  autoCommitAfterGenerate: boolean;
  pushRemote: string;
  pushBranch: string;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const props = Object.getOwnPropertyNames(error);
  const shaped: Record<string, unknown> = {};
  const errorRecord = error as unknown as Record<string, unknown>;
  for (const prop of props) {
    shaped[prop] = errorRecord[prop];
  }

  return JSON.stringify(shaped, null, 2);
}

function getSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

  const model = config.get<string>('model', 'gpt-5.3-codex');
  const reasoningEffortRaw = config.get<string>('reasoningEffort', 'high');
  const reasoningEffortOptions: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
  const reasoningEffort = reasoningEffortOptions.includes(reasoningEffortRaw as ReasoningEffort)
    ? (reasoningEffortRaw as ReasoningEffort)
    : 'high';

  const includeUntracked = config.get<boolean>('includeUntracked', true);
  const diffMaxChars = Math.max(1000, config.get<number>('diffMaxChars', 12000));
  const timeoutSeconds = Math.max(10, config.get<number>('timeoutSeconds', 90));
  const codexCommandPath = config.get<string>('codexCommandPath', 'codex');
  const autoCommitAfterGenerate = config.get<boolean>('autoCommitAfterGenerate', true);
  const pushRemote = config.get<string>('pushRemote', 'origin');
  const pushBranch = config.get<string>('pushBranch', 'main');

  return {
    model,
    reasoningEffort,
    includeUntracked,
    diffMaxChars,
    timeoutSeconds,
    codexCommandPath,
    autoCommitAfterGenerate,
    pushRemote,
    pushBranch
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/g)[0]?.trim() ?? '';
}

function registerCommitListeners(
  api: GitAPI,
  pendingState: PendingCommitState,
  output: vscode.OutputChannel,
  pushInFlight: Set<string>
): vscode.Disposable {
  const repositoryDisposables = new Map<string, vscode.Disposable>();

  const registerRepository = (repository: GitRepository): void => {
    const key = repositoryKey(repository);
    if (repositoryDisposables.has(key)) {
      return;
    }

    const disposable = repository.onDidCommit(() => {
      void handleCommitEvent(repository, pendingState, output, pushInFlight, false);
    });

    repositoryDisposables.set(key, disposable);
    output.appendLine(`[git] Registered commit listener for ${repository.rootUri.fsPath}`);
  };

  const unregisterRepository = (repository: GitRepository): void => {
    const key = repositoryKey(repository);
    const disposable = repositoryDisposables.get(key);
    if (!disposable) {
      return;
    }

    disposable.dispose();
    repositoryDisposables.delete(key);
    output.appendLine(`[git] Unregistered commit listener for ${repository.rootUri.fsPath}`);
  };

  for (const repository of api.repositories) {
    registerRepository(repository);
  }

  const onDidOpenRepository = api.onDidOpenRepository((repository) => {
    registerRepository(repository);
  });

  const onDidCloseRepository = api.onDidCloseRepository((repository) => {
    unregisterRepository(repository);
  });

  return new vscode.Disposable(() => {
    onDidOpenRepository.dispose();
    onDidCloseRepository.dispose();
    for (const disposable of repositoryDisposables.values()) {
      disposable.dispose();
    }

    repositoryDisposables.clear();
  });
}

async function handleCommitEvent(
  repository: GitRepository,
  pendingState: PendingCommitState,
  output: vscode.OutputChannel,
  pushInFlight: Set<string>,
  showSkipNotification: boolean
): Promise<void> {
  const pending = pendingState.get(repository);
  if (!pending) {
    return;
  }

  const key = repositoryKey(repository);
  if (pushInFlight.has(key)) {
    return;
  }

  pushInFlight.add(key);
  try {
    const settings = getSettings();
    let latestCommit;
    try {
      latestCommit = await repository.getCommit('HEAD');
    } catch {
      const headCommit = repository.state.HEAD?.commit;
      if (!headCommit) {
        output.appendLine('[push] HEAD commit hash is unavailable. Auto-push skipped.');
        if (showSkipNotification) {
          vscode.window.showWarningMessage('最新コミットを取得できず、自動pushをスキップしました。');
        }

        return;
      }

      latestCommit = await repository.getCommit(headCommit);
    }

    const latestMessage = firstLine(latestCommit.message);
    if (latestMessage !== pending.message.trim()) {
      output.appendLine(
        `[push] Latest commit message does not match generated message. Skipping auto-push.\n  latest: ${latestMessage}\n  generated: ${pending.message}`
      );
      if (showSkipNotification) {
        vscode.window.showInformationMessage('生成メッセージと一致しないため、自動pushをスキップしました。');
      }

      return;
    }

    const head = repository.state.HEAD;
    const currentBranchName = head?.name ?? '';
    if (currentBranchName !== settings.pushBranch) {
      if (showSkipNotification) {
        vscode.window.showInformationMessage(
          `自動pushをスキップしました。現在ブランチは "${currentBranchName || 'unknown'}" で、対象は "${settings.pushBranch}" です。`
        );
      }

      output.appendLine(
        `[push] Branch mismatch. current=${currentBranchName || 'unknown'} target=${settings.pushBranch}`
      );
      return;
    }

    output.appendLine(`[push] Executing auto-push to ${settings.pushRemote}/${settings.pushBranch}`);
    await repository.push(settings.pushRemote, settings.pushBranch, false);
    vscode.window.showInformationMessage(
      `生成メッセージのコミットを ${settings.pushRemote}/${settings.pushBranch} へ自動pushしました。`
    );
    output.appendLine('[push] Auto-push succeeded.');
  } catch (error) {
    const message = toErrorMessage(error);
    const isRejected =
      /rejected|non-fast-forward|failed to push|cannot lock ref|updates were rejected/i.test(message);

    if (isRejected) {
      vscode.window.showErrorMessage(`自動pushに失敗しました（拒否）: ${message}`);
    } else {
      vscode.window.showErrorMessage(`自動pushに失敗しました: ${message}`);
    }

    output.appendLine(`[push] Auto-push failed: ${message}`);
  } finally {
    pendingState.clear(repository);
    pushInFlight.delete(key);
  }
}

function isNoChangesCommitError(message: string): boolean {
  return /nothing to commit|no changes added|working tree clean|empty commit message/i.test(message);
}

async function stageAllChangesWithGitCli(repositoryPath: string, output: vscode.OutputChannel): Promise<void> {
  output.appendLine(`[commit] Staging changes with git CLI: git -C "${repositoryPath}" add -A -- .`);
  await execFileAsync('git', ['-C', repositoryPath, 'add', '-A', '--', '.'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  });
}

async function handleGenerateCommand(
  api: GitAPI,
  pendingState: PendingCommitState,
  output: vscode.OutputChannel,
  pushInFlight: Set<string>,
  contextArg: unknown
): Promise<void> {
  const repository = await resolveRepository(api, contextArg);
  if (!repository) {
    vscode.window.showWarningMessage('Gitリポジトリを特定できませんでした。');
    return;
  }

  const settings = getSettings();
  const repositoryPath = repository.rootUri.fsPath;

  let diffResult;
  try {
    diffResult = await collectDiffForPrompt({
      repositoryPath,
      includeUntracked: settings.includeUntracked,
      maxChars: settings.diffMaxChars,
      output
    });
  } catch (error) {
    const message = toErrorMessage(error);
    output.appendLine(`[diff] Failed to collect diff: ${message}`);
    vscode.window.showErrorMessage(`差分の収集に失敗しました: ${message}`);
    return;
  }

  if (!diffResult.diffText.trim()) {
    vscode.window.showInformationMessage('差分がないため、commitMessageを生成できません。');
    return;
  }

  if (diffResult.wasTruncated) {
    output.appendLine(`[diff] Prompt diff text was truncated to ${settings.diffMaxChars} characters.`);
  }

  const prompt = buildCommitMessagePrompt(diffResult.diffText);
  const timeoutMs = settings.timeoutSeconds * 1000;

  try {
    const message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CodexでcommitMessageを生成中...',
        cancellable: false
      },
      async () =>
        generateCommitMessageWithCodex({
          commandPath: settings.codexCommandPath,
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
          prompt,
          cwd: repositoryPath,
          timeoutMs,
          output
        })
    );

    repository.inputBox.value = message;
    pendingState.set(repository, {
      message,
      createdAt: Date.now()
    });

    output.appendLine(`[generate] Generated message: ${message}`);

    if (!settings.autoCommitAfterGenerate) {
      vscode.window.showInformationMessage(
        `commitMessageを入力しました（autoCommitAfterGenerate=false）。コミット成功時に ${settings.pushRemote}/${settings.pushBranch} へ自動pushします。`
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'コミットして自動push中...',
        cancellable: false
      },
      async () => {
        output.appendLine('[commit] Auto-commit started.');
        await stageAllChangesWithGitCli(repository.rootUri.fsPath, output);
        await repository.commit(message, { postCommitCommand: null });
        output.appendLine('[commit] Auto-commit completed.');
      }
    );

    await handleCommitEvent(repository, pendingState, output, pushInFlight, true);
  } catch (error) {
    pendingState.clear(repository);

    const errorMessage = toErrorMessage(error);
    output.appendLine(`[error][details] ${toErrorDetails(error)}`);
    if (isNoChangesCommitError(errorMessage)) {
      vscode.window.showWarningMessage('コミット対象の変更がないため、自動コミットをスキップしました。');
      output.appendLine(`[commit] Auto-commit skipped: ${errorMessage}`);
      return;
    }

    if (error instanceof CodexCliError) {
      switch (error.code) {
        case 'not-found':
          vscode.window.showErrorMessage(
            `codex CLI が見つかりません。設定 "${CONFIG_NAMESPACE}.codexCommandPath" を確認してください。`
          );
          break;
        case 'timeout':
          vscode.window.showErrorMessage(`Codex生成がタイムアウトしました（${settings.timeoutSeconds}秒）。`);
          break;
        case 'model-access':
          vscode.window.showErrorMessage(
            `モデル "${settings.model}" の利用権限エラーで生成に失敗しました。`
          );
          break;
        case 'parse-failed':
        case 'empty-response':
          vscode.window.showErrorMessage('Codexの出力からコミットメッセージを取得できませんでした。');
          break;
        default:
          vscode.window.showErrorMessage(`Codex生成に失敗しました: ${error.message}`);
          break;
      }

      output.appendLine(`[generate] Codex error (${error.code}): ${error.message}`);
      if (error.details) {
        output.appendLine(`[generate] Details:\n${error.details}`);
      }
      return;
    }

    output.appendLine(`[generate] Unexpected error: ${errorMessage}`);
    vscode.window.showErrorMessage(`commitMessage生成または自動コミットに失敗しました: ${errorMessage}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  let api: GitAPI;
  try {
    api = await getGitApi();
  } catch (error) {
    const message = toErrorMessage(error);
    output.appendLine(`[activate] Failed to initialize Git API: ${message}`);
    vscode.window.showErrorMessage(`Codex Commit Push: Git API初期化に失敗しました: ${message}`);
    return;
  }

  const pendingState = new PendingCommitState();
  const pushInFlight = new Set<string>();
  context.subscriptions.push(registerCommitListeners(api, pendingState, output, pushInFlight));

  const generateCommand = vscode.commands.registerCommand(COMMAND_ID, async (contextArg: unknown) => {
    await handleGenerateCommand(api, pendingState, output, pushInFlight, contextArg);
  });
  context.subscriptions.push(generateCommand);

  output.appendLine('[activate] Extension activated.');
}

export function deactivate(): void {
  // No-op.
}
