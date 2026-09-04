#!/usr/bin/env node

/**
 * git-smart-commit: AI-powered git commit + PR creator
 * Uses Claude API to generate meaningful commit messages based on code changes
 *
 * Supports (in priority order):
 * - OAuth tokens (subscription-based): export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
 * - Anthropic API keys (pay-per-token): export ANTHROPIC_API_KEY=sk-ant-api03-...
 * - OpenAI API keys (fallback provider): export OPENAI_API_KEY=sk-...
 * - Gemini API keys (fallback provider): export GEMINI_API_KEY=...
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
 *   git-smart-commit --push-only        # Same as --no-pr (aliases: -p, -po)
 *   git-smart-commit --no-stage         # Skip auto-staging
 *   git-smart-commit develop --merge-local  # Merge develop locally
 *   git-smart-commit main -y            # Skip the confirmation prompt
 *   git-smart-commit -ns uat -y         # Flags may come before the targets
 *   git-smart-commit --help             # Full flag reference
 */

const { execSync, spawnSync } = require("child_process");
const https = require("https");
const crypto = require("crypto");

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  apiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  model: "claude-haiku-4-5-20251001", // Optimized for classification tasks like commit messages
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini", // Used when only OPENAI_API_KEY is set
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash", // Used when only a Gemini key is set
  maxTokens: 500,
  defaultTargets: ["uat", "main"],
};

// True when an Anthropic credential (OAuth token or API key) is available.
// Anthropic takes priority; OpenAI then Gemini are the fallback providers.
function hasAnthropicAuth() {
  return Boolean(CONFIG.oauthToken || CONFIG.apiKey);
}

// The provider that will actually serve requests, resolved once from whichever
// credentials are present. Priority: Anthropic → OpenAI → Gemini.
function activeProvider() {
  if (hasAnthropicAuth()) return "anthropic";
  if (CONFIG.openaiApiKey) return "openai";
  if (CONFIG.geminiApiKey) return "gemini";
  return null;
}

// Display name for the active provider, used in progress messages.
function providerLabel() {
  return (
    { anthropic: "Claude", openai: "OpenAI", gemini: "Gemini" }[
      activeProvider()
    ] || "AI"
  );
}

// ============================================================================
// UTILS
// ============================================================================

function log(msg, type = "info") {
  const icons = {
    info: "📋",
    success: "✅",
    error: "❌",
    warning: "⚠️ ",
    loading: "⏳",
    arrow: "→ ",
  };
  console.log(`${icons[type] || ""} ${msg}`);
}

function error(msg) {
  log(msg, "error");
  process.exit(1);
}

function exec(cmd, silent = false) {
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      stdio: silent ? "pipe" : "inherit",
    });
    return result ? result.trim() : "";
  } catch (e) {
    if (!silent) {
      error(`Command failed: ${cmd}\n${e.message}`);
    }
    throw e; // Throw error instead of returning null
  }
}

// Run a command with arguments passed as an array (no shell). This avoids
// shell interpolation entirely, so values like commit messages or PR titles
// that contain `"`, backticks, `$()`, etc. can never be interpreted as shell
// syntax. Returns trimmed stdout; throws on non-zero exit.
function run(file, args) {
  const result = spawnSync(file, args, { encoding: "utf-8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const err = new Error(
      stderr || `${file} exited with code ${result.status}`,
    );
    err.stderr = result.stderr;
    throw err;
  }
  return (result.stdout || "").trim();
}

function checkPrerequisites() {
  log("Checking prerequisites...", "loading");

  // Check git
  exec("git --version", true);

  // Check OAuth token or API key (Anthropic, OpenAI or Gemini)
  if (!activeProvider()) {
    error(
      "No API credentials found. Set one of:\n\n" +
        "Option 1 - Claude OAuth Token (subscription-based):\n" +
        "  export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)\n\n" +
        "Option 2 - Anthropic API Key (pay-per-token):\n" +
        "  export ANTHROPIC_API_KEY=sk-ant-api03-...\n\n" +
        "Option 3 - OpenAI API Key:\n" +
        "  export OPENAI_API_KEY=sk-...\n\n" +
        "Option 4 - Gemini API Key:\n" +
        "  export GEMINI_API_KEY=...",
    );
  }

  // Show which auth method is being used (Anthropic takes priority)
  if (CONFIG.oauthToken) {
    log("Using Claude OAuth token (subscription-based billing)", "info");
  } else if (CONFIG.apiKey) {
    log("Using Anthropic API key (pay-per-token billing)", "info");
  } else if (CONFIG.openaiApiKey) {
    log(`Using OpenAI API key (model: ${CONFIG.openaiModel})`, "info");
  } else if (CONFIG.geminiApiKey) {
    log(`Using Gemini API key (model: ${CONFIG.geminiModel})`, "info");
  }

  // Check gh CLI (for PR creation)
  const hasGh = exec("which gh", true);
  if (!hasGh) {
    log(
      "gh CLI not found. PR creation will be skipped.\n" +
        "Install: brew install gh (macOS) or apt-get install gh (Linux)",
      "warning",
    );
  }

  log("Prerequisites OK", "success");
}

function getCurrentBranch() {
  try {
    const branch = exec("git rev-parse --abbrev-ref HEAD", true);
    if (branch === "HEAD") {
      error("Detached HEAD. Please checkout a branch first.");
    }
    return branch;
  } catch (err) {
    error(`Failed to get current branch: ${err.message}`);
  }
}

