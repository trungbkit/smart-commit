# 📚 Git Smart Commit - Usage Examples

## Scenario 1: Simple Feature Development

```bash
# 1. Create a feature branch
git checkout -b feature/add-login

# 2. Make changes
vim src/auth.js src/components/Login.tsx

# 3. Run smart commit (auto commit + push + create PR)
git smartc

# What happens:
# - Stages all changes
# - Claude analyzes your code changes
# - Generates commit message: "feat(auth): add login form component"
# - Creates commit with that message
# - Pushes to origin/feature/add-login
# - Analyzes all changes between feature/add-login and uat
# - Generates PR title: "feat(auth): add login form and validation"
# - Creates PR to uat with that title
# - Analyzes all changes between feature/add-login and main
# - Generates PR title: "feat(auth): add login form and validation"
# - Creates PR to main with that title
```

## Scenario 2: Bug Fix with Quick Commit

```bash
# 1. Make a fix
git checkout bugfix/null-check
vim src/utils/parser.js

# 2. Quick commit without PR
git smartc --no-pr

# What happens:
# - Same as above but without PR creation
# - Use when you just want to push and handle PRs manually
```

## Scenario 2.1: Commit Message vs PR Title (Branch Diff Analysis)

```bash
# 1. Create feature branch from develop
git checkout -b feature/auth-enhancement develop

# 2. Make multiple changes across commits
vim src/auth.js          # Add 2FA validation
git add .
git smartc

# ... more work ...
vim src/models/User.ts   # Update User model
git add .
git smartc

# ... more work ...
vim src/middleware/auth.ts  # Update middleware
git add .
git smartc

# 3. Now create PRs to both develop and main
git smartc develop,main

# PREVIEW shows:
# ├─ Commit message (current staged changes): "fix(auth): update middleware logic"
# ├─ PR to develop: "feat(auth): add 2FA validation and update middleware"
#    (analyzes ALL commits: 2FA + model update + middleware fix)
# └─ PR to main: "feat(auth): comprehensive authentication enhancement"
#    (analyzes ALL commits across larger branch diff to main)

# Why different?
# - Commit message = just what's being committed NOW
# - PR titles = summary of ALL changes between branches
# - This gives reviewers better context for each target branch
```

## Scenario 2.5: Manual Stage Mode (Selective Commit)

```bash
# When you have multiple changes but want to commit them separately

# 1. Stage only specific files
git add src/auth.js src/components/Login.tsx
# (don't add tests yet)

# 2. Create commit from only staged files
git smartc --no-stage

# What happens:
# - Takes ONLY staged changes for diff analysis
# - Generates commit message for those files
# - Commits without auto-staging everything
# - Other modified files remain uncommitted

# 3. Later, stage and commit the remaining changes
git add tests/auth.test.js
git smartc --no-stage
```

This is powerful when you want to:
- Commit logic changes separately from tests
- Split a large change into logical parts
- Exclude debug/temp files from commit
- Keep commits atomic and focused

## Scenario 3: Multiple Changes to Same Feature

```bash
# Change 1: Add password validation
vim src/validation.js
git smartc

# Change 2: Add password strength indicator
vim src/components/PasswordStrength.tsx
git smartc

# Change 3: Update tests
vim tests/validation.test.js
git smartc

# Result: 3 separate commits with meaningful messages
```

## Scenario 4: Merge to Custom Branches

```bash
# Instead of uat/main, merge to dev/staging/prod
git smartc dev,staging,prod

# What happens:
# - Commit and push (as usual)
# - Create PR to dev, staging, and prod
# - Asks if you want to merge to all three
```

## Scenario 5: Refactoring Large Codebase

```bash
# Make many changes
git checkout -b refactor/db-layer
# ... make 50+ file changes ...

# Run smart commit
git smartc

# What happens:
# - Claude analyzes the large diff
# - Identifies that it's a DB layer refactor
# - Generates: "refactor(db): extract database layer into separate module"
# - Creates meaningful commit despite size
# - Note: Very large diffs (>5000 lines) will be truncated for token limits
```

## Scenario 6: Dependency Updates

```bash
# Update dependencies
npm update
git smartc

# Generated message might be:
# "chore(deps): update dependencies"
```

## Scenario 7: Documentation Changes

```bash
# Update docs
vim README.md
vim docs/API.md
git smartc

# Generated message might be:
# "docs: add API authentication examples"
```

## Scenario 8: Performance Optimization

```bash
# Optimize query
vim src/services/api.ts
git smartc

# Generated message might be:
# "perf(api): add request caching layer"
```

## Scenario 9: CI/CD Configuration

```bash
# Update CI configuration
vim .github/workflows/main.yml
git smartc

# Generated message might be:
# "ci: add pre-commit linting checks"
```

## Scenario 10: Complex Multi-part Feature

