# Codex Commit Push

VS Code拡張です。SCM入力欄右側の `commitMessage生成` ボタンで、ローカル `codex` CLI によるコミットメッセージ生成を行います。  
さらに、**この拡張で生成したメッセージでコミット成功した場合のみ** 自動で push を実行します。

## Features

- `scm/inputBox` に `commitMessage生成` ボタンを追加
- `codex exec --json` で日本語1行コミットメッセージを生成
- 生成メッセージと最新コミットの1行目が一致した場合のみ自動 push
- 自動 push は現在ブランチが `pushBranch` 設定値と一致したときのみ実行
- エラー時は通知し、`Output` の `Codex Commit Push` チャンネルへログ出力

## Requirements

- VS Code Insiders
- ローカル `codex` CLI がインストール済みでログイン済み
- Git が利用可能

## Important: Proposed API

この拡張は `scm/inputBox` を使うため Proposed API を利用します。

- Marketplace への通常公開は不可
- VSIX 配布前提
- 起動時に `--enable-proposed-api=<extension-id>` が必要

例:

```bash
code-insiders . --enable-proposed-api=local.codex-commit-push
```

## Settings

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `codexCommitPush.model` | string | `gpt-5.3-codex` | `codex exec -m` に渡すモデル |
| `codexCommitPush.reasoningEffort` | string | `high` | `model_reasoning_effort` |
| `codexCommitPush.includeUntracked` | boolean | `true` | 未追跡ファイル一覧をプロンプトに含める |
| `codexCommitPush.diffMaxChars` | number | `12000` | 差分文字数上限。超過時は `[TRUNCATED]` 付与 |
| `codexCommitPush.timeoutSeconds` | number | `90` | Codex生成タイムアウト秒数 |
| `codexCommitPush.codexCommandPath` | string | `codex` | Codex CLI コマンドパス |
| `codexCommitPush.pushRemote` | string | `origin` | 自動pushのremote名 |
| `codexCommitPush.pushBranch` | string | `main` | 自動push対象ブランチ名 |

## Usage

1. Source Controlビューで `commitMessage生成` を押す  
2. SCM入力欄に生成メッセージが入る  
3. そのままコミットする  
4. 最新コミット1行目が生成文面と一致し、現在ブランチが `pushBranch` と一致すると自動 push

## Development

```bash
npm install
npm run compile
```
