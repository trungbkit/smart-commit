#!/bin/bash

# git-smart-commit installer
# Usage: bash install.sh

set -e

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║   Git Smart Commit - Installation              ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "   Install from: https://nodejs.org"
    exit 1
fi

echo "✅ Node.js $(node --version) found"
echo ""

# Create directory
INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"

# Copy script
echo "📋 Installing git-smart-commit..."
cp git-smart-commit.js "$INSTALL_DIR/git-smart-commit"
chmod +x "$INSTALL_DIR/git-smart-commit"
echo "✅ Installed to $INSTALL_DIR/git-smart-commit"

# Add to PATH if needed
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo "⚠️  $INSTALL_DIR is not in PATH"
    echo "   Add this to ~/.zshrc or ~/.bashrc:"
    echo ""
    echo "   export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
fi

# Create git alias
echo ""
echo "🔧 Creating git alias..."
git config --global alias.smartc "!git-smart-commit"
echo "✅ Git alias 'git smartc' created"

# Check authentication
echo ""
echo "🔐 Checking authentication..."
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "⚠️  Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set"
    echo ""
    echo "   Option 1 - OAuth Token (subscription-based):"
    echo "   export CLAUDE_CODE_OAUTH_TOKEN=\$(claude setup-token)"
    echo ""
    echo "   Option 2 - API Key (pay-per-token):"
    echo "   export ANTHROPIC_API_KEY=sk-ant-api03-..."
    echo ""
    echo "   Or add to ~/.zshrc or ~/.bashrc"
    echo ""
elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    echo "✅ CLAUDE_CODE_OAUTH_TOKEN is set"
else
    echo "✅ ANTHROPIC_API_KEY is set"
fi

# Check gh CLI
echo ""
echo "📌 Checking GitHub CLI..."
if command -v gh &> /dev/null; then
    echo "✅ GitHub CLI found"
    echo "   Version: $(gh --version)"
else
    echo "⚠️  GitHub CLI not found"
    echo "   Install for PR creation:"
    echo "   brew install gh       # macOS"
    echo "   apt-get install gh    # Linux"
    echo ""
fi

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║         ✨ Installation Complete ✨            ║"
echo "╚════════════════════════════════════════════════╝"
echo ""
echo "🚀 Quick Start:"
echo "   1. Set authentication (choose one):"
echo "      export CLAUDE_CODE_OAUTH_TOKEN=\$(claude setup-token)  # subscription"
echo "      export ANTHROPIC_API_KEY=sk-ant-api03-...             # pay-per-token"
echo ""
echo "   2. Try it out:"
echo "      git smartc"
echo ""
echo "📖 Full documentation: README.md"
echo ""
