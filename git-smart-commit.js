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
 * WORKFLOW
 * The run is a four-step pipeline and every step is optional:
 *
 *   stage  ->  commit  ->  push  ->  pr
 *
 * Each step executes only when it has something to do, decided from the actual
 * repository state rather than from flags. So one command covers the whole
 * spectrum: uncommitted edits get staged, committed, pushed and opened as a PR;
 * a branch that is merely unpushed gets pushed and opened; a branch already on
 * origin just gets its PR. Flags subtract steps, they don't add them.
 *
 * Protected target branches (main, uat, staging, master) must be merged through
 * the GitHub UI; non-protected ones can be merged locally with --merge-local.
 *
 * USAGE:
 *   git-smart-commit                    # stage, commit, push, PR to uat & main
 *   git-smart-commit staging            # same, PR to staging only
 *   git-smart-commit main,staging       # PR to main & staging
 *   git-smart-commit uat -ns            # commit the current index only
 *   git-smart-commit uat -nc            # nothing to commit: push, then PR
 *   git-smart-commit uat --pr-only      # nothing to push: PR only
 *   git-smart-commit --no-pr            # stage, commit & push, skip PR
 *   git-smart-commit develop --merge-local  # merge develop locally after the PR
 *   git-smart-commit main -y            # skip the confirmation prompt
 *   git-smart-commit -ns uat -y         # flags may come before the targets
 *   git-smart-commit --dry-run          # print the plan, change nothing
 *   git-smart-commit --help             # full flag reference
 */

const { execSync, spawnSync } = require("child_process");
const https = require("https");
const http = require("http");
const tls = require("tls");
const crypto = require("crypto");
const fs = require("fs");

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
  // API endpoints. Override when routing through a gateway, mirror, or a
  // corporate egress proxy that terminates TLS on its own hostname.
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
  geminiBaseUrl:
    process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
  requestTimeoutMs:
    Number(process.env.GIT_SMART_COMMIT_TIMEOUT_MS) > 0
      ? Number(process.env.GIT_SMART_COMMIT_TIMEOUT_MS)
      : 30000,
  // Total attempts per request, including the first.
  maxAttempts:
    Number(process.env.GIT_SMART_COMMIT_RETRIES) > 0
      ? Number(process.env.GIT_SMART_COMMIT_RETRIES)
      : 3,
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

// ----------------------------------------------------------------------------
// PIPELINE STATE
//
// These probes answer "what does this repository actually need?" for each step
// of stage -> commit -> push -> pr. resolvePlan() intersects their answers with
// the caller's flags, so a step with nothing to do is skipped rather than run
// and failed. That is what lets the same invocation mean "commit everything and
// open a PR" in a dirty tree and "just open the PR" in a clean one.
// ----------------------------------------------------------------------------

// Run a git command purely for its exit status. The `--quiet` diff forms exit 1
// when a difference exists and 0 when none does; anything higher is a real
// failure and is thrown rather than reported as "no changes".
function gitDiffers(args) {
  const result = spawnSync("git", args, { encoding: "utf-8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      (result.stderr || "").trim() || `git ${args.join(" ")} failed`,
    );
  }
  return result.status === 1;
}

// Tracked files modified but not staged.
function hasUnstagedChanges() {
  return gitDiffers(["diff", "--quiet"]);
}

// Anything sitting in the index, waiting for a commit.
function hasStagedChanges() {
  return gitDiffers(["diff", "--cached", "--quiet"]);
}

// Files git isn't tracking yet. `git add .` picks them up, so they are work the
// stage step can do even when no tracked file was touched. Deliberately not
// getUntrackedFiles(), which filters generated files out for AI context.
function hasUntrackedFiles() {
  try {
    return (
      run("git", ["ls-files", "--others", "--exclude-standard"]).length > 0
    );
  } catch (err) {
    return false;
  }
}

