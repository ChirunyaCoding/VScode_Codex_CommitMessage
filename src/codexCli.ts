import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface CodexGenerateOptions {
  commandPath: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  output: vscode.OutputChannel;
}

export type CodexCliErrorCode =
  | 'not-found'
  | 'timeout'
  | 'model-access'
  | 'process-failed'
  | 'parse-failed'
  | 'empty-response';

export class CodexCliError extends Error {
  constructor(
    public readonly code: CodexCliErrorCode,
    message: string,
    public readonly details?: string
  ) {
    super(message);
  }
}

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

function toErrno(error: unknown): NodeJS.ErrnoException {
  return error as NodeJS.ErrnoException;
}

function isNotFoundLikeSpawnError(error: unknown): boolean {
  const errnoError = toErrno(error);
  return errnoError.code === 'ENOENT' || errnoError.code === 'EINVAL';
}

function uniqueCommandPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const commandPath of paths) {
    const normalized = process.platform === 'win32' ? commandPath.toLowerCase() : commandPath;
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(commandPath);
  }

  return results;
}

function getBundledWindowsCodexCandidates(): string[] {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    return [];
  }

  const extensionRoots = [
    path.join(userProfile, '.vscode', 'extensions'),
    path.join(userProfile, '.vscode-insiders', 'extensions')
  ];

  const candidates: string[] = [];
  for (const root of extensionRoots) {
    if (!fs.existsSync(root)) {
      continue;
    }

    let directories: fs.Dirent[];
    try {
      directories = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const directory of directories) {
      if (!directory.isDirectory()) {
        continue;
      }

      if (!directory.name.startsWith('openai.chatgpt-')) {
        continue;
      }

      candidates.push(path.join(root, directory.name, 'bin', 'windows-x86_64', 'codex.exe'));
    }
  }

  return candidates;
}

function buildCommandCandidates(configuredCommandPath: string): string[] {
  const commandPath = configuredCommandPath.trim();
  const candidates: string[] = [commandPath];

  if (process.platform === 'win32') {
    if (/\.(cmd|bat|ps1)$/i.test(commandPath)) {
      candidates.push(commandPath.replace(/\.(cmd|bat|ps1)$/i, ''));
      candidates.push(commandPath.replace(/\.(cmd|bat|ps1)$/i, '.exe'));
    }

    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(path.join(appData, 'npm', 'codex'));
      candidates.push(path.join(appData, 'npm', 'codex.exe'));
    }

    candidates.push(...getBundledWindowsCodexCandidates());
  }

  const filtered = candidates.filter((candidate) => {
    if (!candidate) {
      return false;
    }

    if (!path.isAbsolute(candidate)) {
      return true;
    }

    return fs.existsSync(candidate);
  });

  return uniqueCommandPaths(filtered);
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(text.length - maxChars);
}

function normalizeGeneratedMessage(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  return firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
}

function isModelAccessError(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    lowered.includes('does not exist or you do not have access') ||
    lowered.includes('do not have access to it')
  );
}

async function runCodexWithCommand(
  commandPath: string,
  options: CodexGenerateOptions
): Promise<string> {
  const args = [
    'exec',
    '--json',
    '-m',
    options.model,
    '-c',
    `model_reasoning_effort="${options.reasoningEffort}"`,
    options.prompt
  ];

  options.output.appendLine(
    `[codex] Running: ${commandPath} exec --json -m ${options.model} -c model_reasoning_effort="${options.reasoningEffort}" <prompt>`
  );

  return new Promise<string>((resolve, reject) => {
    let stdoutBuffer = '';
    let stdoutRaw = '';
    let stderrRaw = '';
    let lastAgentMessage: string | undefined;
    let timedOut = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(commandPath, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      if (isNotFoundLikeSpawnError(error)) {
        reject(
          new CodexCliError(
            'not-found',
            `Codex CLI was not found or not executable at "${commandPath}".`,
            toErrno(error).message
          )
        );
        return;
      }

      reject(new CodexCliError('process-failed', `Failed to launch Codex CLI: ${toErrno(error).message}`));
      return;
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      options.output.appendLine(`[codex] Timed out after ${options.timeoutMs} ms.`);
      child.kill();
    }, options.timeoutMs);

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      callback();
    };

    const processStdoutLines = (chunk: string): void => {
      stdoutRaw += chunk;
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split(/\r?\n/g);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let event: CodexJsonEvent;
        try {
          event = JSON.parse(trimmed) as CodexJsonEvent;
        } catch {
          continue;
        }

        if (
          event.type === 'item.completed' &&
          event.item?.type === 'agent_message' &&
          typeof event.item.text === 'string'
        ) {
          lastAgentMessage = event.item.text;
        }
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      processStdoutLines(data.toString('utf8'));
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrRaw += data.toString('utf8');
    });

    child.on('error', (error) => {
      settle(() => {
        if (isNotFoundLikeSpawnError(error)) {
          reject(new CodexCliError('not-found', `Codex CLI was not found at "${commandPath}".`));
          return;
        }

        reject(new CodexCliError('process-failed', `Failed to launch Codex CLI: ${error.message}`));
      });
    });

    child.on('close', (code) => {
      settle(() => {
        if (stdoutBuffer.trim().length > 0) {
          processStdoutLines('\n');
        }

        if (stderrRaw.trim().length > 0) {
          options.output.appendLine(`[codex][stderr tail]\n${tail(stderrRaw.trim(), 3000)}`);
        }

        if (stdoutRaw.trim().length > 0) {
          options.output.appendLine(`[codex][stdout tail]\n${tail(stdoutRaw.trim(), 3000)}`);
        }

        if (timedOut) {
          reject(new CodexCliError('timeout', `Codex generation timed out after ${options.timeoutMs} ms.`));
          return;
        }

        if (code !== 0) {
          const combined = `${stderrRaw}\n${stdoutRaw}`;
          if (isModelAccessError(combined)) {
            reject(
              new CodexCliError(
                'model-access',
                `Model access error for "${options.model}".`,
                tail(combined, 4000)
              )
            );
            return;
          }

          reject(
            new CodexCliError(
              'process-failed',
              `Codex CLI exited with code ${String(code)}.`,
              tail(combined, 4000)
            )
          );
          return;
        }

        if (!lastAgentMessage) {
          reject(new CodexCliError('parse-failed', 'No agent message was found in Codex JSON output.'));
          return;
        }

        const normalized = normalizeGeneratedMessage(lastAgentMessage);
        if (!normalized) {
          reject(new CodexCliError('empty-response', 'Generated message is empty after normalization.'));
          return;
        }

        resolve(normalized);
      });
    });
  });
}

export async function generateCommitMessageWithCodex(options: CodexGenerateOptions): Promise<string> {
  const commandCandidates = buildCommandCandidates(options.commandPath);
  let lastNotFoundError: CodexCliError | undefined;

  for (const commandPath of commandCandidates) {
    try {
      return await runCodexWithCommand(commandPath, options);
    } catch (error) {
      if (error instanceof CodexCliError && error.code === 'not-found') {
        lastNotFoundError = error;
        options.output.appendLine(`[codex] Candidate not available: ${commandPath}`);
        continue;
      }

      throw error;
    }
  }

  if (lastNotFoundError) {
    throw lastNotFoundError;
  }

  throw new CodexCliError(
    'not-found',
    `Codex CLI was not found at "${options.commandPath}".`,
    'No executable candidate could be resolved.'
  );
}
