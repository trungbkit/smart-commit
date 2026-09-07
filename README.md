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
| `targets` | Comma-separated target branches for PRs, e.g. `staging,main`. May appear anywhere among the flags. Defaults to `uat,main`. |

### The pipeline

A run is four steps, and **each one executes only when it has something to
do** — decided from the repository, not from flags:

```
stage  ─────▶  commit  ─────▶  push  ─────▶  pr
  │              │              │            │
  │              │              │            └─ unless --no-pr
  │              │              └─ skipped if origin is already up to date
  │              └─ skipped if nothing is staged
  └─ skipped if the working tree is clean
```

So there is no flag for "nothing to commit" or "nothing to push": run
`git smartc uat` in a dirty tree and it stages, commits, pushes and opens the
PR; run it on a clean branch that's already pushed and it just opens the PR.
Flags only ever *subtract* steps.

### Flags

| Flag | Description |
|---|---|
| `--no-stage`, `-ns` | Don't run `git add .` — commit only what you already staged. Working-tree changes are left alone. |
| `--no-commit`, `-nc` | Don't commit at all. Implies `--no-stage`, so the working tree and index are untouched. |
| `--no-push`, `-np` | Don't push. Any commit this run makes stays local. |
| `--no-pr` | Don't create PRs (no target branches are fetched or analyzed) |
| `--pr-only` | PR only — shorthand for `--no-commit --no-push` |
| `--push-only`, `-po`, `-p` | Alias for `--no-pr` |
| `--merge-local` | After creating PRs, merge locally into any **non-protected** target branches |
| `--dry-run` | Print the plan and exit without changing anything |
| `-y`, `--yes` | Skip the confirmation prompt |
| `-h`, `--help` | Print the flag reference and exit |

Switching off `commit`, `push` and `pr` together is rejected — that leaves no
pipeline to run.

### Examples

```bash
# Stage, commit, push, then PRs to uat and main
git smartc

# PRs to staging only
git smartc staging

# PRs to main and staging
git smartc main,staging

# Commit only pre-staged files, then push and open the PR
git add src/auth.js
git smartc uat -ns

# Nothing to commit — just push what's local and open the PR
git smartc uat -nc

# Nothing to push either — open the PR for what origin already has
git smartc uat --pr-only

# Commit + push, no PRs
git smartc --no-pr         # or --push-only / -po / -p

# Commit locally without pushing, then look at the plan first
git smartc uat -np --dry-run

# Merge into a non-protected branch locally after the PR
git smartc develop --merge-local

# Unattended
git smartc main -y

# Flags and targets can be interleaved
git smartc -ns uat -y
```

The last three use cases above need no flag at all when the repository state
already says so: on a clean branch with unpushed commits, plain
`git smartc uat` pushes and opens the PR; on a clean, already-pushed branch it
opens the PR alone.

Unknown flags and space-separated targets (`git smartc uat main`) are rejected
with an error rather than silently ignored.

## 🔄 What It Actually Does

1. **Checks prerequisites** — git available, one credential set, warns if `gh` is missing
2. **Fetches `origin`** (`git fetch --prune`) so all `origin/*` refs are current — needed before it can tell whether a push is required
3. **Resolves the plan** — intersects the flags with the real state of the
   repository (unstaged files, untracked files, index, commits ahead of
   `origin`) to decide which of the four steps will run. Nothing left to do
   means it says so and exits `0`.
4. **Reads the diff** for the commit message — the whole working tree
   (`git diff HEAD` plus untracked filenames) when this run will stage, the
   index alone (`git diff --cached`) under `--no-stage`, so the message always
   describes exactly what the commit will contain. Truncated to 5000 lines.