function debugGitStatus() {
  console.log("\n📊 Git Status Debug Info:");
  console.log("─".repeat(50));

  try {
    const status = exec("git status --short", true);
    console.log("Changes to stage:");
    console.log(status || "(no changes)");

    const config = exec("git config user.name && git config user.email", true);
    console.log("\nGit config:");
    console.log(config || "(not configured)");

    const remote = exec("git remote -v", true);
    console.log("\nRemote:");
    console.log(remote || "(no remote)");
  } catch (err) {
    console.log("Could not retrieve git info");
  }
  console.log("─".repeat(50) + "\n");
}

function getGitDiff() {
  try {
    // Get staged changes first
    let diff = exec("git diff --cached", true);

    // If nothing staged, get all changes
    if (!diff) {
      diff = exec("git diff", true);
    }

    if (!diff) {
      // No uncommitted changes. Don't abort — the caller may still want to
      // push existing commits and open a PR. Signal "nothing to commit" by
      // returning an empty string.
      return "";
    }

    // Condense rather than blindly slicing the first N lines: generated files
    // are dropped and every remaining file is capped, so the model still sees
    // the code that explains the change even in a very large diff.
    const total = diff.split("\n").length;
    const condensed = condenseDiff(diff, {
      maxLines: 5000,
      maxLinesPerFile: 500,
    });
    if (condensed.generated.length) {
      log(
        `Ignoring generated files in analysis: ${condensed.generated.join(", ")}`,
        "info",
      );
    }
    if (condensed.diff.split("\n").length < total) {
      log(`Large diff (${total} lines). Condensed for analysis.`, "warning");
    }

    return condensed.diff;
  } catch (err) {
    error(`Failed to get git diff: ${err.message}`);
  }
}

function getRecentCommits(count = 5) {
  return exec(`git log --oneline -${count}`, true);
}

// Fetch the latest state from a remote so every origin/* tracking ref is
// current. Returns true on success. A failure is non-fatal, but callers must
// treat origin/* refs as potentially stale afterwards.
function fetchRemote(remote = "origin") {
  try {
    run("git", ["fetch", "--prune", remote]);
    return true;
  } catch (err) {
    log(`Could not fetch from ${remote}: ${err.message}`, "warning");
    return false;
  }
}

// Whether a branch exists on the remote as an up-to-date tracking ref.
// Assumes a fetch has already run, so refs/remotes/<remote>/<branch> reflects
// the latest remote state. Uses run() (array args, no shell) so branch names
// can never be interpreted as shell syntax.
function remoteBranchExists(branch, remote = "origin") {
  try {
    run("git", [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/${remote}/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

// Files whose diffs are machine-generated: they are huge, they dominate the
// token budget, and they say nothing about the intent of a change. Dropping
// them is what stops PR titles like "chore: update package-lock.json".
const GENERATED_FILE_PATTERNS = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum|Podfile\.lock)$/i,
  /(^|\/)(dist|build|out|vendor|node_modules|coverage|__snapshots__|\.next|\.nuxt)\//,
  /\.(min\.js|min\.css|map|snap|lock)$/i,
  /(^|\/)\.pnp\.[cm]?js$/,
];

function isGeneratedFile(path) {
  return GENERATED_FILE_PATTERNS.some((re) => re.test(path));
}

// Split a unified diff into one entry per file so it can be filtered and
// budgeted per file rather than as one opaque blob.
function splitDiffByFile(diff) {
  if (!diff) return [];
  return diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      return { path: header ? header[2] : "(unknown)", text: chunk };
    });
}

// Trim a diff down to something an LLM can read while still being
// representative. The old behaviour — slice the first N lines — biased hard
// toward whatever sorts first alphabetically, so a branch with a lockfile or
// an `assets/` folder could spend its entire budget before reaching the code
// that actually explains the change. Instead: drop generated files, cap each
// remaining file, then apply the overall budget.
function condenseDiff(diff, { maxLines = 6000, maxLinesPerFile = 400 } = {}) {
  const empty = { diff: "", generated: [], omitted: [] };
  if (!diff) return empty;

  const files = splitDiffByFile(diff);
  if (!files.length) {
    const lines = diff.split("\n");
    return {
      ...empty,
      diff:
        lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : diff,
    };
  }

  const generated = [];
  const interesting = files.filter((file) => {
    if (!isGeneratedFile(file.path)) return true;
    generated.push(file.path);
    return false;
  });

  // A change that is *only* generated files still needs a title, so fall back
  // to showing them rather than handing the model an empty diff. They are no
  // longer "excluded", so stop reporting them as such.
  const source = interesting.length ? interesting : files;
  if (!interesting.length) generated.length = 0;

  // Per-file caps exist only to share a scarce budget. If everything already
  // fits, hand over the diff whole rather than truncating files for no reason.
  const totalLines = source.reduce(
    (sum, file) => sum + file.text.split("\n").length,
    0,
  );
  if (totalLines <= maxLines) {
    return {
      diff: source.map((file) => file.text).join(""),
      generated,
      omitted: [],
    };
  }

  const omitted = [];
  const chunks = [];
  let budget = maxLines;

  for (const file of source) {
    if (budget <= 0) {
      omitted.push(file.path);
      continue;
    }
    const lines = file.text.split("\n");
    const cap = Math.min(maxLinesPerFile, budget);
    if (lines.length > cap) {
      chunks.push(
        lines.slice(0, cap).join("\n") +
          `\n… (${lines.length - cap} more changed lines in ${file.path})\n`,
      );
      budget -= cap;
    } else {
      chunks.push(file.text);
      budget -= lines.length;
    }
  }

  return { diff: chunks.join(""), generated, omitted };
}

