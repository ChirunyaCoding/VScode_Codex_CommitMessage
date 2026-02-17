# Codex Commit Push

VS Code拡張です。ソース管理ツールバーの `commitMessage生成` ボタンで、ローカル `codex` CLI によるコミットメッセージ生成を行います。  
さらに、**この拡張で生成したメッセージでコミット成功した場合のみ** 自動で push を実行します。

## Features

- `scm/title`（ソース管理ツールバー）に `commitMessage生成` ボタンを追加
- `codex exec --json` で日本語1行コミットメッセージを生成
- 既定で、生成後に自動コミットを実行
- 生成メッセージと最新コミットの1行目が一致した場合のみ自動 push
- 自動 push は現在ブランチが `pushBranch` 設定値と一致したときのみ実行
- エラー時は通知し、`Output` の `Codex Commit Push` チャンネルへログ出力

## Requirements

- VS Code
- ローカル `codex` CLI がインストール済みでログイン済み
- Git が利用可能

## Settings

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `codexCommitPush.model` | string | `gpt-5.3-codex` | `codex exec -m` に渡すモデル |
| `codexCommitPush.reasoningEffort` | string | `high` | `model_reasoning_effort` |
| `codexCommitPush.includeUntracked` | boolean | `true` | 未追跡ファイル一覧をプロンプトに含める |
| `codexCommitPush.diffMaxChars` | number | `12000` | 差分文字数上限。超過時は `[TRUNCATED]` 付与 |
| `codexCommitPush.timeoutSeconds` | number | `90` | Codex生成タイムアウト秒数 |
| `codexCommitPush.codexCommandPath` | string | `codex` | Codex CLI コマンドパス |
| `codexCommitPush.autoCommitAfterGenerate` | boolean | `true` | 生成直後に自動コミットする |
| `codexCommitPush.pushRemote` | string | `origin` | 自動pushのremote名 |
| `codexCommitPush.pushBranch` | string | `main` | 自動push対象ブランチ名 |

## Usage

1. Source Controlビューで `commitMessage生成` を押す  
2. SCM入力欄に生成メッセージが入る  
3. 既定では自動コミットされる（`autoCommitAfterGenerate=true`）  
4. 最新コミット1行目が生成文面と一致し、現在ブランチが `pushBranch` と一致すると自動 push

## Development

```bash
npm install
npm run compile
```
