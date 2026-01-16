# mkpr - Make Pull Request Messages Automatically

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./black-favicon.svg">
    <source media="(prefers-color-scheme: light)" srcset="./white-favicon.svg">
    <img src="./black-favicon.svg" alt="mkpr logo" width="150">
  </picture>
</p>

CLI to automatically generate Pull Request descriptions using **Ollama** with local AI.

## Features

- ✨ Generates complete and professional PR descriptions
- 🔍 Compares your current branch against the base branch (origin/main by default)
- 📝 Saves the description to a `{branch_name}_pr.md` file
- 🤖 Uses local AI models through **Ollama**
- 🎨 Interactive interface with colors and spinners
- ⚙️ Persistent configuration

## Installation

### From npm (recommended)

```bash
npm install -g mkpr-cli
```

### From source

```bash
# Clone the repository
git clone https://github.com/yourusername/mkpr-cli.git
cd mkpr-cli

# Install globally
npm install -g .
```

### Run without installing

```bash
npx mkpr-cli
```

## Requirements

- **Node.js** >= 14.0.0
- **Ollama** running locally
- A model installed in Ollama (e.g.: `ollama pull llama3.2`)
- Be in a git repository with a branch different from base

## Usage

### Generate PR description

```bash
# While on your feature branch
mkpr
```

### Execution options

```bash
# Compare against a different base branch (this run only)
mkpr -b develop

# Save to a specific directory (this run only)
mkpr -o ./docs/prs

# Only view the description without saving file
mkpr --dry-run

# Combine options
mkpr -b develop -o ./prs --dry-run
```

### Persistent configuration

```bash
# View current configuration
mkpr --show-config

# Change Ollama model (interactive selector)
mkpr --set-model

# Change Ollama model (direct)
mkpr --set-model llama3.1

# Change Ollama port
mkpr --set-port 11434

# Change default base branch
mkpr --set-base develop

# Change default output directory
mkpr --set-output ./docs/prs

# List available models
mkpr --list-models

# View help
mkpr --help
```

### File exclusion management

```bash
# List excluded files
mkpr --list-excludes

# Add file to exclusion list
mkpr --add-exclude "*.generated.js"

# Remove file from exclusion list
mkpr --remove-exclude "package-lock.json"

# Reset exclusion list to defaults
mkpr --reset-excludes
```

## Workflow

1. Create your feature branch: `git checkout -b feature/new-functionality`
2. Make your commits as usual
3. When ready for the PR, run: `mkpr`
4. The CLI:
   - Runs `git fetch origin` to update
   - Compares your branch against `origin/main` (or configured branch)
   - Gets all commits, changed files, and the diff
   - Generates a description using AI
5. You can:
   - ✅ **Accept** and save the file
   - 🔄 **Regenerate** another description
   - ✏️ **Edit** the title manually
   - 🤖 **Change model** and regenerate
   - ❌ **Cancel** the operation

## Output example

The generated file `feature_new-functionality_pr.md` will contain:

```markdown
# Add user authentication system

**Type:** ✨ `feature`

**Branch:** `feature/add-user-auth` → `origin/main`

## Description

This PR implements a complete user authentication system with JWT tokens...

## Changes

- Add AuthService with JWT token generation
- Implement login and registration endpoints
- Create token validation middleware
- Update route configuration

## Stats

- **Commits:** 5
- **Files changed:** 12
- **Files added:** 4
- **Files modified:** 8

## Checklist

- [ ] Code follows project standards
- [ ] Tests have been added (if applicable)
- [ ] Documentation has been updated (if applicable)
- [ ] Changes have been tested locally
```

## Usage example

```
$ mkpr

🔍 Analyzing differences with base branch...

✔ Repository updated
📌 Current branch: feature/add-user-auth
📌 Base branch:    origin/main
📝 Commits:        5
📁 Files:          12

📁 Modified files:
   [A] src/auth/AuthService.js
   [A] src/auth/AuthController.js
   [M] src/routes/index.js
   [M] package.json
   ... and 8 more files

⠋ Generating description with llama3.2...
✔ Description generated

📝 Proposed PR description:
────────────────────────────────────────────────────────────
# Add user authentication system
...
────────────────────────────────────────────────────────────

? What would you like to do? (Use arrow keys)
❯ ✅ Accept and save file
  🔄 Generate another description
  ✏️  Edit title manually
  ──────────────
  🤖 Change model
  ──────────────
  ❌ Cancel

✔ File saved: ./feature_add-user-auth_pr.md

💡 Tip: You can copy the file content for your PR.
```

## Default configuration

| Option | Default value |
|--------|---------------|
| Port | `11434` |
| Model | `llama3.2` |
| Base branch | `main` |
| Output directory | `.` (current directory) |

## Default excluded files

The following files are excluded from analysis by default:

- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- `composer.lock`, `Gemfile.lock`, `poetry.lock`
- `Cargo.lock`, `pubspec.lock`, `packages.lock.json`
- Minified files (`*.min.js`, `*.min.css`)
- Build directories (`dist/*`, `build/*`, `.next/*`)
- Source maps (`*.map`)

## Tips

- The file is saved with the branch name, replacing special characters
- Use `--dry-run` to preview without creating files
- If you work with `develop` as base branch, use `mkpr --set-base develop` once
- You can regenerate the description as many times as you want before accepting
- Use `--set-model` without arguments to interactively select a model

## Updating

```bash
npm update -g mkpr-cli
```

## Uninstalling

```bash
npm uninstall -g mkpr-cli
```

## License

MIT