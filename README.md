# 🚀 Git Smart Commit

AI-powered git workflow automation: generates commit messages from your diff, commits, pushes, and opens pull requests to your target branches.

Works with **Claude**, **OpenAI**, or **Gemini** — set whichever API key you have.

## ✨ Features

- 🤖 **AI-Generated Commits** — analyzes your diff and writes a Conventional Commits message
- 📝 **Smart PR Titles** — a separate title per target branch, generated from the full diff between your branch and `origin/<target>` (not just the last commit)
- 🔀 **Multi-provider** — Claude (OAuth or API key), OpenAI, or Gemini
- 🎯 **Multi-branch PRs** — open PRs to `uat`, `main`, or any branches in one run
- 👀 **Preview Before Execute** — review the message and PR titles before anything is written (skippable with `-y`)
- 🛡️ **Safety Checks** — detached HEAD, missing remote branches, and "no commits ahead" are detected and skipped with a warning instead of failing
- 🔒 **Shell-injection safe** — git/gh commands are invoked with argument arrays, never string-interpolated

## 📦 Installation

### Option 1: Installer script (Recommended)

```bash
bash install.sh
```

This installs the script to `~/.local/bin/git-smart-commit`, creates the `git smartc` alias, and checks your credentials plus the `gh` CLI.

### Option 2: Manual global install

```bash
sudo cp git-smart-commit.js /usr/local/bin/git-smart-commit
sudo chmod +x /usr/local/bin/git-smart-commit
git config --global alias.smartc '!git-smart-commit'
```

### Option 3: Local (per project)

```bash
cp git-smart-commit.js ~/my-project/
chmod +x ~/my-project/git-smart-commit.js
cd ~/my-project
git config --local alias.smartc '!node ./git-smart-commit.js'
```

### Requirements

- **Node.js** — no dependencies, uses only Node built-ins
- **git**
- **`gh` CLI** — optional; without it, commit and push still work and PR creation is skipped with a warning. Authenticate with `gh auth login`.

## 🔐 Setup Credentials

Set **one** of the following. They are tried in this priority order — if several are set, the first match wins:

| Priority | Environment variable | Provider | Model variable | Default model |
|---|---|---|---|---|
| 1 | `CLAUDE_CODE_OAUTH_TOKEN` | Claude (subscription billing) | — | `claude-haiku-4-5-20251001` |
| 2 | `ANTHROPIC_API_KEY` | Claude (pay-per-token) | — | `claude-haiku-4-5-20251001` |
| 3 | `OPENAI_API_KEY` | OpenAI | `OPENAI_MODEL` | `gpt-4o-mini` |
| 4 | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Google Gemini | `GEMINI_MODEL` | `gemini-2.0-flash` |

```bash
# Claude subscription (no per-token cost)
export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)

# Claude API key — https://console.anthropic.com
export ANTHROPIC_API_KEY=sk-ant-api03-...

# OpenAI — https://platform.openai.com/api-keys
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini          # optional

# Gemini — https://aistudio.google.com/apikey
export GEMINI_API_KEY=...
export GEMINI_MODEL=gemini-2.0-flash     # optional
```

Add the line to `~/.zshrc` or `~/.bashrc` to persist it. The script prints which provider it selected on every run.

The Claude model is not configurable via environment variable — edit `CONFIG.model` in the script to change it.

## 🎯 Usage

```bash
git-smart-commit [targets] [flags]
# or via alias
git smartc [targets] [flags]
```

### Arguments

| Argument | Description |
|---|---|
| `targets` | Comma-separated target branches for PRs, e.g. `staging,main`. Must be the **first** argument. Defaults to `uat,main`. |

### Flags

| Flag | Description |
|---|---|
| `--no-pr`, `--push-only`, `-po`, `-p` | Commit and push only; skip PR creation entirely (no target branches are fetched or analyzed) |
| `--no-stage`, `-ns` | Don't run `git add .` — commit only what you already staged |
| `--merge-local` | After creating PRs, merge locally into any **non-protected** target branches |
| `-y`, `--yes` | Skip the confirmation prompt |

### Examples

```bash
# Default: PRs to uat and main
git smartc

# PRs to staging only
git smartc staging

# PRs to main and staging
git smartc main,staging

# Commit + push, no PRs
git smartc --push-only     # or --no-pr / -po / -p

# Commit only pre-staged files
git add src/auth.js
git smartc --no-stage

# Merge into a non-protected branch locally after the PR
git smartc develop --merge-local

# Unattended
git smartc main -y
```

## 🔄 What It Actually Does