5. **Generates the commit message** — only when a commit is actually planned
6. **Generates a PR title per target** — only when PRs are planned; in parallel, from `git diff origin/<target>...<branch>` (truncated to 8000 lines). If the target doesn't exist on the remote, the diff is empty, or the API call fails, it falls back to a human-readable title derived from the commit message or branch name.
7. **Shows the plan** and waits for confirmation (unless `-y` or `--dry-run`)
8. **Runs the planned steps** — stage, commit, push, in that order
9. **Creates PRs** via `gh`, skipping a target when:
   - the source or target branch isn't on `origin`
   - `origin/<branch>` has no commits ahead of `origin/<target>`
   - an open PR already exists between the two branches
10. **Prints merge instructions** for the targets that actually ended up with an
    open PR, and with `--merge-local` merges into the non-protected ones

### Plan output

The preview is the pipeline itself — one line per step, in execution order,
each saying what it will do or why it won't:

```
╔════════════════════════════════════════════════╗
║                 WORKFLOW PLAN                   ║
╚════════════════════════════════════════════════╝

📌 Current branch: feature/auth

   ✅ stage   git add . (modified files + new files)
   ✅ commit  "feat(auth): add password validation"
   ✅ push    origin/feature/auth
   ✅ pr
        → uat: feat(auth): add password validation and reset flow
        → main: feat(auth): add password validation and reset flow

Proceed? (y/n): y
```

Under `git smartc uat -ns` with an empty index, the same plan reads:

```
   ⏭️  stage   skipped (-ns)
   ⏭️  commit  skipped (nothing staged)
   ✅ push    origin/feature/auth
   ✅ pr
        → uat: feat(auth): add password validation and reset flow

⚠️  Working-tree changes are being left behind.
```

Use `--dry-run` to stop right there without touching anything.

### Protected branches

`main`, `master`, `uat`, and `staging` are treated as protected — the script opens a PR and tells you to merge via the GitHub UI. `--merge-local` only affects targets outside that list; for those it checks out the branch, pulls, merges, pushes, and returns you to your original branch. Because local merging happens in the PR stage, `--merge-local` has no effect when combined with `--no-pr` / `--push-only` / `-po` / `-p` (the script warns if you pass both). It also only merges targets that actually ended up with an open PR.

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

### `getaddrinfo ENOTFOUND api.anthropic.com` / `EAI_AGAIN`

The API host cannot be resolved. Transient failures are retried automatically (3 attempts by default), so a message that survives the retries means the network really cannot reach the provider:

```bash
# 1. Is there connectivity / is the VPN up?
curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/v1/models   # 401 = reachable

# 2. On a proxy-only corporate network, point the script at the proxy
export HTTPS_PROXY=http://user:pass@proxy.corp:8080
export NO_PROXY=localhost,127.0.0.1,.internal.corp

# 3. Or route through an internal gateway / mirror
export ANTHROPIC_BASE_URL=https://ai-gateway.corp/anthropic
```

`HTTPS_PROXY` (or `ALL_PROXY`) is honoured through an HTTP `CONNECT` tunnel, including `Proxy-Authorization` when the URL carries credentials, and `NO_PROXY` exclusions are respected.

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

### Network environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Route Claude calls through a gateway or mirror |
| `OPENAI_BASE_URL` | `https://api.openai.com` | Same, for OpenAI |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Same, for Gemini |
| `HTTPS_PROXY` / `ALL_PROXY` | — | Proxy to tunnel API requests through (`CONNECT`) |
| `NO_PROXY` | — | Comma-separated hosts that bypass the proxy |
| `GIT_SMART_COMMIT_TIMEOUT_MS` | `30000` | Per-request timeout |
| `GIT_SMART_COMMIT_RETRIES` | `3` | Total attempts per request, including the first |

Retries apply to transient failures only — DNS and connection errors, timeouts, HTTP 408/429 and 5xx — with exponential backoff (and `Retry-After` when the server sends one). Auth and validation errors fail immediately.

## 📊 Workflow Comparison

| Step | Manual | With `git-smart-commit` |
|------|--------|------------------------|
| Stage | `git add .` | Auto, skipped if clean (or `--no-stage`) |
| Commit message | Write it yourself | 🤖 AI generated |
| Commit & push | 2 commands | Auto, each skipped if there's nothing to do |
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
