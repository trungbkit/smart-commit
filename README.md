# 🚀 Git Smart Commit

AI-powered git workflow automation using Claude API to generate meaningful commit messages and create PRs automatically.

## ✨ Features

- 🤖 **AI-Generated Commits** - Claude analyzes your code changes and generates meaningful commit messages
- 📝 **Smart PR Titles** - Generates unique PR titles from all changes between your branch and target branch (not just the latest commit)
- 🔄 **Multi-branch Merge** - Automatically merge to uat, main, or any branches
- ✅ **Preview Before Execute** - Review changes before committing
- 🛡️ **Safety Checks** - Validates prerequisites and detached HEAD states

## 📦 Installation

### Option 1: Global Installation (Recommended)

```bash
# 1. Copy the script to /usr/local/bin
sudo cp git-smart-commit.js /usr/local/bin/git-smart-commit
sudo chmod +x /usr/local/bin/git-smart-commit

# 2. Create a git alias
git config --global alias.smartc '!git-smart-commit'

# 3. Set ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY=sk-ant-...
# Or add to ~/.zshrc / ~/.bashrc for persistence:
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc
```

### Option 2: Local Installation

```bash
# 1. Save script in your project
cp git-smart-commit.js ~/my-project/
chmod +x ~/my-project/git-smart-commit.js

# 2. Create local alias
cd ~/my-project
git config local alias.smartc '!node ./git-smart-commit.js'

# 3. Use with: git smartc
```

### Option 3: Install from npm (Future)

```bash
npm install -g git-smart-commit
git-smart-commit
```

## 🔐 Setup API Key

### Get Anthropic API Key

1. Go to https://console.anthropic.com
2. Create an API key
3. Copy the key (starts with `sk-ant-`)

### Set Environment Variable

```bash
# Temporary (current session only)
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Permanent (macOS/Linux)
echo 'export ANTHROPIC_API_KEY=sk-ant-your-key-here' >> ~/.zshrc
source ~/.zshrc

# Permanent (Windows PowerShell)
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-your-key-here", "User")
```

### Verify Setup

```bash
echo $ANTHROPIC_API_KEY  # Should print your key
```

## 🎯 Usage

### Basic Usage

```bash
# Stage all changes, generate commit message, commit, and push
git-smart-commit

# Or with alias
git smartc
```

### Custom Target Branches

```bash
# Merge to staging and production instead of uat/main
git-smart-commit staging,production

# Or
git smartc develop,release
```

### Create Only Commit (No PR)

```bash
git-smart-commit --no-pr
```

### Manual Stage Mode (Commit Only Staged Files)

```bash
# Stage files manually first
git add src/auth.js tests/auth.test.js

# Then run commit (without auto-staging everything)
git-smart-commit --no-stage

# Or short form
git-smart-commit -ns
```

This is useful when you want to commit different parts of your changes separately or exclude certain files.

### Full Workflow Example

```bash
# 1. Make changes
vim src/auth.js
vim tests/auth.test.js

# 2. Run smart commit
git smartc

# Expected output:
# ✅ Prerequisites OK
# ⏳ Analyzing changes with Claude...
# 📋 Analyzing changes with Claude...
# 
# ╔════════════════════════════════════════╗
# ║         COMMIT & PR PREVIEW             ║
# ╚════════════════════════════════════════╝
# 
# 📌 Current branch: feature/auth
# 💬 Commit message: feat(auth): add password validation
# 🔗 PR title: feat(auth): add password validation
# 📊 Target branches: uat, main
# 
# Proceed? (y/n): y
# 
# 📝 Staging changes...
# ✅ Changes staged
# 📝 Creating commit: "feat(auth): add password validation"...
# ✅ Commit created
# → Pushing to origin/feature/auth...
# ✅ Pushed to origin/feature/auth
# 
# 📋 Creating pull requests...
# 📌 Creating PR feature/auth → uat: "feat(auth): add password validation"...
# ✅ PR created: feature/auth → uat
# 📌 Creating PR feature/auth → main: "feat(auth): add password validation"...
# ✅ PR created: feature/auth → main
# 
# Merge to target branches? (y/n): y
# 
# 📋 Merging to target branches...
# 
# → Merging feature/auth → uat...
# ✅ Merged to uat
# → Merging feature/auth → main...
# ✅ Merged to main
# 
# ╔════════════════════════════════════════╗
# ║     ✨ WORKFLOW COMPLETE ✨            ║
# ╚════════════════════════════════════════╝
```

## 🔄 Workflow Variations

### Just Commit + Push

```bash
# Using shell alias (from earlier setup)
git ac "Your message"
```

### Commit + Push + Create PR Only (No Merge)

```bash
git-smart-commit --no-pr
# Then manually review PR before merging
```

