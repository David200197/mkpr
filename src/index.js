#!/usr/bin/env node

const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const Conf = require('conf');
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================
// FETCH COMPATIBILITY (Node 18+ native or node-fetch@2)
// ============================================

let fetch;
if (globalThis.fetch) {
    fetch = globalThis.fetch;
} else {
    try {
        fetch = require('node-fetch');
    } catch {
        console.error(chalk.red('❌ fetch not available. Use Node 18+ or install node-fetch@2'));
        process.exit(1);
    }
}

// ============================================
// CONSTANTS (Single source of truth)
// ============================================

const DEFAULT_EXCLUDES = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'composer.lock',
    'Gemfile.lock',
    'poetry.lock',
    'Cargo.lock',
    'pubspec.lock',
    'packages.lock.json',
    'gradle.lockfile',
    'flake.lock'
];

const FIXED_EXCLUDE_PATTERNS = [
    // Minified files
    '*.min.js',
    '*.min.css',
    '*.bundle.js',
    '*.chunk.js',
    // Build directories
    'dist/*',
    'build/*',
    '.next/*',
    '.nuxt/*',
    '.output/*',
    // Source maps
    '*.map',
    // Generated files
    '*.generated.*',
    // Binaries and heavy assets
    '*.woff',
    '*.woff2',
    '*.ttf',
    '*.eot',
    '*.ico',
    // Yarn PnP
    '.pnp.cjs',
    '.pnp.loader.mjs',
    '.yarn/cache/*',
    '.yarn/install-state.gz'
];

const PR_TYPES = [
    'feature',    // New feature
    'fix',        // Bug fix
    'refactor',   // Refactoring
    'docs',       // Documentation
    'test',       // Tests
    'chore',      // Maintenance
    'perf',       // Performance improvement
    'style',      // Style/formatting changes
    'ci'          // CI/CD
];

const FETCH_TIMEOUT_MS = 180000; // 3 minutes for PR generation (larger context)
const MAX_DIFF_LENGTH = 8000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 20; // 20MB for large PRs

// ============================================
// CONFIGURATION
// ============================================

const config = new Conf({
    projectName: 'mkpr',
    defaults: {
        ollamaPort: 11434,
        ollamaModel: 'llama3.2',
        baseBranch: 'main',
        outputDir: '.',
        excludeFiles: [...DEFAULT_EXCLUDES],
        debug: false
    }
});

// ============================================
// UTILITY FUNCTIONS
// ============================================

function debugLog(...args) {
    if (config.get('debug')) {
        console.log(chalk.gray('[DEBUG]'), ...args);
    }
}

function formatSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs / 1000}s. The model may be too slow or Ollama is unresponsive.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Sanitize branch name for safe filesystem usage
 */