// False in a fresh repository with no commits, where HEAD doesn't resolve.
function hasCommits() {
  try {
    run("git", ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch (err) {
    return false;
  }
}

// Commits the local branch has that origin doesn't. A branch with no remote
// counterpart always needs a push, since the push is what creates it. Assumes
// fetchRemote() has already run, so origin/<branch> reflects the real remote.
function hasUnpushedCommits(branch, remote = "origin") {
  if (!remoteBranchExists(branch, remote)) return true;
  try {
    const ahead = run("git", [
      "rev-list",
      "--count",
      `refs/remotes/${remote}/${branch}..HEAD`,
    ]);
    return parseInt(ahead, 10) > 0;
  } catch (err) {
    // Can't tell — assume a push is needed rather than silently skipping it
    // and then opening a PR against a stale remote branch.
    return true;
  }
}

// Intersect what the caller permits with what the repository needs, once, so
// the preview and the executor can never disagree about what this run will do.
// `reasons` explains every step that won't run, naming the flag responsible so
// `-ns` with an empty index reads as a decision instead of a silent no-op.
function resolvePlan(intent, branch) {
  const unstaged = hasUnstagedChanges();
  const untracked = hasUntrackedFiles();
  const stageable = unstaged || untracked;
  const staged = hasStagedChanges();

  const stage = intent.allowStage && stageable;
  const committable = stage || staged;
  const commit = intent.allowCommit && committable;
  // A commit made by this run is unpushed by definition, so it forces a push
  // without needing to re-read the remote.
  const pushable = commit || hasUnpushedCommits(branch);
  const push = intent.allowPush && pushable;

  // A step is skipped either because a flag turned it off or because there is
  // nothing for it to do. The flag wins in the message: it's the actionable half.
  const reason = (offFlag, needed, idle) =>
    offFlag ? `skipped (${offFlag})` : needed ? null : `skipped (${idle})`;

  return {
    stage,
    commit,
    push,
    pr: intent.allowPR,
    // State the preview surfaces so the user can see work being left behind.
    unstaged,
    untracked,
    staged,
    reasons: {
      stage: reason(intent.stageOff, stageable, "working tree clean"),
      commit: reason(intent.commitOff, committable, "nothing staged"),
      push: reason(intent.pushOff, pushable, "origin already up to date"),
      pr: intent.prOff ? `skipped (${intent.prOff})` : null,
    },
  };
}

// The diff the commit message should describe. `includeUnstaged` tracks the
// stage step: when this run will `git add .` the message must cover the whole
// working tree, and when staging is off it must cover the index and nothing
// else — otherwise the message describes changes the commit won't contain.
function getGitDiff({ includeUnstaged = true } = {}) {
  try {
    // `git diff HEAD` needs a HEAD to compare against; a fresh repo has none,
    // and there everything is necessarily staged or untracked anyway.
    const useWorkingTree = includeUnstaged && hasCommits();
    let diff = exec(
      useWorkingTree ? "git diff HEAD" : "git diff --cached",
      true,
    );

    // New files appear in no diff, but `git add .` commits them, so name them
    // explicitly or the message misses the point of the change entirely.
    if (includeUnstaged) {
      const untracked = getUntrackedFiles();
      if (untracked.length > 0) {
        diff = `${diff}\n${untracked
          .map((file) => `+++ b/${file} (new file)`)
          .join("\n")}`.trim();
      }
    }

    if (!diff) {
      // No readable changes. Don't abort — the caller may still want to push
      // existing commits and open a PR. Signal "nothing to commit" with an
      // empty string.
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
// HTTP TRANSPORT
// ============================================================================

// Network errors worth another attempt: DNS hiccups, dropped or refused
// connections, and unreachable routes while a VPN is still coming up.
const RETRYABLE_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
]);

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Turn a low-level socket failure into something the user can act on. A bare
// "getaddrinfo ENOTFOUND api.anthropic.com" says nothing about the usual
// causes: no connectivity, a VPN that is down, or a proxy-only network.
function describeNetworkError(err, target) {
  const host = target.hostname;
  const hints = [];

  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
    hints.push(`Cannot resolve ${host} (${err.code}).`);
    hints.push("Check your internet connection, VPN, or DNS settings.");
    if (!proxyForHost(host)) {
      hints.push(
        "Behind a corporate proxy? Set HTTPS_PROXY=http://user:pass@proxy:port.",
      );
    }
    hints.push(
      `Using a gateway or mirror? Point ${baseUrlEnvVar(host)} at it.`,
    );
  } else if (err.code === "ETIMEDOUT") {
    hints.push(`Connection to ${host} timed out after ${CONFIG.requestTimeoutMs}ms.`);
    hints.push(
      "Set GIT_SMART_COMMIT_TIMEOUT_MS higher if the network is just slow.",
    );
  } else if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") {
    hints.push(`Connection to ${host} was ${err.code === "ECONNREFUSED" ? "refused" : "reset"}.`);
    hints.push("A firewall, proxy, or TLS inspector may be blocking it.");
  } else {
    return err;
  }

  const wrapped = new Error(hints.join(" "));
  wrapped.code = err.code;
  wrapped.cause = err;
  return wrapped;
}

// Name the base-URL override that applies to the host we failed to reach, so
// the hint points at the right environment variable.
function baseUrlEnvVar(hostname) {
  if (hostname.includes("openai")) return "OPENAI_BASE_URL";
  if (hostname.includes("googleapis")) return "GEMINI_BASE_URL";
  return "ANTHROPIC_BASE_URL";
}

// Resolve the proxy to use for a host, honouring NO_PROXY exclusions.
// Returns a URL or null.
function proxyForHost(hostname) {
  const host = hostname.toLowerCase();
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  const exclusions = noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (exclusions.includes("*")) return null;
  for (const entry of exclusions) {
    const bare = entry.replace(/^\./, "").replace(/:\d+$/, "");
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }

  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (!raw) return null;

  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    log(`Ignoring unparseable proxy setting: ${raw}`, "warning");
    return null;
  }
}

function proxyAuthHeader(proxy) {
  if (!proxy.username) return null;
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

// Open a raw TCP tunnel to host:port through an HTTP proxy via CONNECT.
function openProxyTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const auth = proxyAuthHeader(proxy);
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: auth ? { "Proxy-Authorization": auth } : {},
      timeout: CONFIG.requestTimeoutMs,
    });

    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(
          new Error(
            `Proxy ${proxy.host} refused CONNECT to ${host}:${port} (HTTP ${res.statusCode})`,
          ),
        );
        return;
      }
      resolve(socket);
    });

    req.on("timeout", () => {
      const err = new Error(`Proxy ${proxy.host} did not respond in time`);
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });
    req.on("error", reject);
    req.end();
  });
}