// Diff a local branch against the remote target. The remote target must be
// fresh: main() calls fetchRemote() before this, so origin/<toBranch> reflects
// the latest state on the server rather than a stale local tracking ref.
function getDiffBetweenBranches(fromBranch, toBranch, remote = "origin") {
  const remoteRef = `${remote}/${toBranch}`;

  // Ensure the target actually exists on the remote and is up-to-date before
  // diffing. Without this, a missing/stale ref yields a misleading empty or
  // wrong diff and therefore a poor PR title, with no signal to the user.
  if (!remoteBranchExists(toBranch, remote)) {
    log(
      `Target branch "${toBranch}" not found on ${remote} ` +
        `(after fetch). PR title will fall back to commit message / branch name.`,
      "warning",
    );
    return "";
  }

  try {
    // Three-dot: changes on fromBranch since it diverged from the remote target.
    let diff = run("git", ["diff", `${remoteRef}...${fromBranch}`]);

    if (!diff) {
      // Fallback to a plain two-dot diff.
      diff = run("git", ["diff", remoteRef, fromBranch]);
    }

    return diff;
  } catch (err) {
    log(
      `Could not get diff between ${remoteRef} and ${fromBranch}: ${err.message}`,
      "warning",
    );
    return "";
  }
}

// Subjects of the commits this branch adds on top of the remote target. These
// are the highest-signal input for a PR title: they are the author's own words
// about each step, so the model summarises intent instead of guessing it from
// diff hunks.
function getBranchCommitSubjects(
  fromBranch,
  toBranch,
  remote = "origin",
  max = 30,
) {
  if (!remoteBranchExists(toBranch, remote)) return [];
  try {
    const out = run("git", [
      "log",
      "--no-merges",
      `--max-count=${max}`,
      "--format=%s",
      `${remote}/${toBranch}..${fromBranch}`,
    ]);
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

// `--stat` summary of the branch diff. Always included in the prompt, even
// when the diff body is truncated, so the model can see the shape of the whole
// change (which areas, how many files) rather than only the part that fit.
function getBranchDiffStat(fromBranch, toBranch, remote = "origin") {
  if (!remoteBranchExists(toBranch, remote)) return "";
  try {
    return run("git", [
      "diff",
      "--stat",
      "--stat-width=100",
      `${remote}/${toBranch}...${fromBranch}`,
    ]);
  } catch {
    return "";
  }
}

// Files that are new and unstaged. `git diff` cannot show them, so without
// this a branch whose whole point is a set of new files looks empty to the
// model. Names alone are enough context for a title.
function getUntrackedFiles(max = 40) {
  try {
    const out = run("git", ["ls-files", "--others", "--exclude-standard"]);
    if (!out) return [];
    return out
      .split("\n")
      .filter(Boolean)
      .filter((path) => !isGeneratedFile(path))
      .slice(0, max);
  } catch {
    return [];
  }
}

// Everything the PR title generator needs for one target branch, gathered in
// one place. `pendingDiff` matters because titles are generated *before* the
// commit is created: without it, the title describes only the work that was
// already committed and misses the change the user is running the tool for.
function collectPRContext(
  fromBranch,
  toBranch,
  {
    pendingDiff = "",
    commitMessage = null,
    includeUntracked = false,
    remote = "origin",
  } = {},
) {
  const branchDiff = condenseDiff(
    getDiffBetweenBranches(fromBranch, toBranch, remote),
  );
  const pending = condenseDiff(pendingDiff, {
    maxLines: 2000,
    maxLinesPerFile: 300,
  });

  return {
    fromBranch,
    toBranch,
    commitMessage,
    commits: getBranchCommitSubjects(fromBranch, toBranch, remote),
    stat: getBranchDiffStat(fromBranch, toBranch, remote),
    diff: branchDiff.diff,
    pendingDiff: pending.diff,
    untracked: includeUntracked ? getUntrackedFiles() : [],
    generated: [...new Set([...branchDiff.generated, ...pending.generated])],
  };
}

// ============================================================================
// CLAUDE API
// ============================================================================

function callClaudeAPI(prompt) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify({
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    // Build headers with appropriate authentication
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(requestBody),
    };

    // Add authentication header (OAuth or API key)
    if (CONFIG.oauthToken) {
      headers["Authorization"] = `Bearer ${CONFIG.oauthToken}`;
    } else if (CONFIG.apiKey) {
      headers["x-api-key"] = CONFIG.apiKey;
    }

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: headers,
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const response = JSON.parse(data);

          if (res.statusCode !== 200) {
            reject(new Error(response.error?.message || "API Error"));
            return;
          }

          const content = response.content[0]?.text || "";
          resolve(content);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(requestBody);
    req.end();
  });
}