### Full Automation (Commit → Push → PR → Merge)

```bash
git-smart-commit
# Answer "y" to all prompts
```

## 🛠️ Integration with Previous Aliases

Combine with your existing git aliases:

```bash
# .gitconfig setup

[alias]
  # Smart commit with AI
  smartc = !node /path/to/git-smart-commit.js
  
  # Quick commit without PR (uses provided message)
  ac = !f() { \
    git add .; \
    git commit -m "${1:-Chore: update}"; \
    git push origin $(git rev-parse --abbrev-ref HEAD); \
  }; f
  
  # Merge multiple branches
  amm = !f() { \
    CURRENT=$(git rev-parse --abbrev-ref HEAD); \
    for BRANCH in ${1:-uat main}; do \
      git checkout $BRANCH && git pull && git merge $CURRENT && git push; \
    done; \
    git checkout $CURRENT; \
  }; f
```

## 📋 Commit Message Format

The AI generates commits following **Conventional Commits** format:

```
type(scope): description

Allowed types:
- feat      (new feature)
- fix       (bug fix)
- refactor  (code restructuring)
- chore     (maintenance, updates)
- docs      (documentation)
- test      (test files)
- style     (formatting, missing semicolons)
- perf      (performance improvements)
- ci        (CI/CD changes)
- build     (build system changes)

Examples:
✅ feat(auth): add password reset flow
✅ fix(api): handle null responses
✅ refactor(db): optimize query performance
✅ chore(deps): update dependencies
```

## 🚨 Troubleshooting

### Error: `ANTHROPIC_API_KEY not set`

```bash
# Set the environment variable
export ANTHROPIC_API_KEY=sk-ant-...

# Verify it's set
echo $ANTHROPIC_API_KEY
```

### Error: `Detached HEAD`

```bash
# Make sure you're on a branch
git checkout feature/your-feature
git-smart-commit
```

### Error: `No changes to commit`

```bash
# Make sure you have staged or unstaged changes
git status
# Make changes to your files, then try again
```

### PR not created (gh CLI not found)

```bash
# Install GitHub CLI
brew install gh        # macOS
apt-get install gh     # Linux/Ubuntu
choco install gh       # Windows

# Authenticate with GitHub
gh auth login
```

### API Error: `401 Unauthorized`

```bash
# Check your API key is correct
echo $ANTHROPIC_API_KEY

# Regenerate from https://console.anthropic.com
# Then update:
export ANTHROPIC_API_KEY=sk-ant-new-key-here
```

## 🔧 Advanced Configuration

### Custom Model

Edit `git-smart-commit.js` and change:

```javascript
const CONFIG = {
  model: 'claude-haiku-4-5-20251001',  // Currently optimized for commit messages
  // ...
};
```

Available models: 
- `claude-haiku-4-5-20251001` (Recommended - current)
- `claude-sonnet-4-20250514` (If you need better reasoning)
- `claude-opus-4-20250805` (Only if absolutely necessary)

### Adjust Analysis Detail

Change `maxTokens` for more detailed analysis:

```javascript
const CONFIG = {
  maxTokens: 500,  // Increase for longer commits
  // ...
};
```

### Custom Default Branches

```javascript
const CONFIG = {
  defaultTargets: ['uat', 'staging', 'main'],  // Your branches
  // ...
};
```

## 📊 Workflow Comparison

| Step | Manual | With `git ac` | With `git-smart-commit` |
|------|--------|---------------|------------------------|
| Stage | `git add .` | Auto | Auto |
| Commit Message | Manual type | Manual | 🤖 AI Generated |
| Commit | `git commit` | Auto | Auto |
| Push | `git push` | Auto | Auto |
| Create PR | `gh pr create` | Manual | Auto |
| Merge | Manual per branch | Manual | Auto |
| **Total Time** | 3-5 min | 1-2 min | **30 seconds** |

## 💡 Tips & Best Practices

1. **Review the preview** - Always check the AI-generated message before confirming
2. **Keep commits atomic** - Make one logical change per commit
3. **Use meaningful file changes** - Diff quality affects message quality
4. **Set proper branch** - Ensure you're on the right feature branch
5. **Check API quota** - Monitor your Anthropic API usage

## 🔐 Security Notes

- API key is read from `ANTHROPIC_API_KEY` environment variable only
- Never commit your API key to version control
- Use `.env` files locally (add to `.gitignore`)
- For team usage, consider using GitHub Secrets or organization-level API management

## 📝 License

MIT

## 🤝 Contributing

Issues and suggestions welcome!

---

**Need help?** Check:
- https://docs.claude.com - Claude API documentation
- https://github.com/cli/cli - GitHub CLI documentation
- https://www.conventionalcommits.org - Conventional Commits format
