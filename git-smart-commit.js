#!/usr/bin/env node

/**
 * git-smart-commit: AI-powered git commit + PR creator
 * Uses AI to generate meaningful commit messages based on code changes
 *
 * Providers (auto-selected when MIMO_API_KEY is set, else Claude):
 * - MiMo (Xiaomi): export MIMO_API_KEY=tp-...
 *   Optional: MIMO_BASE_URL, MIMO_MODEL, GIT_SMARTC_PROVIDER=mimo
 * - Claude OAuth (subscription): export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
 * - Claude API key (pay-per-token): export ANTHROPIC_API_KEY=sk-ant-api03-...
 *   Optional: CLAUDE_MODEL, GIT_SMARTC_PROVIDER=anthropic
 *
 * WORKFLOW:
 * 1. Generates AI commit message from code changes
 * 2. Stages & commits changes to current branch
 * 3. Pushes to remote
 * 4. Creates PRs to target branches (uat, main, etc.)
 * 5. For protected branches → merge via GitHub UI
 * 6. For non-protected branches → can merge locally (with --merge-local flag)
 * 
 * USAGE:
 *   git-smart-commit                    # PR to uat & main
 *   git-smart-commit staging            # PR to staging only
 *   git-smart-commit main,staging       # PR to main & staging
 *   git-smart-commit --no-pr            # Commit & push, skip PR
 *   git-smart-commit --no-stage         # Skip auto-staging
 *   git-smart-commit develop --merge-local  # Merge develop locally
 *   git-smart-commit --provider mimo    # Force MiMo provider
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  provider: process.env.GIT_SMARTC_PROVIDER,
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  apiKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
  mimoApiKey: process.env.MIMO_API_KEY,
  mimoBaseUrl: process.env.MIMO_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1',
  mimoModel: process.env.MIMO_MODEL || 'mimo-v2.5-pro',
  maxTokens: 500,
  defaultTargets: ['uat', 'main'],
};

let activeProvider = null;

function hasMimoCredentials() {
  return Boolean(CONFIG.mimoApiKey);
}

function hasAnthropicCredentials() {
  return Boolean(CONFIG.oauthToken || CONFIG.apiKey);
}

function resolveProvider(cliOverride) {
  const forced = cliOverride || CONFIG.provider;

  if (forced) {
    if (forced !== 'mimo' && forced !== 'anthropic') {
      error(`Invalid provider "${forced}". Use "mimo" or "anthropic".`);
    }
    if (forced === 'mimo' && !hasMimoCredentials()) {
      error('MIMO_API_KEY is required when using the MiMo provider.');
    }
    if (forced === 'anthropic' && !hasAnthropicCredentials()) {
      error(
        'CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is required when using the Anthropic provider.'
      );
    }
    return forced;
  }

  if (hasMimoCredentials()) {
    return 'mimo';
  }

  if (hasAnthropicCredentials()) {
    return 'anthropic';
  }

  error(
    'No AI provider credentials found.\n\n' +
    'Option 1 - MiMo (Xiaomi):\n' +
    '  export MIMO_API_KEY=tp-...\n\n' +
    'Option 2 - Claude OAuth (subscription):\n' +
    '  export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)\n\n' +
    'Option 3 - Claude API key (pay-per-token):\n' +
    '  export ANTHROPIC_API_KEY=sk-ant-api03-...'
  );
}

function getActiveModel() {
  return activeProvider === 'mimo' ? CONFIG.mimoModel : CONFIG.claudeModel;
}

function getProviderLabel() {
  return activeProvider === 'mimo' ? 'MiMo' : 'Claude';
}

// ============================================================================
// UTILS
// ============================================================================

function log(msg, type = 'info') {
  const icons = {
    info: '📋',
    success: '✅',
    error: '❌',
    warning: '⚠️ ',
    loading: '⏳',
    arrow: '→ ',
  };
  console.log(`${icons[type] || ''} ${msg}`);
}

function error(msg) {
  log(msg, 'error');
  process.exit(1);
}

function exec(cmd, silent = false) {
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      stdio: silent ? 'pipe' : 'inherit',
    });
    return result ? result.trim() : '';
  } catch (e) {
    if (!silent) {
      error(`Command failed: ${cmd}\n${e.message}`);
    }
    throw e;  // Throw error instead of returning null
  }
}

function checkPrerequisites(cliProviderOverride) {
  log('Checking prerequisites...', 'loading');

  // Check git
  exec('git --version', true);

  activeProvider = resolveProvider(cliProviderOverride);

  if (activeProvider === 'mimo') {
    log(`Using MiMo (${getActiveModel()})`, 'info');
  } else if (CONFIG.oauthToken) {
    log(`Using Claude OAuth (${getActiveModel()}, subscription-based billing)`, 'info');
  } else {
    log(`Using Claude API key (${getActiveModel()}, pay-per-token billing)`, 'info');
  }

  // Check gh CLI (for PR creation)
  const hasGh = exec('which gh', true);
  if (!hasGh) {
    log(
      'gh CLI not found. PR creation will be skipped.\n' +
      'Install: brew install gh (macOS) or apt-get install gh (Linux)',
      'warning'
    );
  }

  log('Prerequisites OK', 'success');
}

function getCurrentBranch() {
  try {
    const branch = exec('git rev-parse --abbrev-ref HEAD', true);
    if (branch === 'HEAD') {
      error('Detached HEAD. Please checkout a branch first.');
    }
    return branch;
  } catch (err) {
    error(`Failed to get current branch: ${err.message}`);
  }
}

function debugGitStatus() {
  console.log('\n📊 Git Status Debug Info:');
  console.log('─'.repeat(50));

  try {
    const status = exec('git status --short', true);
    console.log('Changes to stage:');
    console.log(status || '(no changes)');

    const config = exec('git config user.name && git config user.email', true);
    console.log('\nGit config:');
    console.log(config || '(not configured)');

    const remote = exec('git remote -v', true);
    console.log('\nRemote:');
    console.log(remote || '(no remote)');
  } catch (err) {
    console.log('Could not retrieve git info');
  }
  console.log('─'.repeat(50) + '\n');
}

function getGitDiff() {
  try {
    // Get staged changes first
    let diff = exec('git diff --cached', true);

    // If nothing staged, get all changes
    if (!diff) {
      diff = exec('git diff', true);
    }

    if (!diff) {
      error('No changes to commit.\n\nTroubleshooting:\n1. Make sure you have modified files\n2. Run: git status\n3. Stage files: git add .');
    }

    // Limit diff size to avoid token limits (max 5000 lines)
    const lines = diff.split('\n');
    if (lines.length > 5000) {
      log(
        `Large diff (${lines.length} lines). Truncating to 5000 lines for analysis.`,
        'warning'
      );
      diff = lines.slice(0, 5000).join('\n');
    }

    return diff;
  } catch (err) {
    error(`Failed to get git diff: ${err.message}`);
  }
}

function getRecentCommits(count = 5) {
  return exec(`git log --oneline -${count}`, true);
}

function getDiffBetweenBranches(fromBranch, toBranch) {
  try {
    // Use three-dot diff to show changes on fromBranch not in toBranch
    let diff = exec(`git diff ${toBranch}...${fromBranch}`, true);

    if (!diff) {
      // If no diff found, try two-dot diff as fallback
      diff = exec(`git diff ${toBranch} ${fromBranch}`, true);
    }

    if (!diff) {
      log(
        `No changes found between ${toBranch} and ${fromBranch}.
        Branch may already be merged or no commits ahead.`,
        'warning'
      );
      return '';
    }

    // Limit diff size to avoid token limits (max 8000 lines)
    const lines = diff.split('\n');
    if (lines.length > 8000) {
      log(
        `Large diff (${lines.length} lines). Truncating to 8000 lines for analysis.`,
        'warning'
      );
      diff = lines.slice(0, 8000).join('\n');
    }

    return diff;
  } catch (err) {
    log(
      `Could not get diff between ${toBranch} and ${fromBranch}: ${err.message}`,
      'warning'
    );
    return '';
  }
}

// ============================================================================
// LLM API
// ============================================================================

function httpsPostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requestBody = JSON.stringify(body);
    const requestHeaders = {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody),
    };

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'POST',
      headers: requestHeaders,
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);

          if (res.statusCode !== 200) {
            const message =
              response.error?.message ||
              response.message ||
              `API Error (${res.statusCode})`;
            reject(new Error(message));
            return;
          }

          resolve(response);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

function callAnthropicAPI(prompt) {
  const headers = {
    'anthropic-version': '2023-06-01',
  };

  if (CONFIG.oauthToken) {
    headers['Authorization'] = `Bearer ${CONFIG.oauthToken}`;
  } else if (CONFIG.apiKey) {
    headers['x-api-key'] = CONFIG.apiKey;
  }

  return httpsPostJson(
    'https://api.anthropic.com/v1/messages',
    headers,
    {
      model: CONFIG.claudeModel,
      max_tokens: CONFIG.maxTokens,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }
  ).then((response) => response.content[0]?.text || '');
}

function callMimoAPI(prompt) {
  const baseUrl = CONFIG.mimoBaseUrl.replace(/\/$/, '');

  return httpsPostJson(
    `${baseUrl}/chat/completions`,
    {
      'api-key': CONFIG.mimoApiKey,
    },
    {
      model: CONFIG.mimoModel,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_completion_tokens: CONFIG.maxTokens,
      stream: false,
      thinking: {
        type: 'disabled',
      },
    }
  ).then((response) => response.choices[0]?.message?.content || '');
}

function callLLM(prompt) {
  if (activeProvider === 'mimo') {
    return callMimoAPI(prompt);
  }
  return callAnthropicAPI(prompt);
}

async function generateCommitMessage(diff, recentCommits) {
  log(`Analyzing changes with ${getProviderLabel()}...`, 'loading');

  const prompt = `You are a professional git commit message generator. Analyze the following code changes and generate a concise, meaningful commit message.

## Recent commits for context:
\`\`\`
${recentCommits}
\`\`\`

## Code changes to analyze:
\`\`\`diff
${diff}
\`\`\`

## Requirements:
1. Follow conventional commits format: type(scope): description
2. Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build
3. Keep description under 50 characters
4. Be specific about what changed
5. Use imperative mood (e.g., "add" not "added")
6. Return ONLY the commit message, nothing else

Example format: feat(auth): add login validation
`;

  try {
    const message = await callLLM(prompt);
    return message.trim();
  } catch (err) {
    error(`Failed to generate commit message: ${err.message}`);
  }
}

async function generatePRTitle(diff, targetBranch) {
  if (!diff) {
    return `Merge into ${targetBranch}`;
  }

  log(`Generating PR title for ${targetBranch}...`, 'loading');

  const prompt = `You are a professional pull request title generator. Analyze the following code changes and generate a concise, meaningful PR title that summarizes all changes.

## Code changes to analyze:
\`\`\`diff
${diff}
\`\`\`

## Requirements:
1. Follow conventional commits format: type(scope): description (but can be slightly longer than commit messages)
2. Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build
3. Keep title under 72 characters
4. Summarize the overall impact/purpose of all changes
5. Use imperative mood (e.g., "add" not "added")
6. Be specific about what changed
7. Return ONLY the PR title, nothing else

Example format: feat(auth): add login form and validation logic
`;

  try {
    const title = await callLLM(prompt);
    return title.trim();
  } catch (err) {
    log(`Failed to generate PR title: ${err.message}`, 'warning');
    return `Merge into ${targetBranch}`;
  }
}

// ============================================================================
// GIT OPERATIONS
// ============================================================================

function stageChanges() {
  log('Staging changes...', 'loading');
  try {
    exec('git add .', true);
    log('Changes staged', 'success');
  } catch (err) {
    error(
      `Failed to stage changes: ${err.message}\n\n` +
      'Troubleshooting:\n' +
      '1. Check git status: git status\n' +
      '2. Verify you have changes to stage\n' +
      '3. Check file permissions: ls -la\n' +
      '4. Try: git add . manually first'
    );
  }
}

function createCommit(message) {
  log(`Creating commit: "${message}"`, 'loading');
  try {
    exec(`git commit -m "${message.replace(/"/g, '\\"')}"`, true);
    log('Commit created', 'success');
    return message;
  } catch (err) {
    error(
      `Failed to create commit: ${err.message}\n\n` +
      'Troubleshooting:\n' +
      '1. Verify changes are staged: git status\n' +
      '2. Check git config: git config user.name && git config user.email\n' +
      '3. Try staging manually: git add .\n' +
      '4. Try committing manually: git commit -m "your message"'
    );
  }
}

function pushChanges(branch) {
  log(`Pushing to origin/${branch}...`, 'loading');
  try {
    exec(`git push origin ${branch}`, true);
    log(`Pushed to origin/${branch}`, 'success');
  } catch (err) {
    error(
      `Failed to push: ${err.message}\n\n` +
      'Troubleshooting:\n' +
      '1. Check network connection\n' +
      '2. Verify remote: git remote -v\n' +
      '3. Check if branch exists remotely\n' +
      '4. Try: git push -u origin ' + branch
    );
  }
}

function mergeBranch(from, to) {
  log(`Merging ${from} → ${to}...`, 'arrow');

  const currentBranch = getCurrentBranch();

  exec(`git checkout ${to}`, true);
  exec('git pull --prune', true);
  exec(`git merge ${from} --no-edit`, true);
  exec('git push', true);

  log(`Merged to ${to}`, 'success');

  // Return to original branch
  exec(`git checkout ${currentBranch}`, true);
}

function createPullRequest(from, to, title) {
  // Check if gh CLI is available
  const hasGh = exec('which gh', true);
  if (!hasGh) {
    log(
      `To create PR automatically, install gh CLI:\n` +
      `  brew install gh  # macOS\n` +
      `  apt-get install gh  # Linux\n` +
      `Then run: git-smart-commit --with-pr`,
      'warning'
    );
    return;
  }

  log(`Creating PR ${from} → ${to}: "${title}"...`, 'loading');

  try {
    exec(
      `gh pr create --base ${to} --head ${from} --title "${title.replace(/"/g, '\\"')}" --fill`,
      true
    );
    log(`PR created: ${from} → ${to}`, 'success');
  } catch (e) {
    // PR might already exist, that's ok
    log(`PR may already exist for ${from} → ${to}`, 'warning');
  }
}

function generatePRTitles(currentBranch, targetBranches) {
  const titles = {};
  for (const target of targetBranches) {
    titles[target] = null; // Will be populated asynchronously
  }
  return titles;
}

// ============================================================================
// PROMPTS & CONFIRMATIONS
// ============================================================================

function getUserConfirmation(message) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function showPreview(commitMessage, currentBranch, targetBranches, prTitles = {}, autoStage = true) {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║         COMMIT & PR PREVIEW                     ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
  console.log(`📌 Current branch: ${currentBranch}`);
  console.log(`${autoStage ? '📦' : '⏭️ '} Stage mode: ${autoStage ? 'AUTO (all files)' : 'MANUAL (staged only)'}`);
  console.log(`💬 Commit message: ${commitMessage}`);
  console.log(`📊 Target branches & PR titles:`);
  for (const target of targetBranches) {
    const title = prTitles[target] || '(generating...)';
    console.log(`   → ${target}: ${title}`);
  }
  console.log('');

  const proceed = await getUserConfirmation('Proceed? (y/n): ');
  console.log('');

  return proceed;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    // Parse arguments
    const args = process.argv.slice(2);
    let targetBranches = CONFIG.defaultTargets;
    let createPRs = true;
    let autoStage = true;  // Whether to auto-stage files
    let autoMerge = false; // Whether to merge locally after PR (only for non-protected)
    let cliProviderOverride = null;

    if (args.length > 0) {
      const first = args[0];
      if (!first.startsWith('--')) {
        targetBranches = first.split(',');
      }
    }

    const providerArgIndex = args.indexOf('--provider');
    if (providerArgIndex !== -1) {
      cliProviderOverride = args[providerArgIndex + 1];
      if (!cliProviderOverride || cliProviderOverride.startsWith('--')) {
        error('Missing value for --provider. Use: --provider mimo|anthropic');
      }
    }

    if (args.includes('--no-pr')) {
      createPRs = false;
    }

    if (args.includes('--no-stage') || args.includes('-ns')) {
      autoStage = false;
    }

    if (args.includes('--merge-local')) {
      autoMerge = true;
    }

    // Welcome
    console.log('');
    log('Git Smart Commit - AI-Powered Workflow', 'info');
    console.log('');

    // Prerequisites
    checkPrerequisites(cliProviderOverride);
    console.log('');

    // Get current state
    const currentBranch = getCurrentBranch();
    const diff = getGitDiff();
    const recentCommits = getRecentCommits();

    // Generate commit message
    const commitMessage = await generateCommitMessage(diff, recentCommits);

    // Generate PR titles for each target branch
    const prTitles = {};
    for (const target of targetBranches) {
      const branchDiff = getDiffBetweenBranches(currentBranch, target);
      prTitles[target] = await generatePRTitle(branchDiff, target);
    }

    // Show preview
    const confirmed = await showPreview(
      commitMessage,
      currentBranch,
      targetBranches,
      prTitles,
      autoStage
    );

    if (!confirmed) {
      log('Aborted', 'error');
      process.exit(0);
    }

    // Execute workflow
    console.log('');
    log('Executing workflow...', 'loading');
    console.log('');

    if (autoStage) {
      stageChanges();
    } else {
      log('Skipping auto-stage (use --no-stage)', 'warning');
      debugGitStatus();
    }
    createCommit(commitMessage);
    pushChanges(currentBranch);

    // Create PRs
    if (createPRs) {
      console.log('');
      log('Creating pull requests...', 'loading');
      console.log('');
      for (const target of targetBranches) {
        const prTitle = prTitles[target] || commitMessage;
        createPullRequest(currentBranch, target, prTitle);
      }

      console.log('');
      console.log('╔════════════════════════════════════════════════╗');
      console.log('║              MERGE INSTRUCTIONS                 ║');
      console.log('╚════════════════════════════════════════════════╝');

      // Check for protected branches
      const protectedBranches = ['main', 'master', 'uat', 'staging'];
      const hasProtected = targetBranches.some(b => protectedBranches.includes(b));
      const nonProtected = targetBranches.filter(b => !protectedBranches.includes(b));

      if (hasProtected) {
        console.log('\n📢 Protected Branches (main, uat, staging, master):');
        console.log('   ✋ Cannot merge locally - use GitHub/GitLab UI');
        targetBranches
          .filter(b => protectedBranches.includes(b))
          .forEach(branch => {
            console.log(`   📍 PR created for → ${branch}`);
          });
      }

      if (nonProtected.length > 0) {
        console.log('\n🔓 Non-Protected Branches:');
        console.log('   ✅ Can merge locally or via UI');
        nonProtected.forEach(branch => {
          console.log(`   📍 PR created for → ${branch}`);
        });

        if (autoMerge) {
          console.log('\n   Merging locally...');
          for (const branch of nonProtected) {
            mergeBranch(currentBranch, branch);
          }
        }
      }

      console.log('\n💡 Next steps:');
      console.log('   1. Review PR on GitHub/GitLab');
      console.log('   2. Request/wait for approvals');
      console.log('   3. Merge via UI when ready\n');
    }

    console.log('');
    console.log('╔════════════════════════════════════════════════╗');
    console.log('║            ✨ WORKFLOW COMPLETE ✨              ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log('');
  } catch (err) {
    console.error('');
    error(`Workflow failed: ${err.message}`);
  }
}

// Run
main();