function callOpenAIAPI(prompt) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify({
      model: CONFIG.openaiModel,
      max_tokens: CONFIG.maxTokens,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.openaiApiKey}`,
      "Content-Length": Buffer.byteLength(requestBody),
    };

    const options = {
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: headers,
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const response = JSON.parse(data);

          if (res.statusCode !== 200) {
            reject(new Error(response.error?.message || "API Error"));
            return;
          }

          const content = response.choices?.[0]?.message?.content || "";
          resolve(content);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(requestBody);
    req.end();
  });
}

function callGeminiAPI(prompt) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: CONFIG.maxTokens,
      },
    });

    const headers = {
      "Content-Type": "application/json",
      // Key goes in a header, not the query string, so it never lands in logs.
      "x-goog-api-key": CONFIG.geminiApiKey,
      "Content-Length": Buffer.byteLength(requestBody),
    };

    const options = {
      hostname: "generativelanguage.googleapis.com",
      // encodeURIComponent so a user-supplied GEMINI_MODEL can't alter the path.
      path: `/v1beta/models/${encodeURIComponent(CONFIG.geminiModel)}:generateContent`,
      method: "POST",
      headers: headers,
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const response = JSON.parse(data);

          if (res.statusCode !== 200) {
            reject(new Error(response.error?.message || "API Error"));
            return;
          }

          // Gemini splits generated text across parts; join them back together.
          const parts = response.candidates?.[0]?.content?.parts || [];
          const content = parts.map((p) => p.text || "").join("");
          resolve(content);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(requestBody);
    req.end();
  });
}

// Dispatch to the configured provider. Anthropic (OAuth token or API key)
// takes priority, then OpenAI, then Gemini.
function callAI(prompt) {
  switch (activeProvider()) {
    case "anthropic":
      return callClaudeAPI(prompt);
    case "openai":
      return callOpenAIAPI(prompt);
    case "gemini":
      return callGeminiAPI(prompt);
    default:
      return Promise.reject(new Error("No API credentials configured"));
  }
}

async function generateCommitMessage(diff, recentCommits) {
  log(`Analyzing changes with ${providerLabel()}...`, "loading");

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
    const message = await callAI(prompt);
    return message.trim();
  } catch (err) {
    error(`Failed to generate commit message: ${err.message}`);
  }
}

const PR_TITLE_MAX_LENGTH = 72;

// Build a human-readable PR title without the AI, used when there is nothing
// to analyze or when the API call fails. Prefers the commit message summary,
// then the branch's own commit subjects, then a humanized branch name.
function buildHumanPRTitle(
  targetBranch,
  commitMessage,
  currentBranch,
  commits = [],
) {
  const fromCommit = commitMessage || commits[0];
  if (fromCommit) {
    // Keep the conventional-commit prefix if there is one — it is meaningful
    // in a PR title too — and only tidy up the description that follows.
    const match = fromCommit.match(/^([a-z]+(?:\([^)]*\))?!?):\s*(.+)$/i);
    if (match && match[2].trim()) {
      return `${match[1].toLowerCase()}: ${match[2].trim()}`.slice(0, 120);
    }
    const summary = fromCommit.trim();
    if (summary) return summary.charAt(0).toUpperCase() + summary.slice(1);
  }

  if (currentBranch) {
    // Turn "feature/login-form" into "Login form".
    const readable = currentBranch
      .replace(/^(feature|feat|fix|bugfix|hotfix|chore|release|docs)\//i, "")
      .replace(/[-_/]+/g, " ")
      .trim();
    if (readable) {
      return readable.charAt(0).toUpperCase() + readable.slice(1);
    }
  }

  return `Merge changes into ${targetBranch}`;
}

// Models routinely wrap the answer in fences, quotes, a "Sure, here's..."
// preamble, or a reasoning block, and the old code passed all of that straight
// into `gh pr create --title`. Reduce whatever came back to a single clean
// title, or return null so the caller can fall back.
function sanitizeTitle(raw, { maxLength = PR_TITLE_MAX_LENGTH } = {}) {
  if (!raw) return null;

  const text = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, "") // reasoning-model scratchpad
    .replace(/```[a-z]*/gi, "")
    .replace(/\r/g, "");

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  // Skip a conversational preamble ("Here's the title:") if a real title
  // follows it; otherwise fall back to the first line we have.
  const isPreamble = (line) =>
    /^(sure|okay|ok|here('s| is)|certainly|based on)\b/i.test(line) ||
    /^(pr\s+)?title\s*:?$/i.test(line);
  let title = lines.find((line) => !isPreamble(line)) || lines[0];

  title = title
    .replace(/^(?:pr\s+)?title\s*[:\-—]\s*/i, "")
    .replace(/^[-*+]\s+/, "") // list bullet
    .replace(/^#+\s*/, "") // markdown heading
    .replace(/^["'`“‘]+|["'`”’]+$/g, "") // wrapping quotes
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "") // trailing period
    .trim();

  // Reject anything that clearly is not a title: refusals, empty output, or a
  // fragment too short to mean anything.
  if (title.length < 5) return null;
  if (!/[a-z]/i.test(title)) return null;
  if (
    /^(i (can|cannot|can't|'m|am)\b|as an ai\b|sorry\b|unable to\b)/i.test(
      title,
    )
  ) {
    return null;
  }

  // Normalize the conventional-commit prefix: "Feat(Auth): ..." → "feat(auth): ..."
  title = title.replace(
    /^([A-Za-z]+)(\(([^)]*)\))?(!?):\s*/,
    (full, type, _paren, scope, bang) => {
      const known =
        /^(feat|fix|refactor|chore|docs|test|style|perf|ci|build|revert)$/i;
      if (!known.test(type)) return full;
      const scopePart = scope ? `(${scope.toLowerCase()})` : "";
      return `${type.toLowerCase()}${scopePart}${bang}: `;
    },
  );

  if (title.length > maxLength) {
    const cut = title.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(" ");
    title = (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut)
      .replace(/[\s,;:\-–—]+$/, "")
      .trim();
  }

  return title || null;
}

// Render one labelled section, or nothing when there is no content for it.
function promptSection(heading, body) {
  return body && String(body).trim() ? `\n## ${heading}\n${body}\n` : "";
}

function buildPRTitlePrompt(context) {
  const {
    fromBranch,
    commitMessage,
    commits = [],
    stat,
    diff,
    pendingDiff,
    untracked = [],
    generated = [],
  } = context;

  return `You are a senior engineer writing the title of a pull request. Read every section below, then output one title.

${promptSection("Source branch", `\`${fromBranch}\``)}${promptSection(
    "Commits already on this branch (newest first)",
    commits.length ? commits.map((s) => `- ${s}`).join("\n") : "",
  )}${promptSection(
    "Commit about to be added",
    commitMessage ? `- ${commitMessage}` : "",
  )}${promptSection("Files changed", stat ? `\`\`\`\n${stat}\n\`\`\`` : "")}${promptSection(
    "New files not yet tracked by git",
    untracked.length ? untracked.map((f) => `- ${f}`).join("\n") : "",
  )}${promptSection(
    "Committed changes",
    diff ? `\`\`\`diff\n${diff}\n\`\`\`` : "",
  )}${promptSection(
    "Uncommitted changes that this PR will also include",
    pendingDiff ? `\`\`\`diff\n${pendingDiff}\n\`\`\`` : "",
  )}${promptSection(
    "Excluded from the diff above (generated files, ignore them)",
    generated.length ? generated.map((f) => `- ${f}`).join("\n") : "",
  )}
## How to choose the title
1. Identify the single most important user- or developer-visible outcome of the whole branch. That is the title. Supporting refactors, test updates, and formatting are not the title.
2. Format: \`type(scope): description\` — types: feat, fix, refactor, chore, docs, test, style, perf, ci, build.
3. Pick the type from that main outcome, not from whichever file changed the most lines. New capability → feat. Corrected behaviour → fix. Same behaviour, better structure → refactor.
4. Scope is the feature area, module, or package touched (e.g. auth, api, cli, checkout), lowercase. Omit the scope entirely if the branch spans several unrelated areas.
5. Description: imperative mood ("add", not "added"/"adds"), specific, and about behaviour or intent — never about file names, line counts, or the fact that files were "updated".
6. Under ${PR_TITLE_MAX_LENGTH} characters total. No trailing period.
7. Banned as vague: "update code", "various changes", "improvements", "misc fixes", "changes to files", "refactor code". If you are tempted by one of these, name the concrete thing that changed instead.
8. If the branch genuinely does two things, name the dominant one; use "and" at most once.
9. Do not mention the target branch, the word "PR", or the branch name itself.

Output only the title, on one line, with no quotes, no code fences, and no explanation.

Good: feat(auth): add SSO login with session refresh
Good: fix(checkout): prevent double-charge on retried payments
Bad: chore: update files
Bad: feat: various improvements and refactoring`;
}