1. **Checks prerequisites** — git available, one credential set, warns if `gh` is missing
2. **Reads the diff** — staged changes if any, otherwise unstaged. Truncated to 5000 lines for analysis.
3. **Generates the commit message** — skipped if there is nothing to commit; the run continues to push existing commits and open PRs
4. **Fetches `origin`** (`git fetch --prune`) so all `origin/*` refs are current
5. **Generates a PR title per target** — in parallel, from `git diff origin/<target>...<branch>` (truncated to 8000 lines). If the target doesn't exist on the remote, the diff is empty, or the API call fails, it falls back to a human-readable title derived from the commit message or branch name.
6. **Shows the preview** and waits for confirmation (unless `-y`)
7. **Stages** (unless `--no-stage`) and **commits**
8. **Pushes** to `origin/<current-branch>`
9. **Creates PRs** via `gh`, skipping a target when:
   - the source or target branch isn't on `origin`
   - `origin/<branch>` has no commits ahead of `origin/<target>`
   - an open PR already exists between the two branches
10. **Prints merge instructions**, and with `--merge-local` merges into non-protected targets

### Preview output

```
╔════════════════════════════════════════════════╗
║         COMMIT & PR PREVIEW                     ║
╚════════════════════════════════════════════════╝

📌 Current branch: feature/auth
📦 Stage mode: AUTO (all files)
💬 Commit message: feat(auth): add password validation
📊 Target branches & PR titles:
   → uat: feat(auth): add password validation and reset flow
   → main: feat(auth): add password validation and reset flow

Proceed? (y/n): y
```

### Protected branches

`main`, `master`, `uat`, and `staging` are treated as protected — the script opens a PR and tells you to merge via the GitHub UI. `--merge-local` only affects targets outside that list; for those it checks out the branch, pulls, merges, pushes, and returns you to your original branch. Because local merging happens in the PR stage, `--merge-local` has no effect when combined with `--no-pr` / `--push-only` (the script warns if you pass both).

## 📋 Commit Message Format

The AI is prompted for **Conventional Commits**, under 50 characters, imperative mood:

```
type(scope): description

Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build

✅ feat(auth): add password reset flow
✅ fix(api): handle null responses
✅ refactor(db): optimize query performance
```

PR titles use the same format but allow up to 72 characters.

## 🚨 Troubleshooting

### `No API credentials found`

Set one of the four variables in the [credentials table](#-setup-credentials), then verify:

```bash
echo $ANTHROPIC_API_KEY   # or OPENAI_API_KEY / GEMINI_API_KEY
```

### `Detached HEAD. Please checkout a branch first.`

```bash
git checkout feature/your-feature
```

### `No changes to commit`

Not an error — the script warns and continues to push any existing commits and open PRs. Use `git status` to confirm what's there.

### PR not created — `gh CLI not found`

```bash
brew install gh        # macOS
apt-get install gh     # Linux
gh auth login
```

### `Target branch "x" not found on origin`

The target doesn't exist remotely. Create and push it, or pass a different target. The run continues and the PR to that branch is skipped.

### `No commits ahead of origin/<target>`

Your branch has nothing new relative to the target — everything is already merged, so no PR is opened.

### API Error: `401 Unauthorized` / `API key not valid`

The key for the selected provider is wrong or expired. Check the line the script prints at startup ("Using … API key") to see which provider it actually picked — Anthropic credentials take priority over OpenAI and Gemini.

## 🔧 Advanced Configuration

Environment variables cover the OpenAI and Gemini models. Everything else lives in the `CONFIG` object at the top of `git-smart-commit.js`:

```javascript
const CONFIG = {
  model: 'claude-haiku-4-5-20251001',  // Claude model
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  maxTokens: 500,                      // Raise for longer messages
  defaultTargets: ['uat', 'main'],     // Default PR targets
};
```

## 📊 Workflow Comparison

| Step | Manual | With `git-smart-commit` |
|------|--------|------------------------|
| Stage | `git add .` | Auto (or `--no-stage`) |
| Commit message | Write it yourself | 🤖 AI generated |
| Commit & push | 2 commands | Auto |
| Fetch remote state | `git fetch` | Auto |
| PR title | Write it yourself | 🤖 AI generated, per target |
| Create PRs | `gh pr create` per target | Auto, with duplicate/empty-PR guards |

## 💡 Tips

1. **Review the preview** — always check the generated message before confirming
2. **Keep commits atomic** — one logical change per commit produces better messages
3. **Push your branch first** if PRs are skipped — the guards compare `origin/<branch>` to `origin/<target>`
4. **Large diffs are truncated** (5000 lines for commits, 8000 for PR titles) — smaller commits get better analysis

## 🔐 Security Notes

- Credentials are read from environment variables only — never from files or arguments
- The Gemini key is sent as an `x-goog-api-key` header rather than a query parameter, so it can't leak into request logs
- Your diff is sent to the selected provider's API — don't use this on repos where that's not permitted
- git and `gh` commands are invoked with argument arrays (no shell), so branch names and commit messages can't be interpreted as shell syntax
- Never commit your API key to version control

## 📝 License

MIT

---

**Need help?**
- https://docs.claude.com — Claude API
- https://platform.openai.com/docs — OpenAI API
- https://ai.google.dev/gemini-api/docs — Gemini API
- https://github.com/cli/cli — GitHub CLI
- https://www.conventionalcommits.org — Conventional Commits
