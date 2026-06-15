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

# Check API key
echo ""
echo "🔐 Checking API key..."
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "⚠️  ANTHROPIC_API_KEY not set"
    echo ""
    echo "   Set it with:"
    echo "   export ANTHROPIC_API_KEY=sk-ant-..."
    echo ""
    echo "   Or add to ~/.zshrc or ~/.bashrc"
    echo ""
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
echo "   1. Set API key:"
echo "      export ANTHROPIC_API_KEY=sk-ant-..."
echo ""
echo "   2. Try it out:"
echo "      git smartc"
echo ""
echo "📖 Full documentation: README.md"
echo ""