// An agent that reaches the target through the configured proxy: CONNECT
// tunnel plus a TLS handshake for https targets.
function tunnelingAgent(proxy, isHttps) {
  const agent = isHttps
    ? new https.Agent({ keepAlive: false })
    : new http.Agent({ keepAlive: false });

  agent.createConnection = (options, callback) => {
    openProxyTunnel(proxy, options.host, options.port)
      .then((socket) => {
        if (!isHttps) {
          callback(null, socket);
          return;
        }
        const servername = options.servername || options.host;
        const tlsSocket = tls.connect({ socket, servername }, () =>
          callback(null, tlsSocket),
        );
        tlsSocket.on("error", callback);
      })
      .catch(callback);
  };

  return agent;
}

// Single POST attempt. Resolves the parsed JSON body on 2xx; rejects with an
// Error carrying `.statusCode` on an API error and `.code` on a socket error.
function postJSONOnce(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol !== "http:";
    const port = target.port ? Number(target.port) : isHttps ? 443 : 80;
    const proxy = proxyForHost(target.hostname);
    const transport = isHttps ? https : http;

    const req = transport.request(
      {
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers,
        timeout: CONFIG.requestTimeoutMs,
        agent: proxy ? tunnelingAgent(proxy, isHttps) : undefined,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            // Fall through: a non-JSON body means a proxy or gateway answered.
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (!parsed) {
              reject(
                new Error(
                  `Unexpected non-JSON response from ${target.hostname}`,
                ),
              );
              return;
            }
            resolve(parsed);
            return;
          }

          const err = new Error(
            parsed?.error?.message ||
              parsed?.message ||
              `API Error (HTTP ${res.statusCode})`,
          );
          err.statusCode = res.statusCode;
          err.retryAfter = Number(res.headers["retry-after"]) || 0;
          reject(err);
        });
      },
    );

    req.on("timeout", () => {
      const err = new Error(`Request to ${target.hostname} timed out`);
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });
    req.on("error", (err) => reject(describeNetworkError(err, target)));
    req.write(body);
    req.end();
  });
}