function sanitizeBranchName(branchName) {
    return branchName
        .replace(/[\/\\:*?"<>|]/g, '_')  // Invalid filesystem chars
        .replace(/\s+/g, '_')             // Spaces
        .replace(/^\.+/, '')              // Leading dots
        .replace(/\.+$/, '')              // Trailing dots
        .replace(/_+/g, '_')              // Multiple underscores
        .substring(0, 100);               // Max length
}

/**
 * Validate branch name to prevent command injection
 */
function isValidBranchName(branchName) {
    // Git branch names can't contain: space, ~, ^, :, ?, *, [, \, or start with -
    // Also reject anything that looks like command injection
    const invalidPatterns = [
        /\s/,           // spaces
        /[~^:?*\[\]\\]/, // git invalid chars
        /^-/,           // starts with dash
        /\.\./,         // double dots
        /\/\//,         // double slashes
        /[@{}$`|;&]/,   // shell dangerous chars
        /^$/            // empty
    ];
    
    return !invalidPatterns.some(pattern => pattern.test(branchName));
}

// ============================================
// JSON SCHEMA FOR PR
// ============================================

const PR_SCHEMA = {
    type: "object",
    properties: {
        title: {
            type: "string",
            description: "A clear, concise PR title (max 72 chars)"
        },
        type: {
            type: "string",
            enum: PR_TYPES,
            description: "The type of change this PR introduces"
        },
        summary: {
            type: "string",
            description: "A 2-3 sentence summary of what this PR does and why"
        },
        changes: {
            type: "array",
            items: { type: "string" },
            description: "List of specific changes made in this PR"
        },
        breaking_changes: {
            type: "array",
            items: { type: "string" },
            description: "List of breaking changes, if any. Empty array if none."
        },
        testing: {
            type: "string",
            description: "How the changes were tested or should be tested"
        },
        notes: {
            type: "string",
            description: "Any additional notes for reviewers. Optional."
        }
    },
    required: ["title", "type", "summary", "changes"]
};

// ============================================
// PROMPT BUILDER
// ============================================

function buildSystemPrompt() {
    return `You are a PR description generator. Analyze git diffs and generate clear, professional Pull Request descriptions.

RULES:
1. Title must be clear, concise, and under 72 characters
2. Summary should explain WHAT the PR does and WHY (not HOW)
3. Changes should be specific, actionable items
4. Identify breaking changes if any
5. Be professional but concise

PR TYPES:
- feature: New functionality for users
- fix: Bug fix
- refactor: Code restructuring without behavior change
- docs: Documentation changes only
- test: Adding or updating tests
- chore: Maintenance tasks, dependencies
- perf: Performance improvements
- style: Code style/formatting changes
- ci: CI/CD configuration changes

OUTPUT FORMAT:
Respond ONLY with a valid JSON object matching this schema:
${JSON.stringify(PR_SCHEMA, null, 2)}

EXAMPLES:

Input: Branch "feature/user-auth" with changes to login system
Output: {
  "title": "Add OAuth2 authentication support",
  "type": "feature",
  "summary": "Implements OAuth2 authentication flow allowing users to sign in with Google and GitHub. This replaces the legacy session-based auth system.",
  "changes": [
    "Add OAuth2 provider configuration",
    "Implement callback handlers for Google and GitHub",
    "Create user linking for existing accounts",
    "Add logout flow for OAuth sessions"
  ],
  "breaking_changes": [
    "Session-based auth endpoints are deprecated",
    "User table schema updated with provider columns"
  ],
  "testing": "Tested OAuth flow manually with test accounts. Added integration tests for callback handlers.",
  "notes": "Requires OAUTH_CLIENT_ID and OAUTH_SECRET env vars to be set."
}

Input: Branch "fix/null-pointer" fixing a crash
Output: {
  "title": "Fix null pointer exception in user profile",
  "type": "fix",
  "summary": "Fixes a crash that occurred when viewing profiles of deleted users. The issue was caused by missing null checks.",
  "changes": [
    "Add null check before accessing user.profile",
    "Return 404 for deleted user profiles",
    "Add defensive coding in ProfileService"
  ],
  "breaking_changes": [],
  "testing": "Added unit test for deleted user edge case. Verified fix in staging.",
  "notes": ""
}`;
}

function buildUserPrompt(context) {
    const { currentBranch, baseBranch, diff, commits, changedFiles, stats } = context;

    const filesSummary = changedFiles
        .map(f => `${f.status[0].toUpperCase()} ${f.file}`)
        .join('\n');

    const commitsSummary = commits
        .slice(0, 20)
        .join('\n');

    // Smart diff truncation
    const truncatedDiff = truncateDiffSmart(diff);

    return `BRANCH INFO:
Current branch: ${currentBranch}
Base branch: ${baseBranch}

COMMITS (${commits.length}):
${commitsSummary}
${commits.length > 20 ? `\n... and ${commits.length - 20} more commits` : ''}

FILES CHANGED (${changedFiles.length}):
${filesSummary}

STATS:
${stats}

DIFF:
${truncatedDiff}

Generate a PR description for these changes. Respond with JSON only.`;
}

/**
 * Smart diff truncation that preserves file context
 */
function truncateDiffSmart(diff) {
    if (diff.length <= MAX_DIFF_LENGTH) {
        return diff;
    }

    const lines = diff.split('\n');
    const chunks = [];
    let currentChunk = { header: '', file: '', lines: [] };

    for (const line of lines) {
        // New file header
        if (line.startsWith('diff --git')) {
            if (currentChunk.header) {
                chunks.push(currentChunk);
            }
            const match = line.match(/diff --git a\/(.+) b\/(.+)/);
            currentChunk = {
                header: line,
                file: match ? match[2] : '',
                lines: []
            };
        } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
            currentChunk.lines.push(line);
        } else if ((line.startsWith('+') || line.startsWith('-')) &&
            !line.startsWith('+++') && !line.startsWith('---')) {
            currentChunk.lines.push(line);
        }
    }

    // Don't forget last chunk
    if (currentChunk.header) {
        chunks.push(currentChunk);
    }

    // Build truncated diff prioritizing all files with some changes
    const result = [];
    const maxLinesPerFile = Math.max(10, Math.floor(MAX_DIFF_LENGTH / (chunks.length || 1) / 60));
    let totalLength = 0;

    for (const chunk of chunks) {
        if (totalLength > MAX_DIFF_LENGTH) {
            result.push(`\n[... ${chunks.length - result.length} more files not shown ...]`);
            break;
        }

        result.push(chunk.header);
        const importantLines = chunk.lines.slice(0, maxLinesPerFile);
        result.push(...importantLines);

        if (chunk.lines.length > importantLines.length) {
            result.push(`  ... (${chunk.lines.length - importantLines.length} more lines in ${chunk.file})`);
        }

        totalLength = result.join('\n').length;
    }

    return result.join('\n');
}

// ============================================
// PR GENERATION
// ============================================

async function generatePRDescriptionText(context) {
    const port = config.get('ollamaPort');
    const model = config.get('ollamaModel');

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(context);

    debugLog('Sending request to Ollama...');
    debugLog(`Model: ${model}, Port: ${port}`);

    const response = await fetchWithTimeout(`http://localhost:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            stream: false,
            format: 'json',
            options: {
                temperature: 0.2,
                num_predict: 1500,
                top_p: 0.9
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const rawResponse = data.message?.content || data.response || '';

    debugLog('Raw response:', rawResponse.substring(0, 500) + '...');

    const prData = parsePRResponse(rawResponse);
    return formatPRMarkdown(prData, context);
}

function parsePRResponse(rawResponse) {
    let jsonStr = rawResponse.trim();

    // Clean artifacts
    jsonStr = jsonStr.replace(/^```json\s*/i, '');
    jsonStr = jsonStr.replace(/^```\s*/i, '');
    jsonStr = jsonStr.replace(/```\s*$/i, '');
    jsonStr = jsonStr.trim();

    // Extract JSON if there's text before/after
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        jsonStr = jsonMatch[0];
    }

    try {
        const parsed = JSON.parse(jsonStr);

        // Validate required fields with type checking
        if (!parsed.title || typeof parsed.title !== 'string') {
            throw new Error('Missing or invalid "title" field');
        }
        if (!parsed.type || typeof parsed.type !== 'string') {
            throw new Error('Missing or invalid "type" field');
        }
        if (!parsed.summary || typeof parsed.summary !== 'string') {
            throw new Error('Missing or invalid "summary" field');
        }

        // Validate and correct type
        if (!PR_TYPES.includes(parsed.type)) {
            const typeMap = {
                'feat': 'feature',
                'bug': 'fix',
                'bugfix': 'fix',
                'doc': 'docs',
                'documentation': 'docs',
                'tests': 'test',
                'testing': 'test',
                'performance': 'perf',
                'maintenance': 'chore',
                'build': 'chore',
                'breaking': 'feature' // Breaking is indicated in breaking_changes array
            };
            parsed.type = typeMap[parsed.type.toLowerCase()] || 'chore';
        }

        // Ensure arrays with type checking
        if (!Array.isArray(parsed.changes)) {
            if (typeof parsed.changes === 'string') {
                parsed.changes = [parsed.changes];
            } else {
                parsed.changes = [];
            }
        }
        parsed.changes = parsed.changes.filter(c => typeof c === 'string' && c.trim());

        if (!Array.isArray(parsed.breaking_changes)) {
            if (typeof parsed.breaking_changes === 'string' && parsed.breaking_changes.trim()) {
                parsed.breaking_changes = [parsed.breaking_changes];
            } else {
                parsed.breaking_changes = [];
            }
        }
        parsed.breaking_changes = parsed.breaking_changes.filter(c => typeof c === 'string' && c.trim());

        // Clean optional string fields
        if (parsed.testing && typeof parsed.testing !== 'string') {
            parsed.testing = '';
        }
        if (parsed.notes && typeof parsed.notes !== 'string') {
            parsed.notes = '';
        }

        // Truncate title if too long
        parsed.title = parsed.title.substring(0, 72);

        return parsed;

    } catch (parseError) {
        console.log(chalk.yellow('\n⚠️  Could not parse JSON, using fallback...'));
        debugLog('Parse error:', parseError.message);
        return extractPRFromText(rawResponse);
    }
}

function extractPRFromText(text) {
    const lines = text.split('\n').filter(l => l.trim());

    return {
        title: lines[0]?.substring(0, 72) || 'Update code',
        type: 'chore',
        summary: lines.slice(0, 3).join(' ').substring(0, 500),
        changes: lines.filter(l => l.startsWith('-') || l.startsWith('*'))
            .map(l => l.replace(/^[-*]\s*/, '')),
        breaking_changes: [],
        testing: '',
        notes: ''
    };
}

function formatPRMarkdown(prData, context) {
    const { title, type, summary, changes, breaking_changes, testing, notes } = prData;
    const { currentBranch, baseBranch, changedFiles, commits } = context;

    let md = `# ${title}\n\n`;

    // Type badge
    const typeEmoji = {
        'feature': '✨',
        'fix': '🐛',
        'refactor': '♻️',
        'docs': '📚',
        'test': '🧪',
        'chore': '🔧',
        'perf': '⚡',
        'style': '💄',
        'ci': '👷'
    };

    md += `**Type:** ${typeEmoji[type] || '📦'} \`${type}\`\n\n`;
    md += `**Branch:** \`${currentBranch}\` → \`${baseBranch}\`\n\n`;

    // Description
    md += `## Description\n\n${summary}\n\n`;

    // Changes
    md += `## Changes\n\n`;
    if (changes && changes.length > 0) {
        changes.forEach(change => {
            md += `- ${change}\n`;
        });
    } else {
        md += `- General code update\n`;
    }
    md += '\n';

    // Breaking changes
    if (breaking_changes && breaking_changes.length > 0) {
        md += `## ⚠️ Breaking Changes\n\n`;
        breaking_changes.forEach(bc => {
            md += `- ${bc}\n`;
        });
        md += '\n';
    }

    // Testing
    if (testing) {
        md += `## Testing\n\n${testing}\n\n`;
    }

    // Stats
    md += `## Stats\n\n`;
    md += `- **Commits:** ${commits.length}\n`;
    md += `- **Files changed:** ${changedFiles.length}\n`;

    const added = changedFiles.filter(f => f.status === 'added').length;
    const modified = changedFiles.filter(f => f.status === 'modified').length;
    const deleted = changedFiles.filter(f => f.status === 'deleted').length;

    if (added) md += `- **Files added:** ${added}\n`;
    if (modified) md += `- **Files modified:** ${modified}\n`;
    if (deleted) md += `- **Files deleted:** ${deleted}\n`;
    md += '\n';

    // Notes
    if (notes) {
        md += `## Additional Notes\n\n${notes}\n\n`;
    }

    // Checklist
    md += `## Checklist\n\n`;
    md += `- [ ] Code follows project standards\n`;
    md += `- [ ] Tests have been added (if applicable)\n`;
    md += `- [ ] Documentation has been updated (if applicable)\n`;
    md += `- [ ] Changes have been tested locally\n`;

    return md;
}

// ============================================
// EXCLUDED FILES MANAGEMENT
// ============================================

function getExcludedFiles() {
    return config.get('excludeFiles');
}

function getAllExcludePatterns() {
    const configExcludes = getExcludedFiles();
    return [...configExcludes, ...FIXED_EXCLUDE_PATTERNS];
}

function shouldExcludeFile(filename, excludePatterns) {
    return excludePatterns.some(pattern => {
        // Exact pattern
        if (pattern === filename) return true;

        // Pattern with wildcard at start (*.min.js)
        if (pattern.startsWith('*')) {
            const suffix = pattern.slice(1);
            if (filename.endsWith(suffix)) return true;
        }

        // Pattern with wildcard at end (dist/*)
        if (pattern.endsWith('/*')) {
            const prefix = pattern.slice(0, -2);
            if (filename.startsWith(prefix + '/') || filename === prefix) return true;
        }

        // Pattern with wildcard in middle (*.generated.*)
        if (pattern.includes('*')) {
            const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
            if (regex.test(filename)) return true;
        }

        // Match by filename (without path)
        const basename = filename.split('/').pop();
        if (pattern === basename) return true;

        return false;
    });
}

function filterDiff(diff, excludePatterns) {
    const lines = diff.split('\n');
    const filteredLines = [];
    let excludingCurrentFile = false;

    for (const line of lines) {
        // Detect start of new file
        if (line.startsWith('diff --git')) {
            const match = line.match(/diff --git a\/(.+) b\/(.+)/);
            if (match) {
                const currentFile = match[2];
                excludingCurrentFile = shouldExcludeFile(currentFile, excludePatterns);
                debugLog(`File: ${currentFile}, excluded: ${excludingCurrentFile}`);
            }
        }

        if (!excludingCurrentFile) {
            filteredLines.push(line);
        }
    }

    return filteredLines.join('\n');
}

function listExcludes() {
    const excludes = config.get('excludeFiles');
    console.log(chalk.cyan('\n🚫 Files excluded from analysis:\n'));

    if (excludes.length === 0) {
        console.log(chalk.yellow('   (none)'));
    } else {
        excludes.forEach((file, index) => {
            const isDefault = DEFAULT_EXCLUDES.includes(file);
            const tag = isDefault ? chalk.gray(' (default)') : '';
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(file)}${tag}`));
        });
    }

    console.log(chalk.cyan('\n📁 Fixed patterns (always excluded):\n'));
    FIXED_EXCLUDE_PATTERNS.forEach(pattern => {
        console.log(chalk.gray(`   • ${pattern}`));
    });
    console.log();
}

function addExclude(file) {
    const excludes = config.get('excludeFiles');

    if (excludes.includes(file)) {
        console.log(chalk.yellow(`\n⚠️  "${file}" is already in the exclusion list.\n`));
        return;
    }

    excludes.push(file);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Added to exclusions: ${chalk.yellow(file)}\n`));
}

function removeExclude(file) {
    const excludes = config.get('excludeFiles');
    const index = excludes.indexOf(file);

    if (index === -1) {
        console.log(chalk.yellow(`\n⚠️  "${file}" is not in the exclusion list.\n`));
        console.log(chalk.white('   Use --list-excludes to see the current list.\n'));
        return;
    }

    excludes.splice(index, 1);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Removed from exclusions: ${chalk.yellow(file)}\n`));
}

function resetExcludes() {
    config.set('excludeFiles', [...DEFAULT_EXCLUDES]);
    console.log(chalk.green('\n✅ Exclusion list reset to defaults.\n'));
}

// ============================================
// GIT FUNCTIONS
// ============================================

/**
 * Check if we're inside a valid git repository
 */
function isGitRepository() {
    try {
        const result = execSync('git rev-parse --is-inside-work-tree', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        return result === 'true';
    } catch {
        return false;
    }
}

/**
 * Get current branch name
 */
function getCurrentBranch() {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
    } catch (error) {
        debugLog('Error getting current branch:', error.message);
        throw new Error('Could not get current branch.');
    }
}

/**
 * Validate and get remote base branch
 */
function getRemoteBaseBranch(baseBranch) {
    // Validate branch name first
    if (!isValidBranchName(baseBranch)) {
        throw new Error(`Invalid branch name: "${baseBranch}"`);
    }

    try {
        // Try origin/branch first
        execSync(`git rev-parse --verify origin/${baseBranch}`, {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return `origin/${baseBranch}`;
    } catch {
        try {
            // Try local branch
            execSync(`git rev-parse --verify ${baseBranch}`, {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return baseBranch;
        } catch {
            throw new Error(`Base branch '${baseBranch}' not found. Verify it exists or use --base to specify another.`);
        }
    }
}

/**
 * Get diff between current branch and base
 */
function getBranchDiff(baseBranch) {
    if (!isGitRepository()) {
        throw new Error('You are not in a git repository. Run this command from within a git project.');
    }

    try {
        const currentBranch = getCurrentBranch();
        const remoteBranch = getRemoteBaseBranch(baseBranch);

        debugLog(`Current branch: ${currentBranch}`);
        debugLog(`Remote branch: ${remoteBranch}`);

        // Get diff
        let diff = execSync(`git diff ${remoteBranch}...HEAD --no-color`, {
            encoding: 'utf-8',
            maxBuffer: MAX_BUFFER_SIZE,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        if (!diff.trim()) {
            return null;
        }

        // Filter excluded files programmatically
        const excludePatterns = getAllExcludePatterns();
        diff = filterDiff(diff, excludePatterns);

        if (!diff.trim()) {
            return null;
        }

        return {
            diff,
            currentBranch,
            baseBranch: remoteBranch
        };

    } catch (error) {
        const errorMsg = error.message || error.stderr || String(error);

        if (errorMsg.includes('not a git repository')) {
            throw new Error('You are not in a git repository.');
        }
        if (errorMsg.includes('ENOBUFS') || errorMsg.includes('maxBuffer')) {
            throw new Error('The diff is too large. Consider splitting the PR.');
        }

        debugLog('Error getting branch diff:', errorMsg);
        throw error;
    }
}

/**
 * Get list of commits between branches
 */
function getCommitsList(baseBranch) {
    try {
        const remoteBranch = getRemoteBaseBranch(baseBranch);
        const commits = execSync(`git log ${remoteBranch}..HEAD --oneline --no-decorate`, {
            encoding: 'utf-8',
            maxBuffer: MAX_BUFFER_SIZE,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return commits.trim().split('\n').filter(c => c);
    } catch (error) {
        debugLog('Error getting commits:', error.message);
        return [];
    }
}

/**
 * Get list of changed files with status
 */
function getChangedFiles(baseBranch) {
    try {
        const remoteBranch = getRemoteBaseBranch(baseBranch);
        const excludePatterns = getAllExcludePatterns();

        const files = execSync(`git diff ${remoteBranch}...HEAD --name-status`, {
            encoding: 'utf-8',
            maxBuffer: MAX_BUFFER_SIZE,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        return files.trim().split('\n').filter(f => f).map(line => {
            const [status, ...fileParts] = line.split('\t');
            const file = fileParts.join('\t');
            const statusMap = { 'A': 'added', 'M': 'modified', 'D': 'deleted', 'R': 'renamed' };
            return {
                status: statusMap[status[0]] || status,
                statusCode: status[0],
                file,
                excluded: shouldExcludeFile(file, excludePatterns)
            };
        });
    } catch (error) {
        debugLog('Error getting changed files:', error.message);
        return [];
    }
}

/**
 * Get diff statistics
 */
function getFilesStats(baseBranch) {
    try {
        const remoteBranch = getRemoteBaseBranch(baseBranch);
        const stats = execSync(`git diff ${remoteBranch}...HEAD --stat`, {
            encoding: 'utf-8',
            maxBuffer: MAX_BUFFER_SIZE,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return stats.trim();
    } catch (error) {
        debugLog('Error getting stats:', error.message);
        return '(stats unavailable)';
    }
}

/**
 * Fetch latest from origin
 */
function fetchOrigin() {
    try {
        execSync('git fetch origin', {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000 // 30 second timeout
        });
        return { success: true };
    } catch (error) {
        const errorMsg = error.message || '';
        debugLog('Fetch error:', errorMsg);

        // Categorize the error
        if (errorMsg.includes('Could not resolve host') || errorMsg.includes('unable to access')) {
            return { success: false, reason: 'network', message: 'No network connection' };
        }
        if (errorMsg.includes('Authentication failed') || errorMsg.includes('Permission denied')) {
            return { success: false, reason: 'auth', message: 'Authentication failed' };
        }
        if (errorMsg.includes('timeout')) {
            return { success: false, reason: 'timeout', message: 'Connection timeout' };
        }

        return { success: false, reason: 'unknown', message: 'Unknown error' };
    }
}

/**
 * Save PR description to file
 */
function savePRDescription(content, branchName, outputDir) {
    const sanitizedName = sanitizeBranchName(branchName);
    const fileName = `${sanitizedName}_pr.md`;

    const resolvedOutputDir = path.resolve(process.cwd(), outputDir);
    const filePath = path.join(resolvedOutputDir, fileName);

    if (!fs.existsSync(resolvedOutputDir)) {
        fs.mkdirSync(resolvedOutputDir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

// ============================================
// OLLAMA FUNCTIONS
// ============================================

async function getAvailableModels() {
    const port = config.get('ollamaPort');
    const response = await fetchWithTimeout(`http://localhost:${port}/api/tags`, {}, 10000);

    if (!response.ok) {
        throw new Error(`Could not connect to Ollama on port ${port}`);
    }

    const data = await response.json();
    return data.models || [];
}

async function listModels() {
    const spinner = ora('Getting model list...').start();

    try {
        const models = await getAvailableModels();
        spinner.stop();

        if (models.length === 0) {
            console.log(chalk.yellow('\n⚠️  No models installed in Ollama.'));
            console.log(chalk.white('   Run: ollama pull <model> to download one.\n'));
            return;
        }

        console.log(chalk.cyan('\n📦 Available models in Ollama:\n'));
        models.forEach((model, index) => {
            const name = model.name || model.model;
            const size = model.size ? formatSize(model.size) : 'N/A';
            const current = name === config.get('ollamaModel') ? chalk.green(' ← current') : '';
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(name)} ${chalk.gray(`(${size})`)}${current}`));
        });
        console.log();

    } catch (error) {
        spinner.fail('Error connecting to Ollama');
        console.log(chalk.red(`\n❌ ${error.message}`));
        console.log(chalk.white('   Make sure Ollama is running.\n'));
    }
}

async function setModel(modelName) {
    const spinner = ora('Verifying model...').start();

    try {
        const models = await getAvailableModels();
        const modelNames = models.map(m => m.name || m.model);

        const exactMatch = modelNames.find(name => name === modelName);
        const partialMatch = modelNames.find(name =>
            name.startsWith(modelName + ':') || name.split(':')[0] === modelName
        );

        if (exactMatch) {
            config.set('ollamaModel', exactMatch);
            spinner.succeed(`Model set to: ${chalk.yellow(exactMatch)}`);
        } else if (partialMatch) {
            config.set('ollamaModel', partialMatch);
            spinner.succeed(`Model set to: ${chalk.yellow(partialMatch)}`);
        } else {
            spinner.fail('Model not found');
            console.log(chalk.red(`\n❌ Model "${modelName}" is not available.\n`));
            console.log(chalk.cyan('📦 Available models:'));
            modelNames.forEach(name => {
                console.log(chalk.white(`   • ${chalk.yellow(name)}`));
            });
            console.log();
            process.exit(1);
        }

    } catch (error) {
        spinner.fail('Error verifying model');
        console.log(chalk.red(`\n❌ ${error.message}`));
        process.exit(1);
    }
}

async function changeModelInteractive() {
    const spinner = ora('Getting available models...').start();

    try {
        const models = await getAvailableModels();
        spinner.stop();

        if (models.length === 0) {
            console.log(chalk.yellow('\n⚠️  No models installed in Ollama.\n'));
            return;
        }

        const currentModel = config.get('ollamaModel');
        const choices = models.map(model => {
            const name = model.name || model.model;
            const size = model.size ? formatSize(model.size) : '';
            const isCurrent = name === currentModel;
            return {
                name: `${name} ${chalk.gray(size)}${isCurrent ? chalk.green(' ← current') : ''}`,
                value: name,
                short: name
            };
        });

        const { selectedModel } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedModel',
                message: 'Select the model:',
                choices,
                default: currentModel
            }
        ]);

        config.set('ollamaModel', selectedModel);
        console.log(chalk.green(`\n✅ Model changed to: ${chalk.yellow(selectedModel)}`));

    } catch (error) {
        spinner.fail('Error getting models');
        console.log(chalk.red(`\n❌ ${error.message}`));
        console.log(chalk.white('   Make sure Ollama is running.\n'));
    }
}

// ============================================
// CONFIGURATION DISPLAY
// ============================================

function showConfig() {
    console.log(chalk.cyan('\n📋 Current configuration:\n'));
    console.log(chalk.white(`   Ollama Port:      ${chalk.yellow(config.get('ollamaPort'))}`));
    console.log(chalk.white(`   Model:            ${chalk.yellow(config.get('ollamaModel'))}`));
    console.log(chalk.white(`   Base branch:      ${chalk.yellow(config.get('baseBranch'))}`));
    console.log(chalk.white(`   Output directory: ${chalk.yellow(config.get('outputDir'))}`));
    console.log(chalk.white(`   Debug:            ${chalk.yellow(config.get('debug') ? 'enabled' : 'disabled')}`));
    console.log(chalk.white(`   Excluded files:   ${chalk.gray(config.get('excludeFiles').length + ' files')}`));
    console.log();
}

// ============================================
// MAIN FLOW
// ============================================

async function generatePRDescription(baseBranch, outputDir, dryRun) {
    console.log(chalk.cyan('\n🔍 Analyzing differences with base branch...\n'));

    // Fetch to ensure we have the latest version
    const fetchSpinner = ora('Getting latest changes from origin...').start();
    const fetchResult = fetchOrigin();

    if (fetchResult.success) {
        fetchSpinner.succeed('Repository updated');
    } else {
        if (fetchResult.reason === 'auth') {
            fetchSpinner.fail(`Could not fetch: ${fetchResult.message}`);
            console.log(chalk.yellow('   Continuing with local data, but results may be outdated.\n'));
        } else {
            fetchSpinner.warn(`Could not fetch (${fetchResult.message}), continuing with local data`);
        }
    }

    const diffData = getBranchDiff(baseBranch);

    if (!diffData) {
        console.log(chalk.yellow('⚠️  No differences with base branch.'));
        console.log(chalk.white(`   Your branch is up to date with ${baseBranch}.\n`));
        process.exit(0);
    }

    const commits = getCommitsList(baseBranch);
    const changedFiles = getChangedFiles(baseBranch);
    const stats = getFilesStats(baseBranch);

    // Filter excluded files for display
    const includedFiles = changedFiles.filter(f => !f.excluded);
    const excludedFiles = changedFiles.filter(f => f.excluded);

    console.log(chalk.white(`📌 Current branch: ${chalk.yellow(diffData.currentBranch)}`));
    console.log(chalk.white(`📌 Base branch:    ${chalk.yellow(diffData.baseBranch)}`));
    console.log(chalk.white(`📝 Commits:        ${chalk.yellow(commits.length)}`));
    console.log(chalk.white(`📁 Files:          ${chalk.yellow(includedFiles.length)} ${excludedFiles.length > 0 ? chalk.gray(`(${excludedFiles.length} excluded)`) : ''}`));
    console.log();

    // Show changed files
    console.log(chalk.white('📁 Modified files:'));
    includedFiles.slice(0, 10).forEach(f => {
        const statusColor = f.status === 'added' ? chalk.green :
            f.status === 'deleted' ? chalk.red : chalk.yellow;
        console.log(chalk.gray(`   ${statusColor(`[${f.statusCode}]`)} ${f.file}`));
    });
    if (includedFiles.length > 10) {
        console.log(chalk.gray(`   ... and ${includedFiles.length - 10} more files`));
    }

    // Show excluded files
    if (excludedFiles.length > 0) {
        console.log(chalk.gray(`\n🚫 Excluded from analysis (${excludedFiles.length}):`));
        excludedFiles.slice(0, 5).forEach(f => {
            console.log(chalk.gray(`   • ${f.file}`));
        });
        if (excludedFiles.length > 5) {
            console.log(chalk.gray(`   ... and ${excludedFiles.length - 5} more`));
        }
    }
    console.log();

    const context = {
        currentBranch: diffData.currentBranch,
        baseBranch: diffData.baseBranch,
        diff: diffData.diff,
        commits,
        changedFiles: includedFiles,
        stats
    };

    let continueLoop = true;

    while (continueLoop) {
        const spinner = ora({
            text: `Generating description with ${chalk.yellow(config.get('ollamaModel'))}...`,
            spinner: 'dots'
        }).start();

        let prDescription;
        try {
            prDescription = await generatePRDescriptionText(context);
            spinner.succeed('Description generated');
        } catch (error) {
            spinner.fail('Error generating description');
            console.log(chalk.red(`\n❌ ${error.message}`));
            console.log(chalk.white('   Verify that Ollama is running and the model is available.\n'));
            process.exit(1);
        }

        console.log(chalk.cyan('\n📝 Proposed PR description:\n'));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(prDescription);
        console.log(chalk.gray('─'.repeat(60)));
        console.log();

        const choices = [
            { name: chalk.green('✅ Accept and save file'), value: 'accept' },
            { name: chalk.yellow('🔄 Generate another description'), value: 'regenerate' },
            { name: chalk.blue('✏️  Edit title manually'), value: 'edit' },
            { name: chalk.cyan('📋 Copy to clipboard'), value: 'copy' },
            new inquirer.Separator(),
            { name: chalk.magenta('🤖 Change model'), value: 'change-model' },
            new inquirer.Separator(),
            { name: chalk.red('❌ Cancel'), value: 'cancel' }
        ];

        if (dryRun) {
            choices[0] = { name: chalk.green('✅ Accept (dry-run, will not save)'), value: 'accept' };
        }

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices
            }
        ]);

        switch (action) {
            case 'accept':
                if (dryRun) {
                    console.log(chalk.yellow('\n🏃 Dry-run: description NOT saved.\n'));
                } else {
                    const saveSpinner = ora('Saving file...').start();
                    try {
                        const filePath = savePRDescription(prDescription, diffData.currentBranch, outputDir);
                        saveSpinner.succeed(`File saved: ${chalk.green(filePath)}`);
                        console.log(chalk.cyan('\n💡 Tip: You can copy the file content for your PR.\n'));
                    } catch (error) {
                        saveSpinner.fail('Error saving file');
                        console.log(chalk.red(`\n❌ ${error.message}\n`));
                    }
                }
                continueLoop = false;
                break;

            case 'regenerate':
                console.log(chalk.cyan('\n🔄 Generating new description...\n'));
                break;

            case 'edit':
                const { editedTitle } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'editedTitle',
                        message: 'Edit the PR title:',
                        default: diffData.currentBranch.replace(/[-_]/g, ' ')
                    }
                ]);

                const finalDescription = prDescription.replace(/^# .+$/m, `# ${editedTitle}`);

                if (!dryRun) {
                    const editSaveSpinner = ora('Saving file...').start();
                    try {
                        const filePath = savePRDescription(finalDescription, diffData.currentBranch, outputDir);
                        editSaveSpinner.succeed(`File saved: ${chalk.green(filePath)}`);
                    } catch (error) {
                        editSaveSpinner.fail('Error saving file');
                        console.log(chalk.red(`\n❌ ${error.message}\n`));
                    }
                } else {
                    console.log(chalk.yellow('\n🏃 Dry-run: description NOT saved.\n'));
                }
                continueLoop = false;
                break;

            case 'copy':
                try {
                    // Try to copy to clipboard using available system commands
                    const copyCommands = [
                        { cmd: 'pbcopy', platform: 'darwin' },
                        { cmd: 'xclip -selection clipboard', platform: 'linux' },
                        { cmd: 'xsel --clipboard --input', platform: 'linux' },
                        { cmd: 'clip', platform: 'win32' }
                    ];

                    const platform = process.platform;
                    let copied = false;

                    for (const { cmd, platform: p } of copyCommands) {
                        if (p === platform || (p === 'linux' && platform === 'linux')) {
                            try {
                                execSync(cmd, {
                                    input: prDescription,
                                    stdio: ['pipe', 'pipe', 'pipe']
                                });
                                copied = true;
                                console.log(chalk.green('\n✅ Copied to clipboard!\n'));
                                break;
                            } catch {
                                continue;
                            }
                        }
                    }

                    if (!copied) {
                        console.log(chalk.yellow('\n⚠️  Could not copy to clipboard. Save the file instead.\n'));
                    }
                } catch {
                    console.log(chalk.yellow('\n⚠️  Clipboard not available on this system.\n'));
                }
                break;

            case 'change-model':
                await changeModelInteractive();
                console.log(chalk.cyan('\n🔄 Regenerating description with new model...\n'));
                break;

            case 'cancel':
                console.log(chalk.yellow('\n👋 Operation cancelled.\n'));
                continueLoop = false;
                break;
        }
    }
}

// ============================================
// CLI DEFINITION
// ============================================

const program = new Command();

program
    .name('mkpr')
    .description(chalk.cyan('🚀 CLI to generate PR descriptions using Ollama AI'))
    .version('1.1.0');

program
    .option('--set-model [model]', 'Set the Ollama model to use (interactive if omitted)')
    .option('--set-port <port>', 'Set the Ollama port')
    .option('--set-base <branch>', 'Set the base branch for comparison (default: main)')
    .option('--set-output <dir>', 'Set output directory for PR files')
    .option('--show-config', 'Show current configuration')
    .option('--list-models', 'List available models in Ollama')
    .option('--add-exclude <file>', 'Add file to exclusion list')
    .option('--remove-exclude <file>', 'Remove file from exclusion list')
    .option('--list-excludes', 'List excluded files')
    .option('--reset-excludes', 'Reset exclusion list to defaults')
    .option('-b, --base <branch>', 'Base branch for this run (not saved)')
    .option('-o, --output <dir>', 'Output directory for this run (not saved)')
    .option('--dry-run', 'Only show description without saving file')
    .option('--debug', 'Enable debug mode')
    .action(async (options) => {
        try {
            // Handle debug flag
            if (options.debug) {
                config.set('debug', true);
                console.log(chalk.gray('[DEBUG] Debug mode enabled'));
            }

            if (options.showConfig) {
                showConfig();
                return;
            }

            if (options.listModels) {
                await listModels();
                return;
            }

            if (options.listExcludes) {
                listExcludes();
                return;
            }

            if (options.addExclude) {
                addExclude(options.addExclude);
                return;
            }

            if (options.removeExclude) {
                removeExclude(options.removeExclude);
                return;
            }

            if (options.resetExcludes) {
                resetExcludes();
                return;
            }

            if (options.setPort) {
                const port = parseInt(options.setPort);
                if (isNaN(port) || port < 1 || port > 65535) {
                    console.log(chalk.red('❌ Invalid port. Must be a number between 1 and 65535.'));
                    process.exit(1);
                }
                config.set('ollamaPort', port);
                console.log(chalk.green(`✅ Port set to: ${port}`));
            }

            if (options.setModel !== undefined) {
                if (options.setModel === true) {
                    await changeModelInteractive();
                } else {
                    await setModel(options.setModel);
                }
            }

            if (options.setBase) {
                if (!isValidBranchName(options.setBase)) {
                    console.log(chalk.red(`❌ Invalid branch name: "${options.setBase}"`));
                    process.exit(1);
                }
                config.set('baseBranch', options.setBase);
                console.log(chalk.green(`✅ Base branch set to: ${options.setBase}`));
            }

            if (options.setOutput) {
                config.set('outputDir', options.setOutput);
                console.log(chalk.green(`✅ Output directory set to: ${options.setOutput}`));
            }

            if (options.setPort || options.setModel !== undefined || options.setBase || options.setOutput) {
                return;
            }

            // Validate base branch from options
            const baseBranch = options.base || config.get('baseBranch');
            if (!isValidBranchName(baseBranch)) {
                console.log(chalk.red(`❌ Invalid base branch name: "${baseBranch}"`));
                process.exit(1);
            }

            const outputDir = options.output || config.get('outputDir');
            const dryRun = options.dryRun || false;

            await generatePRDescription(baseBranch, outputDir, dryRun);

        } catch (error) {
            console.error(chalk.red(`❌ Error: ${error.message}`));
            if (config.get('debug')) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });

program.parse();