```bash
# Part 1: Core feature
git checkout -b feature/payment-gateway
# ... implement Stripe integration ...
git smartc

# Part 2: Webhook handler
# ... add webhook handler ...
git smartc

# Part 3: Tests
# ... add comprehensive tests ...
git smartc

# Part 4: Documentation
# ... update docs ...
git smartc

# Result: 4 well-organized commits:
# 1. "feat(payment): integrate Stripe API"
# 2. "feat(payment): add webhook handler"
# 3. "test(payment): add integration tests"
# 4. "docs(payment): add Stripe setup guide"
```

## Common Workflows Comparison

### Old Manual Process (10+ minutes)

```bash
# Step 1: Stage changes (1 min)
git add .
git status

# Step 2: Think of commit message (2 min)
# Write something vague like "update code"

# Step 3: Commit (1 min)
git commit -m "update code"

# Step 4: Push (1 min)
git push

# Step 5: Create PR manually (3+ min)
# - Open GitHub
# - Navigate to repo
# - Click "New PR"
# - Fill in title and description
# - Click create

# Step 6: Merge (2+ min)
# - Navigate to uat branch
# - Manually merge or do same PR process again

# Step 7: Merge to main (2+ min)
# - Repeat for main branch
```

### With git-smart-commit (30 seconds)

```bash
git smartc
# Answer 2 prompts:
# - Review preview (5 sec)
# - Confirm merge to branches (5 sec)
# - System does the rest (20 sec)
```

### With --no-stage (Manual Selective Commits)

```bash
# Workflow for precise control
git add src/core-feature.js
git smartc --no-stage          # Commit 1: Core logic
# Result: "feat(core): implement search algorithm"

git add tests/core.test.js
git smartc --no-stage          # Commit 2: Tests
# Result: "test(core): add search algorithm tests"

git add docs/SEARCH.md
git smartc --no-stage          # Commit 3: Documentation
# Result: "docs(core): add search documentation"

# Total time: 1.5 minutes for 3 well-organized commits
# Quality: Each commit is focused and meaningful
```

## Model Selection: Why Haiku 4.5?

The tool uses **Claude Haiku 4.5** because:

- 📊 **Perfect for this task**: Commit message generation is classification/extraction, not complex reasoning
- ⚡ **3x faster** than Sonnet at generating responses
- 💰 **3.75x cheaper** than Sonnet per token
- ✅ **98% quality** of Sonnet for well-defined tasks like commit messages
- 🎯 **Optimized** for fast, deterministic outputs

### Cost Comparison (per 100 commits)

| Model | Input | Output | Total |
|-------|-------|--------|-------|
| Haiku 4.5 | $0.0005 | $0.003 | **$0.004** |
| Sonnet 4.6 | $0.0015 | $0.009 | $0.0105 |
| Savings | - | - | **60% cheaper** |

## Tips for Best Results

### Good Example

```bash
# Change multiple related files
# - Add new feature module
# - Update imports in main app
# - Add tests
# - Update documentation

# Claude will generate:
# "feat(search): add full-text search functionality"
```

### Less Ideal

```bash
# Change many unrelated files
# - Fix a bug in auth.js
# - Add feature in products.ts
# - Update config file
# - Delete old files

# Result might be vague: "chore: update multiple files"
# Recommendation: commit each logical change separately
```

## Integration with CI/CD

### GitHub Actions Example

```yaml
# .github/workflows/smart-merge.yml
name: Auto Merge Feature
on:
  push:
    branches: [feature/*, bugfix/*]

jobs:
  merge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0
          
      - name: Check if PR exists
        run: |
          # Only auto-merge if PR was created by git-smart-commit
          # You can identify it by commit message pattern
```

## Environment Variables

```bash
# Required
export ANTHROPIC_API_KEY=sk-ant-...

# Optional (add to ~/.zshrc or ~/.bashrc)
export GITHUB_TOKEN=ghp_...  # For gh CLI
```

## Troubleshooting Specific Scenarios

### Scenario: Merge conflicts during auto-merge

```bash
# If git smartc fails during merge
git merge --abort
git pull origin uat
git merge feature/my-branch
# Resolve conflicts manually
git smartc --no-pr  # Skip PR, just commit
```

### Scenario: Want to edit message before committing

```bash
# Use regular git flow instead
git add .
git commit  # Opens editor for message
git push

# Or modify script to add --amend option
```

### Scenario: Accidentally committed to wrong branch

```bash
git reset HEAD~1
git checkout correct-branch
git smartc
```

## Best Practices

1. **Commit frequently** - Small, logical changes are easier for AI to describe
2. **Keep branches focused** - One feature per branch for better commit messages
3. **Review the preview** - Always confirm the generated message makes sense
4. **Use conventional format** - Helps with changelog generation and CI automation
5. **Test before committing** - Ensure tests pass before running git smartc

## Advanced: Custom Commit Prompts

You can modify the Claude prompt in `git-smart-commit.js` to generate different styles:

```javascript
// Current format: conventional commits
// Possible alternatives:
// - Angular style
// - Gitmoji style  
// - Custom company format
// - With generated changelog entries
```

Would you like examples of custom prompt templates?