function isRetryable(err) {
  if (err.code && RETRYABLE_NETWORK_CODES.has(err.code)) return true;
  const status = err.statusCode;
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

// POST with retries on transient failures, so a momentary DNS or connection
// blip does not abort the commit.
async function postJSON(url, headers, body) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt++) {
    try {
      return await postJSONOnce(url, headers, body);
    } catch (err) {
      lastError = err;
      if (attempt === CONFIG.maxAttempts || !isRetryable(err)) break;

      const backoffMs = err.retryAfter
        ? err.retryAfter * 1000
        : 500 * 2 ** (attempt - 1);
      log(
        `${providerLabel()} request failed (${err.code || `HTTP ${err.statusCode}`}), retrying in ${Math.round(backoffMs / 100) / 10}s...`,
        "warning",
      );
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

// ============================================================================
// PROVIDER APIS
// ============================================================================

async function callClaudeAPI(prompt, { maxTokens = CONFIG.maxTokens } = {}) {
  const body = JSON.stringify({
    model: CONFIG.model,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "Content-Length": Buffer.byteLength(body),
  };

  // Add authentication header (OAuth or API key)
  if (CONFIG.oauthToken) {
    headers["Authorization"] = `Bearer ${CONFIG.oauthToken}`;
  } else if (CONFIG.apiKey) {
    headers["x-api-key"] = CONFIG.apiKey;
  }

  const response = await postJSON(
    joinUrl(CONFIG.anthropicBaseUrl, "/v1/messages"),
    headers,
    body,
  );
  return response.content?.[0]?.text || "";
}

async function callOpenAIAPI(prompt, { maxTokens = CONFIG.maxTokens } = {}) {
  const body = JSON.stringify({
    model: CONFIG.openaiModel,
    max_tokens: maxTokens,
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
    "Content-Length": Buffer.byteLength(body),
  };

  const response = await postJSON(
    joinUrl(CONFIG.openaiBaseUrl, "/v1/chat/completions"),
    headers,
    body,
  );
  return response.choices?.[0]?.message?.content || "";
}

async function callGeminiAPI(prompt, { maxTokens = CONFIG.maxTokens } = {}) {
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: maxTokens,
    },
  });

  const headers = {
    "Content-Type": "application/json",
    // Key goes in a header, not the query string, so it never lands in logs.
    "x-goog-api-key": CONFIG.geminiApiKey,
    "Content-Length": Buffer.byteLength(body),
  };

  const response = await postJSON(
    // encodeURIComponent so a user-supplied GEMINI_MODEL can't alter the path.
    joinUrl(
      CONFIG.geminiBaseUrl,
      `/v1beta/models/${encodeURIComponent(CONFIG.geminiModel)}:generateContent`,
    ),
    headers,
    body,
  );

  // Gemini splits generated text across parts; join them back together.
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

// Dispatch to the configured provider. Anthropic (OAuth token or API key)
// takes priority, then OpenAI, then Gemini.
function callAI(prompt, options = {}) {
  switch (activeProvider()) {
    case "anthropic":
      return callClaudeAPI(prompt, options);
    case "openai":
      return callOpenAIAPI(prompt, options);
    case "gemini":
      return callGeminiAPI(prompt, options);
    default:
      return Promise.reject(new Error("No API credentials configured"));
  }
}

async function generateCommitMessage(diff, recentCommits) {
  log(`Analyzing changes with ${providerLabel()}...`, "loading");

  const prompt = `You are a professional git commit message generator. Analyze the following code changes and generate a meaningful commit message with a title and a description.

## Recent commits for context:
\`\`\`
${recentCommits}
\`\`\`

## Code changes to analyze:
\`\`\`diff
${diff}
\`\`\`

## Requirements:
1. The first line is the title, in conventional commits format: type(scope): description
2. Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build
3. Keep the title under 50 characters, with no trailing period
4. After the title, leave one blank line, then write the description
5. The description is 1-5 bullet points starting with "- ", each explaining what changed and why — behaviour and intent, not file names or line counts
6. Wrap description lines at ${COMMIT_BODY_WRAP} characters
7. Use imperative mood (e.g., "add" not "added") in both title and description
8. Return ONLY the commit message, with no labels like "Title:", no quotes, and no code fences

Example:
feat(auth): add login validation

- Reject empty and malformed emails before hitting the API
- Show inline field errors instead of a generic toast
`;

  try {
    const raw = await callAI(prompt);
    const message = parseCommitMessage(raw);
    if (!message) {
      error(`${providerLabel()} returned an unusable commit message:\n${raw}`);
    }
    return message;
  } catch (err) {
    error(`Failed to generate commit message: ${err.message}`);
  }
}

const COMMIT_TITLE_MAX_LENGTH = 72;
const COMMIT_BODY_WRAP = 72;

// Reduce the model's reply to "title\n\ndescription" (or just the title when no
// description came back), tolerating the same fences, preambles and labels
// sanitizeTitle() handles. Returns null when no usable title is found.
function parseCommitMessage(raw) {
  if (!raw) return null;

  const lines = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```[a-z]*/gi, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd());

  const start = lines.findIndex(
    (line) => line.trim() && !isPreambleLine(line.trim()),
  );
  if (start === -1) return null;

  const title = sanitizeTitle(lines[start], {
    maxLength: COMMIT_TITLE_MAX_LENGTH,
  });
  if (!title) return null;

  const body = lines
    .slice(start + 1)
    .join("\n")
    .replace(/^\s*(description|body)\s*:\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return body ? `${title}\n\n${body}` : title;
}

// The title line of a commit message, for places that only have room for one.
function commitTitle(message) {
  return message ? message.split("\n")[0] : message;
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
  const fromCommit = commitTitle(commitMessage) || commits[0];
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

// A conversational lead-in ("Here's the title:") or a bare label line, rather
// than the answer itself.
function isPreambleLine(line) {
  return (
    /^(sure|okay|ok|here('s| is)|certainly|based on)\b/i.test(line) ||
    /^((pr|commit)\s+)?(title|message)\s*:?$/i.test(line)
  );
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
  let title = lines.find((line) => !isPreambleLine(line)) || lines[0];

  title = title
    .replace(/^(?:(?:pr|commit)\s+)?(?:title|message)\s*[:\-—]\s*/i, "")
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

// The branch material shared by the PR title and description prompts, so both
// describe exactly the same change.
function prContextSections(context) {
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

  return `${promptSection("Source branch", `\`${fromBranch}\``)}${promptSection(
    "Commits already on this branch (newest first)",
    commits.length ? commits.map((s) => `- ${s}`).join("\n") : "",
  )}${promptSection(
    "Commit about to be added",
    commitMessage ? `\`\`\`\n${commitMessage}\n\`\`\`` : "",
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
  )}`;
}

function buildPRTitlePrompt(context) {
  return `You are a senior engineer writing the title of a pull request. Read every section below, then output one title.

${prContextSections(context)}
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

  if (!hasPRMaterial(context)) {
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

// False when there is nothing at all to summarize: no branch commits, no
// diff, no pending work.
function hasPRMaterial(context) {
  return (
    Boolean(context.diff) ||
    Boolean(context.pendingDiff) ||
    context.commits.length > 0 ||
    context.untracked.length > 0
  );
}

// Descriptions run to several sections, well past the budget a title needs.
const PR_DESCRIPTION_MAX_TOKENS = 1500;
const PR_TEMPLATE_MAX_CHARS = 4000;

// The repository's own pull request template, in the places GitHub looks for
// one: the repo root, .github/ and docs/, any filename case. `gh pr create
// --body` bypasses the template, so the description generator fills it in
// instead. A PULL_REQUEST_TEMPLATE/ directory of several templates is ignored:
// GitHub makes the author pick one, and there is no right default here.
function findPRTemplate() {
  let root;
  try {
    root = run("git", ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
  for (const dir of ["", ".github", "docs"]) {
    const base = dir ? `${root}/${dir}` : root;
    let entries;
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    const name = entries.find((entry) =>
      /^pull_request_template\.(md|txt)$/i.test(entry),
    );
    if (!name) continue;
    try {
      const content = fs.readFileSync(`${base}/${name}`, "utf8").trim();
      if (content) {
        return {
          path: dir ? `${dir}/${name}` : name,
          content: content.slice(0, PR_TEMPLATE_MAX_CHARS),
        };
      }
    } catch {
      // Unreadable template: fall through to the standard layout.
    }
  }
  return null;
}

const STANDARD_PR_LAYOUT = `## Summary
1-3 sentences: what this PR does and why it is needed.

## Changes
- The notable changes as bullets, most important first, grouped by area when there are several.

## How to test
- Concrete steps or commands a reviewer can run to verify the change. If the diff adds or updates tests, name them.

## Notes
- Breaking changes, migrations, new environment variables or config, deployment steps, known limitations, or follow-ups. Omit this whole section when there are none.`;

function buildPRDescriptionPrompt(context, template = null) {
  const layout = template
    ? `This repository has a pull request template. Fill it in: keep its headings, their order, and any checklists. Replace placeholder text and HTML comments with real content, tick a checklist box only when the material above shows it is done, and write "N/A" under a heading that does not apply.

\`\`\`\`markdown
${template.content}
\`\`\`\``
    : `Use exactly these sections:

${STANDARD_PR_LAYOUT}`;

  return `You are a senior engineer writing the description of a pull request for its reviewers. Read every section below, then write the description.

${prContextSections(context)}
## Layout
${layout}

## Rules
1. GitHub-flavoured Markdown.
2. Describe behaviour and intent — what changed and why — not file names or line counts, unless a file is itself the point (a new config file, a migration).
3. Base every statement on the material above. Never invent ticket or issue numbers, links, screenshots, benchmarks, or test results. You do not know how the author tested this, so give reviewers steps to verify it rather than claiming it was tested.
4. Be concise: a reviewer should grasp the PR in under a minute. Leave filler out rather than padding a section.
5. Do not repeat the PR title as a heading, and do not mention the target branch.

Output only the description, with no preamble and no code fence around it.`;
}

// Reduce the model's reply to the Markdown description itself, or null when
// nothing usable came back.
function sanitizePRDescription(raw) {
  if (!raw) return null;

  const lines = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\r/g, "")
    .split("\n");
  while (
    lines.length &&
    (!lines[0].trim() ||
      isPreambleLine(lines[0].trim()) ||
      /^(pr\s+)?description\s*:?$/i.test(lines[0].trim()))
  ) {
    lines.shift();
  }
  let text = lines.join("\n").trim();

  // Unwrap a fence around the whole reply, keeping any fences inside it.
  const fenced = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1];
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  if (text.length < 20) return null;
  if (
    /^(i (can|cannot|can't|'m|am)\b|as an ai\b|sorry\b|unable to\b)/i.test(text)
  ) {
    return null;
  }
  return text;
}

// A description built without the AI, from the commit subjects alone. It never
// names the target branch, because targets with identical context share one.
function buildHumanPRDescription(context) {
  const items = [
    ...new Set(
      [commitTitle(context.commitMessage), ...context.commits].filter(Boolean),
    ),
  ];
  const summary = items[0] || `Changes from \`${context.fromBranch}\`.`;
  const changes = items.length > 1 ? items.map((s) => `- ${s}`).join("\n") : "";
  return changes
    ? `## Summary\n\n${summary}\n\n## Changes\n\n${changes}`
    : `## Summary\n\n${summary}`;
}

async function generatePRDescription(context, targetBranch, template = null) {
  const humanFallback = buildHumanPRDescription(context);
  // generatePRTitle() has already warned about an empty branch.
  if (!hasPRMaterial(context)) return humanFallback;

  log(`Generating PR description for ${targetBranch}...`, "loading");

  try {
    const raw = await callAI(buildPRDescriptionPrompt(context, template), {
      maxTokens: PR_DESCRIPTION_MAX_TOKENS,
    });
    const description = sanitizePRDescription(raw);
    if (!description) {
      log(
        `${providerLabel()} returned an unusable PR description. Falling back to the commit list.`,
        "warning",
      );
      return humanFallback;
    }
    return description;
  } catch (err) {
    log(`Failed to generate PR description: ${err.message}`, "warning");
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
  log(`Creating commit: "${commitTitle(message)}"`, "loading");
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

// Returns what actually happened, so the caller can report on real outcomes
// instead of assuming every target in the list ended up with a PR:
//   { status: "created" | "exists" | "skipped", url? }
function createPullRequest(from, to, title, body = "") {
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
        `Then run: git smartc ${to} --pr-only`,
      "warning",
    );
    return { status: "skipped" };
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
      return { status: "skipped" };
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
      return { status: "exists", url: existing };
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
      body,
      ...repoArgs,
    ]);
    log(`PR created: ${from} → ${to}`, "success");
    if (prUrl) {
      console.log(`   🔗 ${prUrl}`);
    }
    return { status: "created", url: prUrl };
  } catch (e) {
    const errMsg = (e.stderr || e.message || "").toString();
    if (errMsg.includes("already exists")) {
      log(`PR already exists for ${from} → ${to}`, "warning");
      return { status: "exists" };
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
      // gh often ends its stderr with a blank line, so take the last line
      // that actually says something rather than a trailing empty one.
      const detail =
        errMsg
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .pop() || "unknown error";
      log(`Failed to create PR ${from} → ${to}: ${detail}`, "warning");
    }
    return { status: "skipped" };
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

// The plan, rendered as the pipeline itself: one line per step, in execution
// order, each either describing what it will do or naming why it won't. Reading
// it top to bottom tells the user exactly what this run is about to be.
async function showPreview({
  plan,
  commitMessage,
  currentBranch,
  targetBranches,
  prTitles = {},
  prDescriptions = {},
  skipConfirm = false,
  dryRun = false,
}) {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════╗");
  console.log("║                 WORKFLOW PLAN                   ║");
  console.log("╚════════════════════════════════════════════════╝");
  console.log("");
  console.log(`📌 Current branch: ${currentBranch}`);
  console.log("");

  const step = (name, active, detail) =>
    console.log(
      `   ${active ? "✅" : "⏭️ "} ${name.padEnd(7)} ${detail || ""}`.trimEnd(),
    );

  const stageDetail = [
    plan.unstaged && "modified files",
    plan.untracked && "new files",
  ]
    .filter(Boolean)
    .join(" + ");

  step(
    "stage",
    plan.stage,
    plan.stage ? `git add . (${stageDetail})` : plan.reasons.stage,
  );
  step(
    "commit",
    plan.commit,
    plan.commit ? `"${commitTitle(commitMessage)}"` : plan.reasons.commit,
  );
  if (plan.commit) {
    // The description, indented under the title so the checklist stays readable.
    const description = commitMessage.split("\n").slice(1).join("\n").trim();
    for (const line of description ? description.split("\n") : []) {
      console.log(`           ${line}`.trimEnd());
    }
  }
  step(
    "push",
    plan.push,
    plan.push ? `origin/${currentBranch}` : plan.reasons.push,
  );
  step("pr", plan.pr, plan.pr ? "" : plan.reasons.pr);

  if (plan.pr) {
    // Targets that share a context share a description; print it once.
    const shown = new Map();
    for (const target of targetBranches) {
      console.log(
        `        → ${target}: ${prTitles[target] || "(generating...)"}`,
      );
      const description = prDescriptions[target];
      if (!description) continue;
      if (shown.has(description)) {
        console.log(`          (same description as ${shown.get(description)})`);
        continue;
      }
      shown.set(description, target);
      for (const line of description.split("\n")) {
        console.log(`          ${line}`.trimEnd());
      }
    }
  }

  // Call out the consequences that are easy to misread from the checklist
  // alone — chiefly work the run is deliberately leaving behind.
  const caveats = [
    plan.commit &&
      !plan.push &&
      "The new commit stays local — nothing will be pushed to origin.",
    plan.pr &&
      !plan.push &&
      `PRs will describe what origin/${currentBranch} already has, not local work.`,
    plan.staged &&
      !plan.commit &&
      "Staged changes are being left in the index, uncommitted.",
    (plan.unstaged || plan.untracked) &&
      !plan.stage &&
      "Working-tree changes are being left behind.",
  ].filter(Boolean);

  if (caveats.length > 0) {
    console.log("");
    for (const caveat of caveats) log(caveat, "warning");
  }
  console.log("");

  if (dryRun || skipConfirm) {
    if (skipConfirm && !dryRun) log("Auto-confirmed (-y flag)", "success");
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

The run is a pipeline — stage → commit → push → pr — and each step executes
only when it has something to do. There is no flag for "nothing to commit" or
"nothing to push": those are read from the repository. Flags subtract steps.

  Skip steps:
  --no-stage,  -ns     Don't git add; commit only what's already staged
  --no-commit, -nc     Don't commit at all (implies --no-stage)
  --no-push,   -np     Don't push
  --no-pr              Don't create PRs
  --pr-only            PR only — shorthand for --no-commit --no-push
  --push-only, -po, -p Alias for --no-pr

  Other:
  --merge-local        Merge the target locally after the PR (non-protected only)
  --dry-run            Print the plan and exit without changing anything
  -y, --yes            Skip the confirmation prompt
  -h, --help           Show this help

Examples:
  git smartc                     Stage, commit, push, PR to ${CONFIG.defaultTargets.join(
    " & ",
  )}
  git smartc staging             Same, but PR to staging only
  git smartc main,staging        PR to main & staging
  git smartc uat -ns             Commit the current index only, push, PR
  git smartc uat -nc             Leave the working tree alone: push, then PR
  git smartc uat --pr-only       PR from what origin already has
  git smartc --no-pr             Stage, commit & push, no PR
  git smartc -ns uat -y          Flags may come before the targets`;

// Every flag the CLI accepts. Anything else dash-prefixed is a typo and is
// reported rather than silently ignored.
const KNOWN_FLAGS = new Set([
  "--no-stage",
  "-ns",
  "--no-commit",
  "-nc",
  "--no-push",
  "-np",
  "--no-pr",
  "--pr-only",
  "--push-only",
  "-po",
  "-p",
  "--merge-local",
  "--dry-run",
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
  // The specific flag that switched a step off, or null. Kept (rather than a
  // bare boolean) so every "skipped" line can name the flag responsible.
  const offBy = (...names) =>
    names.find((name) => flags.includes(name)) || null;

  // Permission per pipeline step. This is intent only: whether a step actually
  // runs is resolvePlan()'s call, since a permitted step with nothing to do is
  // still skipped. --no-commit implies --no-stage (staging without committing
  // would just leave a dirty index behind), and --pr-only implies both plus
  // --no-push. --push-only and its short forms remain aliases for --no-pr.
  const intent = {
    stageOff: offBy("--no-stage", "-ns", "--no-commit", "-nc", "--pr-only"),
    commitOff: offBy("--no-commit", "-nc", "--pr-only"),
    pushOff: offBy("--no-push", "-np", "--pr-only"),
    prOff: offBy("--no-pr", "--push-only", "-po", "-p"),
  };
  intent.allowStage = !intent.stageOff;
  intent.allowCommit = !intent.commitOff;
  intent.allowPush = !intent.pushOff;
  intent.allowPR = !intent.prOff;

  // Every step switched off leaves no pipeline to run at all. Catch it here
  // rather than after the prerequisite checks and the remote fetch.
  if (!intent.allowCommit && !intent.allowPush && !intent.allowPR) {
    // Deduped because one flag can switch off several steps: --pr-only alone
    // covers both commit and push.
    const culprits = [
      ...new Set([intent.commitOff, intent.pushOff, intent.prOff]),
    ];
    error(
      `${culprits.join(" + ")} leave${culprits.length > 1 ? "" : "s"} nothing to do — commit, push and PR are all switched off.\n\n${USAGE}`,
    );
  }

  return {
    targetBranches,
    intent,
    // Merge locally after the PR (only meaningful for non-protected targets).
    autoMerge: has("--merge-local"),
    skipConfirm: has("-y", "--yes"),
    dryRun: has("--dry-run"),
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    // Parse arguments
    const { targetBranches, intent, autoMerge, skipConfirm, dryRun } =
      parseArgs(process.argv.slice(2));

    // Local merging happens in the PR stage, so it can't run without one.
    if (autoMerge && !intent.allowPR) {
      log(`--merge-local has no effect with ${intent.prOff}`, "warning");
    }

    // Welcome
    console.log("");
    log("Git Smart Commit - AI-Powered Workflow", "info");
    console.log("");

    // Prerequisites
    checkPrerequisites();
    console.log("");

    const currentBranch = getCurrentBranch();

    // origin/* must be current before the plan can judge whether a push is
    // needed or whether a PR would have any commits behind it, so the fetch
    // comes before the decision. Skipped when neither step is permitted.
    if (intent.allowPush || intent.allowPR) {
      log("Fetching latest remote state...", "loading");
      fetchRemote("origin");
    }

    // Decide the whole run up front: which steps the flags allow, intersected
    // with which steps the repository actually needs.
    const plan = resolvePlan(intent, currentBranch);

    if (!plan.stage && !plan.commit && !plan.push && !plan.pr) {
      console.log("");
      log("Nothing to do — every step is either off or already done.", "info");
      for (const [name, why] of Object.entries(plan.reasons)) {
        if (why) console.log(`   ${name.padEnd(7)} ${why}`);
      }
      console.log("");
      process.exit(0);
    }

    // Generate a commit message only when a commit is going to happen, and
    // from exactly what will land in it: the whole working tree when this run
    // stages, the index alone when it doesn't.
    let commitMessage = null;
    // Kept in the outer scope because the PR title generator needs it too: the
    // titles are produced before the commit exists, so without the pending diff
    // they would describe only work that was already committed.
    let pendingDiff = "";
    if (plan.commit) {
      const diff = getGitDiff({ includeUnstaged: plan.stage });
      if (diff) {
        pendingDiff = diff;
        commitMessage = await generateCommitMessage(diff, getRecentCommits());
      } else {
        // Nothing readable to describe, so there is nothing to commit
        // either. This shouldn't happen — the plan only reaches here with
        // staged or stageable content — so dump the status to explain it.
        log(
          "No readable diff for the pending changes — skipping commit.",
          "warning",
        );
        debugGitStatus();
        plan.stage = false;
        plan.commit = false;
        plan.reasons.stage = plan.reasons.stage || "skipped (no readable diff)";
        plan.reasons.commit =
          plan.reasons.commit || "skipped (no readable diff)";
      }
    }

    // Titles and descriptions cost one AI call each per distinct target
    // context, so only generate them when PRs are actually part of the plan.
    const prTitles = {};
    const prDescriptions = {};
    if (plan.pr) {
      const template = findPRTemplate();
      if (template) log(`Using PR template ${template.path}`, "info");

      // Gather the full picture for each target, then generate titles and
      // descriptions in parallel. Targets that resolve to identical context (common when two
      // release branches are at the same commit) share one AI call instead of
      // paying for the same answer twice.
      const contexts = new Map(
        targetBranches.map((target) => [
          target,
          collectPRContext(currentBranch, target, {
            // Only work this run will actually push counts as "pending"; with
            // --no-push the PR can describe nothing but what origin has.
            pendingDiff: plan.push ? pendingDiff : "",
            commitMessage: plan.push ? commitMessage : null,
            // Untracked files only reach the PR when this run stages them.
            includeUntracked: plan.stage && plan.push,
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
            Promise.all([
              generatePRTitle(context, target, {
                commitMessage: plan.push ? commitMessage : null,
                currentBranch,
              }),
              generatePRDescription(context, target, template),
            ]),
          );
        }
      }
      for (const target of targetBranches) {
        [prTitles[target], prDescriptions[target]] = await pending.get(
          contextCacheKey(contexts.get(target)),
        );
      }
    }

    // Show preview
    const confirmed = await showPreview({
      plan,
      commitMessage,
      currentBranch,
      targetBranches,
      prTitles,
      prDescriptions,
      skipConfirm,
      dryRun,
    });

    if (dryRun) {
      log("Dry run — nothing was changed.", "info");
      console.log("");
      process.exit(0);
    }

    if (!confirmed) {
      log("Aborted", "error");
      process.exit(0);
    }

    // Execute workflow. Every step is already decided, so this is a straight
    // run through the pipeline — no step can fail for having nothing to do.
    console.log("");
    log("Executing workflow...", "loading");
    console.log("");

    if (plan.stage) stageChanges();
    if (plan.commit) createCommit(commitMessage);
    if (plan.push) pushChanges(currentBranch);

    // Create PRs
    if (plan.pr) {
      console.log("");
      log("Creating pull requests...", "loading");
      console.log("");
      // What each target actually ended up with. The merge instructions below
      // are built from this rather than from targetBranches, so a target whose
      // PR was guarded away is never reported as one that got a PR.
      const prOutcome = new Map();
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
            prOutcome.set(target, "skipped");
            continue;
          }
          if (!remoteBranchExists(target)) {
            log(
              `Target origin/${target} not found — skipping PR for ${target}`,
              "warning",
            );
            prOutcome.set(target, "skipped");
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
            prOutcome.set(target, "skipped");
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
          prOutcome.set(target, "skipped");
          continue;
        }

        const prTitle =
          prTitles[target] ||
          commitTitle(commitMessage) ||
          `${currentBranch} → ${target}`;
        const result = createPullRequest(
          currentBranch,
          target,
          prTitle,
          prDescriptions[target],
        );
        prOutcome.set(target, result ? result.status : "skipped");
      }

      console.log("");
      console.log("╔════════════════════════════════════════════════╗");
      console.log("║              MERGE INSTRUCTIONS                 ║");
      console.log("╚════════════════════════════════════════════════╝");

      // Check for protected branches
      const protectedBranches = ["main", "master", "uat", "staging"];
      // Only targets that have an open PR — freshly created or already there —
      // get merge instructions. A skipped target gets its own line instead.
      const withPR = targetBranches.filter((b) =>
        ["created", "exists"].includes(prOutcome.get(b)),
      );
      const skipped = targetBranches.filter(
        (b) => !["created", "exists"].includes(prOutcome.get(b)),
      );
      const label = (b) =>
        prOutcome.get(b) === "created"
          ? `PR created for → ${b}`
          : `PR already open for → ${b}`;

      const protectedWithPR = withPR.filter((b) =>
        protectedBranches.includes(b),
      );
      const nonProtectedWithPR = withPR.filter(
        (b) => !protectedBranches.includes(b),
      );

      if (protectedWithPR.length > 0) {
        console.log("\n📢 Protected Branches (main, uat, staging, master):");
        console.log("   ✋ Cannot merge locally - use GitHub/GitLab UI");
        protectedWithPR.forEach((branch) => {
          console.log(`   📍 ${label(branch)}`);
        });
      }

      if (nonProtectedWithPR.length > 0) {
        console.log("\n🔓 Non-Protected Branches:");
        console.log("   ✅ Can merge locally or via UI");
        nonProtectedWithPR.forEach((branch) => {
          console.log(`   📍 ${label(branch)}`);
        });

        if (autoMerge) {
          console.log("\n   Merging locally...");
          for (const branch of nonProtectedWithPR) {
            mergeBranch(currentBranch, branch);
          }
        }
      }

      if (skipped.length > 0) {
        console.log("\n⏭️  No PR for: " + skipped.join(", "));
        console.log("   See the warnings above for why.");
      }

      if (withPR.length > 0) {
        console.log("\n💡 Next steps:");
        console.log("   1. Review PR on GitHub/GitLab");
        console.log("   2. Request/wait for approvals");
        console.log("   3. Merge via UI when ready\n");
      } else {
        console.log("");
      }
    } else {
      console.log("");
      log(`Skipped PR creation (${intent.prOff})`, "info");
      console.log(
        `   Open a PR later with: git smartc ${CONFIG.defaultTargets.join(
          ",",
        )} --pr-only`,
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