// Identity of a PR-title prompt. Two target branches that produce the same
// context get the same key and therefore share a single AI call.
function contextCacheKey(context) {
  return crypto
    .createHash("sha1")
    .update(
      [
        context.commitMessage || "",
        context.commits.join("\n"),
        context.stat,
        context.diff,
        context.pendingDiff,
        context.untracked.join("\n"),
      ].join("\u0000"),
    )
    .digest("hex");
}

async function generatePRTitle(context, targetBranch, options = {}) {
  const commitMessage = options.commitMessage ?? context.commitMessage;
  const currentBranch = options.currentBranch ?? context.fromBranch;
  const humanFallback = buildHumanPRTitle(
    targetBranch,
    commitMessage,
    currentBranch,
    context.commits,
  );

  // Nothing at all to summarize: no branch commits, no diff, no pending work.
  const hasMaterial =
    Boolean(context.diff) ||
    Boolean(context.pendingDiff) ||
    context.commits.length > 0 ||
    context.untracked.length > 0;

  if (!hasMaterial) {
    log(
      `No changes found between origin/${targetBranch} and ${currentBranch}. ` +
        `Using "${humanFallback}" as the PR title.`,
      "warning",
    );
    return humanFallback;
  }

  log(`Generating PR title for ${targetBranch}...`, "loading");

  try {
    const raw = await callAI(buildPRTitlePrompt(context));
    const title = sanitizeTitle(raw);
    if (!title) {
      log(
        `${providerLabel()} returned an unusable PR title. Falling back to "${humanFallback}".`,
        "warning",
      );
      return humanFallback;
    }
    return title;
  } catch (err) {
    log(`Failed to generate PR title: ${err.message}`, "warning");
    return humanFallback;
  }
}

// ============================================================================
// GIT OPERATIONS
// ============================================================================

function stageChanges() {
  log("Staging changes...", "loading");
  try {
    exec("git add .", true);
    log("Changes staged", "success");
  } catch (err) {
    error(
      `Failed to stage changes: ${err.message}\n\n` +
        "Troubleshooting:\n" +
        "1. Check git status: git status\n" +
        "2. Verify you have changes to stage\n" +
        "3. Check file permissions: ls -la\n" +
        "4. Try: git add . manually first",
    );
  }
}

function createCommit(message) {
  log(`Creating commit: "${message}"`, "loading");
  try {
    run("git", ["commit", "-m", message]);
    log("Commit created", "success");
    return message;
  } catch (err) {
    error(
      `Failed to create commit: ${err.message}\n\n` +
        "Troubleshooting:\n" +
        "1. Verify changes are staged: git status\n" +
        "2. Check git config: git config user.name && git config user.email\n" +
        "3. Try staging manually: git add .\n" +
        '4. Try committing manually: git commit -m "your message"',
    );
  }
}

function pushChanges(branch) {
  log(`Pushing to origin/${branch}...`, "loading");
  try {
    run("git", ["push", "-u", "origin", branch]);
    log(`Pushed to origin/${branch}`, "success");
  } catch (err) {
    error(
      `Failed to push: ${err.message}\n\n` +
        "Troubleshooting:\n" +
        "1. Check network connection\n" +
        "2. Verify remote: git remote -v\n" +
        "3. Check if branch exists remotely\n" +
        "4. Try: git push -u origin " +
        branch,
    );
  }
}

function mergeBranch(from, to) {
  log(`Merging ${from} → ${to}...`, "arrow");

  const currentBranch = getCurrentBranch();

  run("git", ["checkout", to]);
  run("git", ["pull", "--prune"]);
  run("git", ["merge", from, "--no-edit"]);
  run("git", ["push"]);

  log(`Merged to ${to}`, "success");

  // Return to original branch
  run("git", ["checkout", currentBranch]);
}

// Parse "owner/repo" from the origin remote URL (HTTPS or SSH).
// Uses the push URL, which may differ from the fetch URL in fork setups.
function getOriginRepo() {
  try {
    const url = exec("git remote get-url --push origin", true);
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function createPullRequest(from, to, title) {
  // Strip "origin/" remote prefix only — preserve branch namespaces like "mch/feature"
  from = from.replace(/^origin\//, "");
  to = to.replace(/^origin\//, "");

  // Check if gh CLI is available
  const hasGh = exec("which gh", true);
  if (!hasGh) {
    log(
      `To create PR automatically, install gh CLI:\n` +
        `  brew install gh  # macOS\n` +
        `  apt-get install gh  # Linux\n` +
        `Then run: git-smart-commit --with-pr`,
      "warning",
    );
    return;
  }

  const originRepo = getOriginRepo();
  const repoArgs = originRepo ? ["--repo", originRepo] : [];

  // Verify head branch actually exists on the remote
  try {
    const remoteRef = run("git", ["ls-remote", "--heads", "origin", from]);
    if (!remoteRef) {
      log(
        `Branch "${from}" not found on remote origin — skipping PR to ${to}.\n` +
          `   Ensure the branch was pushed: git push origin ${from}`,
        "warning",
      );
      return;
    }
  } catch (e) {
    log(`Could not verify remote branch "${from}": ${e.message}`, "warning");
  }

  // Check for existing open PR between these branches
  try {
    const existing = run("gh", [
      "pr",
      "list",
      "--base",
      to,
      "--head",
      from,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url",
      ...repoArgs,
    ]);
    if (existing) {
      log(`PR already exists for ${from} → ${to}: ${existing}`, "warning");
      return;
    }
  } catch (e) {
    // Ignore — proceed with creation attempt
  }

  log(`Creating PR ${from} → ${to}: "${title}"...`, "loading");

  try {
    const prUrl = run("gh", [
      "pr",
      "create",
      "--base",
      to,
      "--head",
      from,
      "--title",
      title,
      "--body",
      "",
      ...repoArgs,
    ]);
    log(`PR created: ${from} → ${to}`, "success");
    if (prUrl) {
      console.log(`   🔗 ${prUrl}`);
    }
  } catch (e) {
    const errMsg = (e.stderr || e.message || "").toString();
    if (errMsg.includes("already exists")) {
      log(`PR already exists for ${from} → ${to}`, "warning");
    } else if (errMsg.includes("No commits between")) {
      log(`No new commits between ${to} and ${from} — skipping PR`, "warning");
    } else if (errMsg.includes("Head ref must be a branch")) {
      log(
        `GitHub cannot find branch "${from}" in repo ${originRepo || "(unknown)"}.\n` +
          `   If using a fork, the --head flag may need "owner:${from}" format.\n` +
          `   Try manually: gh pr create --base ${to} --head ${from}`,
        "warning",
      );
    } else {
      log(
        `Failed to create PR ${from} → ${to}: ${errMsg.split("\n").pop()}`,
        "warning",
      );
    }
  }
}

// ============================================================================
// PROMPTS & CONFIRMATIONS
// ============================================================================

function getUserConfirmation(message) {
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function showPreview(
  commitMessage,
  currentBranch,
  targetBranches,
  prTitles = {},
  autoStage = true,
  skipConfirm = false,
  createPRs = true,
) {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════╗");
  console.log(
    createPRs
      ? "║         COMMIT & PR PREVIEW                     ║"
      : "║         COMMIT & PUSH PREVIEW                   ║",
  );
  console.log("╚════════════════════════════════════════════════╝");
  console.log("");
  console.log(`📌 Current branch: ${currentBranch}`);
  console.log(
    `${autoStage ? "📦" : "⏭️ "} Stage mode: ${autoStage ? "AUTO (all files)" : "MANUAL (staged only)"}`,
  );
  const noCommitNote = createPRs
    ? "(none — no new changes, push & PR only)"
    : "(none — no new changes, push only)";
  console.log(`💬 Commit message: ${commitMessage || noCommitNote}`);
  if (createPRs) {
    console.log(`📊 Target branches & PR titles:`);
    for (const target of targetBranches) {
      const title = prTitles[target] || "(generating...)";
      console.log(`   → ${target}: ${title}`);
    }
  } else {
    console.log(`🚫 PR creation: SKIPPED (commit & push only)`);
    console.log(`   → Pushing to origin/${currentBranch}`);
  }
  console.log("");

  if (skipConfirm) {
    log("Auto-confirmed (-y flag)", "success");
    return true;
  }

  const proceed = await getUserConfirmation("Proceed? (y/n): ");
  console.log("");

  return proceed;
}

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

const USAGE = `Usage: git smartc [targets] [flags]

  targets              Comma-separated branch list (default: ${CONFIG.defaultTargets.join(
    ",",
  )})

  --no-pr              Commit & push only, skip PR creation
  --push-only, -po, -p Same as --no-pr
  --no-stage, -ns      Skip auto-staging (commit only what's already staged)
  --merge-local        Merge the target locally after the PR (non-protected only)
  -y, --yes            Skip the confirmation prompt
  -h, --help           Show this help

Examples:
  git smartc                     PR to ${CONFIG.defaultTargets.join(" & ")}
  git smartc staging             PR to staging only
  git smartc main,staging        PR to main & staging
  git smartc -ns uat -y          PR to uat only, no auto-stage, no prompt`;

// Every flag the CLI accepts. Anything else dash-prefixed is a typo and is
// reported rather than silently ignored.
const KNOWN_FLAGS = new Set([
  "--no-pr",
  "--push-only",
  "-po",
  "-p",
  "--no-stage",
  "-ns",
  "--merge-local",
  "-y",
  "--yes",
  "-h",
  "--help",
]);

// Split argv into flags and positionals in a single pass. Flags may appear
// anywhere, so the target list is "the first non-flag argument" rather than
// "argv[0]" — the latter silently dropped `uat` in `git smartc -ns uat -y` and
// fell back to the defaults, opening PRs the caller never asked for.
function parseArgs(argv) {
  const flags = [];
  const positionals = [];
  const unknown = [];

  for (const arg of argv) {
    if (arg.startsWith("-")) {
      flags.push(arg);
      if (!KNOWN_FLAGS.has(arg)) unknown.push(arg);
    } else {
      positionals.push(arg);
    }
  }

  if (flags.includes("-h") || flags.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  // Fail loudly on typos: a mistyped flag used to be a no-op, so `--no-stag`
  // would quietly stage everything.
  if (unknown.length > 0) {
    error(
      `Unknown flag${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}\n\n${USAGE}`,
    );
  }

  // Targets are comma-separated, so more than one positional is a mistake
  // (usually a space where a comma belonged) rather than a list.
  if (positionals.length > 1) {
    error(
      `Expected at most one target list, got ${positionals.length}: ${positionals.join(" ")}\n` +
        `   Separate targets with commas, not spaces — did you mean "${positionals.join(",")}"?\n\n${USAGE}`,
    );
  }

  let targetBranches = CONFIG.defaultTargets;
  if (positionals.length === 1) {
    // Trim so `"uat, main"` works, and drop empty segments from stray commas.
    targetBranches = positionals[0]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    if (targetBranches.length === 0) {
      error(`No branch names in target list: "${positionals[0]}"\n\n${USAGE}`);
    }
  }

  const has = (...names) => names.some((name) => flags.includes(name));

  return {
    targetBranches,
    // Commit & push only — no PR. --push-only (and its short forms) are
    // aliases for --no-pr, named for what the run actually does.
    createPRs: !has("--no-pr", "--push-only", "-po", "-p"),
    autoStage: !has("--no-stage", "-ns"),
    // Merge locally after the PR (only meaningful for non-protected targets).
    autoMerge: has("--merge-local"),
    skipConfirm: has("-y", "--yes"),
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    // Parse arguments
    const { targetBranches, createPRs, autoStage, autoMerge, skipConfirm } =
      parseArgs(process.argv.slice(2));

    // Local merging happens in the PR stage, so it can't run in push-only mode.
    if (autoMerge && !createPRs) {
      log("--merge-local has no effect without PR creation", "warning");
    }

    // Welcome
    console.log("");
    log("Git Smart Commit - AI-Powered Workflow", "info");
    console.log("");

    // Prerequisites
    checkPrerequisites();
    console.log("");

    // Get current state
    const currentBranch = getCurrentBranch();
    const diff = getGitDiff();
    const recentCommits = getRecentCommits();
    const hasChanges = !!diff;

    // Generate commit message (only when there are changes to commit)
    let commitMessage = null;
    if (hasChanges) {
      commitMessage = await generateCommitMessage(diff, recentCommits);
    } else {
      log(
        createPRs
          ? "No changes to commit — will push existing commits and create PRs."
          : "No changes to commit — will push existing commits only.",
        "warning",
      );
    }

    // Push-only mode never touches the targets, so skip the fetch and the
    // per-target AI calls entirely instead of generating titles we discard.
    const prTitles = {};
    if (createPRs) {
      // Fetch latest remote state so origin/* refs are up-to-date for diff & PR
      // checks. This is what makes each target branch current with the remote
      // before generatePRTitle compares against origin/<target> below.
      log("Fetching latest remote state...", "loading");
      fetchRemote("origin");

      // Gather the full picture for each target, then generate titles in
      // parallel. Targets that resolve to identical context (common when two
      // release branches are at the same commit) share one AI call instead of
      // paying for the same answer twice.
      const contexts = new Map(
        targetBranches.map((target) => [
          target,
          collectPRContext(currentBranch, target, {
            pendingDiff: diff,
            commitMessage,
            // Untracked files only reach the PR when this run stages them.
            includeUntracked: autoStage && hasChanges,
          }),
        ]),
      );

      const pending = new Map();
      for (const target of targetBranches) {
        const context = contexts.get(target);
        const key = contextCacheKey(context);
        if (!pending.has(key)) {
          pending.set(
            key,
            generatePRTitle(context, target, { commitMessage, currentBranch }),
          );
        }
      }
      for (const target of targetBranches) {
        prTitles[target] = await pending.get(
          contextCacheKey(contexts.get(target)),
        );
      }
    }

    // Show preview
    const confirmed = await showPreview(
      commitMessage,
      currentBranch,
      targetBranches,
      prTitles,
      autoStage,
      skipConfirm,
      createPRs,
    );

    if (!confirmed) {
      log("Aborted", "error");
      process.exit(0);
    }

    // Execute workflow
    console.log("");
    log("Executing workflow...", "loading");
    console.log("");

    if (hasChanges) {
      if (autoStage) {
        stageChanges();
      } else {
        log("Skipping auto-stage (use --no-stage)", "warning");
        debugGitStatus();
      }
      createCommit(commitMessage);
    } else {
      log("No changes to commit — skipping stage & commit.", "info");
    }
    pushChanges(currentBranch);

    // Create PRs
    if (createPRs) {
      console.log("");
      log("Creating pull requests...", "loading");
      console.log("");
      for (const target of targetBranches) {
        // Guard: compare remote-to-remote so we check exactly what GitHub sees.
        // origin/<currentBranch> is updated automatically by git push, so this
        // reflects the real post-push state on the server. Uses run() (no shell)
        // so branch names can't be interpreted as shell syntax.
        try {
          if (!remoteBranchExists(currentBranch)) {
            log(
              `Branch ${currentBranch} not found on origin — skipping PR for ${target}`,
              "warning",
            );
            continue;
          }
          if (!remoteBranchExists(target)) {
            log(
              `Target origin/${target} not found — skipping PR for ${target}`,
              "warning",
            );
            continue;
          }
          const ahead = run("git", [
            "rev-list",
            "--count",
            `origin/${target}..origin/${currentBranch}`,
          ]);
          if (parseInt(ahead, 10) === 0) {
            log(
              `No commits ahead of origin/${target} on origin/${currentBranch} — skipping PR creation`,
              "warning",
            );
            continue;
          }
        } catch (guardErr) {
          log(
            `Cannot verify remote branch origin/${currentBranch}: ${guardErr.message}`,
            "warning",
          );
          log(
            `Skipping PR for ${target} — ensure ${currentBranch} is pushed to origin`,
            "warning",
          );
          continue;
        }

        const prTitle = prTitles[target] || commitMessage;
        createPullRequest(currentBranch, target, prTitle);
      }

      console.log("");
      console.log("╔════════════════════════════════════════════════╗");
      console.log("║              MERGE INSTRUCTIONS                 ║");
      console.log("╚════════════════════════════════════════════════╝");

      // Check for protected branches
      const protectedBranches = ["main", "master", "uat", "staging"];
      const hasProtected = targetBranches.some((b) =>
        protectedBranches.includes(b),
      );
      const nonProtected = targetBranches.filter(
        (b) => !protectedBranches.includes(b),
      );

      if (hasProtected) {
        console.log("\n📢 Protected Branches (main, uat, staging, master):");
        console.log("   ✋ Cannot merge locally - use GitHub/GitLab UI");
        targetBranches
          .filter((b) => protectedBranches.includes(b))
          .forEach((branch) => {
            console.log(`   📍 PR created for → ${branch}`);
          });
      }

      if (nonProtected.length > 0) {
        console.log("\n🔓 Non-Protected Branches:");
        console.log("   ✅ Can merge locally or via UI");
        nonProtected.forEach((branch) => {
          console.log(`   📍 PR created for → ${branch}`);
        });

        if (autoMerge) {
          console.log("\n   Merging locally...");
          for (const branch of nonProtected) {
            mergeBranch(currentBranch, branch);
          }
        }
      }

      console.log("\n💡 Next steps:");
      console.log("   1. Review PR on GitHub/GitLab");
      console.log("   2. Request/wait for approvals");
      console.log("   3. Merge via UI when ready\n");
    } else {
      console.log("");
      log("Skipped PR creation (commit & push only)", "info");
      console.log(
        `   Open a PR later with: git smartc ${CONFIG.defaultTargets.join(",")}`,
      );
    }

    console.log("");
    console.log("╔════════════════════════════════════════════════╗");
    console.log("║            ✨ WORKFLOW COMPLETE ✨              ║");
    console.log("╚════════════════════════════════════════════════╝");
    console.log("");
  } catch (err) {
    console.error("");
    error(`Workflow failed: ${err.message}`);
  }
}

// Run
main();
