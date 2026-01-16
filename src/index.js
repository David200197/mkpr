#!/usr/bin/env node

const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const Conf = require('conf');
const fetch = require('node-fetch');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURACIÓN
// ============================================

const config = new Conf({
    projectName: 'mkpr',
    defaults: {
        ollamaPort: 11434,
        ollamaModel: 'llama3.2',
        baseBranch: 'main',
        outputDir: '.',
        excludeFiles: [
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
        ]
    }
});

// ============================================
// CONSTANTES DE EXCLUSIÓN
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
    // Archivos minificados
    '*.min.js',
    '*.min.css',
    '*.bundle.js',
    '*.chunk.js',
    // Directorios de build
    'dist/*',
    'build/*',
    '.next/*',
    '.nuxt/*',
    '.output/*',
    // Source maps
    '*.map',
    // Archivos generados
    '*.generated.*',
    // Binarios y assets pesados
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

// ============================================
// TIPOS DE CAMBIO PARA PR
// ============================================

const PR_TYPES = [
    'feature',    // Nueva funcionalidad
    'fix',        // Corrección de bug
    'refactor',   // Refactorización
    'docs',       // Documentación
    'test',       // Tests
    'chore',      // Mantenimiento
    'perf',       // Mejora de rendimiento
    'style',      // Cambios de estilo/formato
    'ci',         // CI/CD
    'breaking'    // Cambio que rompe compatibilidad
];

// ============================================
// SCHEMA JSON PARA PR
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
- breaking: Changes that break backward compatibility

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
    
    // Truncado inteligente del diff
    const truncatedDiff = truncateDiffSmart(diff, 8000);
    
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

function truncateDiffSmart(diff, maxLength) {
    if (diff.length <= maxLength) {
        return diff;
    }
    
    const lines = diff.split('\n');
    const importantLines = [];
    let currentLength = 0;
    
    for (const line of lines) {
        // Priorizar headers de archivo y cambios
        if (line.startsWith('diff --git') || 
            line.startsWith('+++') || 
            line.startsWith('---') ||
            line.startsWith('+') || 
            line.startsWith('-') ||
            line.startsWith('@@')) {
            
            if (currentLength + line.length < maxLength) {
                importantLines.push(line);
                currentLength += line.length + 1;
            }
        }
    }
    
    let result = importantLines.join('\n');
    if (result.length < diff.length) {
        result += '\n\n[... diff truncated for length ...]';
    }
    
    return result;
}

// ============================================
// GENERACIÓN DE PR
// ============================================

async function generatePRDescriptionText(context) {
    const port = config.get('ollamaPort');
    const model = config.get('ollamaModel');
    
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(context);
    
    // Usar /api/chat en lugar de /api/generate
    const response = await fetch(`http://localhost:${port}/api/chat`, {
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
        throw new Error(`Error de Ollama: ${errorText}`);
    }
    
    const data = await response.json();
    const rawResponse = data.message?.content || data.response || '';
    
    // Parsear y validar JSON
    const prData = parsePRResponse(rawResponse);
    
    // Formatear a Markdown
    return formatPRMarkdown(prData, context);
}

function parsePRResponse(rawResponse) {
    let jsonStr = rawResponse.trim();
    
    // Limpiar artefactos
    jsonStr = jsonStr.replace(/^```json\s*/i, '');
    jsonStr = jsonStr.replace(/^```\s*/i, '');
    jsonStr = jsonStr.replace(/```\s*$/i, '');
    jsonStr = jsonStr.trim();
    
    // Extraer JSON si hay texto antes/después
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        jsonStr = jsonMatch[0];
    }
    
    try {
        const parsed = JSON.parse(jsonStr);
        
        // Validar campos requeridos
        if (!parsed.title || !parsed.type || !parsed.summary) {
            throw new Error('Missing required fields');
        }
        
        // Validar tipo
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
                'build': 'chore'
            };
            parsed.type = typeMap[parsed.type.toLowerCase()] || 'chore';
        }
        
        // Asegurar arrays
        if (!Array.isArray(parsed.changes)) {
            parsed.changes = parsed.changes ? [parsed.changes] : [];
        }
        if (!Array.isArray(parsed.breaking_changes)) {
            parsed.breaking_changes = parsed.breaking_changes ? [parsed.breaking_changes] : [];
        }
        
        return parsed;
        
    } catch (parseError) {
        console.log(chalk.yellow('\n⚠️  No se pudo parsear JSON, usando fallback...'));
        return extractPRFromText(rawResponse);
    }
}

function extractPRFromText(text) {
    // Fallback para cuando el modelo no devuelve JSON válido
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
    
    // Badge del tipo
    const typeEmoji = {
        'feature': '✨',
        'fix': '🐛',
        'refactor': '♻️',
        'docs': '📚',
        'test': '🧪',
        'chore': '🔧',
        'perf': '⚡',
        'style': '💄',
        'ci': '👷',
        'breaking': '💥'
    };
    
    md += `**Tipo:** ${typeEmoji[type] || '📦'} \`${type}\`\n\n`;
    md += `**Branch:** \`${currentBranch}\` → \`${baseBranch}\`\n\n`;
    
    // Descripción
    md += `## Descripción\n\n${summary}\n\n`;
    
    // Cambios
    md += `## Cambios realizados\n\n`;
    if (changes && changes.length > 0) {
        changes.forEach(change => {
            md += `- ${change}\n`;
        });
    } else {
        md += `- Actualización general del código\n`;
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
    
    // Estadísticas
    md += `## Estadísticas\n\n`;
    md += `- **Commits:** ${commits.length}\n`;
    md += `- **Archivos modificados:** ${changedFiles.length}\n`;
    
    const added = changedFiles.filter(f => f.status === 'added').length;
    const modified = changedFiles.filter(f => f.status === 'modified').length;
    const deleted = changedFiles.filter(f => f.status === 'deleted').length;
    
    if (added) md += `- **Archivos agregados:** ${added}\n`;
    if (modified) md += `- **Archivos modificados:** ${modified}\n`;
    if (deleted) md += `- **Archivos eliminados:** ${deleted}\n`;
    md += '\n';
    
    // Notas
    if (notes) {
        md += `## Notas adicionales\n\n${notes}\n\n`;
    }
    
    // Checklist
    md += `## Checklist\n\n`;
    md += `- [ ] El código sigue los estándares del proyecto\n`;
    md += `- [ ] Se han añadido tests (si aplica)\n`;
    md += `- [ ] La documentación ha sido actualizada (si aplica)\n`;
    md += `- [ ] Los cambios han sido probados localmente\n`;
    
    return md;
}

// ============================================
// GESTIÓN DE ARCHIVOS EXCLUIDOS
// ============================================

function listExcludes() {
    const excludes = config.get('excludeFiles');
    console.log(chalk.cyan('\n🚫 Archivos excluidos del análisis:\n'));
    
    if (excludes.length === 0) {
        console.log(chalk.yellow('   (ninguno)'));
    } else {
        excludes.forEach((file, index) => {
            const isDefault = DEFAULT_EXCLUDES.includes(file);
            const tag = isDefault ? chalk.gray(' (default)') : '';
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(file)}${tag}`));
        });
    }
    
    console.log(chalk.cyan('\n📁 Patrones fijos (siempre excluidos):\n'));
    FIXED_EXCLUDE_PATTERNS.forEach(pattern => {
        console.log(chalk.gray(`   • ${pattern}`));
    });
    console.log();
}

function addExclude(file) {
    const excludes = config.get('excludeFiles');
    
    if (excludes.includes(file)) {
        console.log(chalk.yellow(`\n⚠️  "${file}" ya está en la lista de exclusión.\n`));
        return;
    }
    
    excludes.push(file);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Agregado a exclusiones: ${chalk.yellow(file)}\n`));
}

function removeExclude(file) {
    const excludes = config.get('excludeFiles');
    const index = excludes.indexOf(file);
    
    if (index === -1) {
        console.log(chalk.yellow(`\n⚠️  "${file}" no está en la lista de exclusión.\n`));
        console.log(chalk.white('   Usa --list-excludes para ver la lista actual.\n'));
        return;
    }
    
    excludes.splice(index, 1);
    config.set('excludeFiles', excludes);
    console.log(chalk.green(`\n✅ Eliminado de exclusiones: ${chalk.yellow(file)}\n`));
}

function resetExcludes() {
    config.set('excludeFiles', [...DEFAULT_EXCLUDES]);
    console.log(chalk.green('\n✅ Lista de exclusiones restablecida a valores por defecto.\n'));
}

function getExcludedFiles() {
    return config.get('excludeFiles');
}

function getAllExcludePatterns() {
    const configExcludes = getExcludedFiles();
    return [...configExcludes, ...FIXED_EXCLUDE_PATTERNS];
}

function shouldExcludeFile(filename, excludePatterns) {
    return excludePatterns.some(pattern => {
        // Patrón exacto
        if (pattern === filename) return true;
        
        // Patrón con wildcard al inicio (*.min.js)
        if (pattern.startsWith('*')) {
            const suffix = pattern.slice(1);
            if (filename.endsWith(suffix)) return true;
        }
        
        // Patrón con wildcard al final (dist/*)
        if (pattern.endsWith('/*')) {
            const prefix = pattern.slice(0, -2);
            if (filename.startsWith(prefix + '/') || filename === prefix) return true;
        }
        
        // Patrón con wildcard en medio (*.generated.*)
        if (pattern.includes('*')) {
            const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
            if (regex.test(filename)) return true;
        }
        
        // Coincidencia por nombre de archivo (sin path)
        const basename = filename.split('/').pop();
        if (pattern === basename) return true;
        
        return false;
    });
}

function filterDiff(diff, excludePatterns) {
    const lines = diff.split('\n');
    const filteredLines = [];
    let currentFile = null;
    let excludingCurrentFile = false;
    
    for (const line of lines) {
        // Detectar inicio de nuevo archivo
        if (line.startsWith('diff --git')) {
            // Extraer nombre del archivo: diff --git a/path/file b/path/file
            const match = line.match(/diff --git a\/(.+) b\/(.+)/);
            if (match) {
                currentFile = match[2]; // Usar el archivo destino (b/)
                excludingCurrentFile = shouldExcludeFile(currentFile, excludePatterns);
            }
        }
        
        // Solo incluir líneas si no estamos excluyendo el archivo actual
        if (!excludingCurrentFile) {
            filteredLines.push(line);
        }
    }
    
    return filteredLines.join('\n');
}

// ============================================
// FUNCIONES GIT
// ============================================

function getCurrentBranch() {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    } catch (error) {
        throw new Error('No se pudo obtener la rama actual.');
    }
}

function getRemoteBaseBranch(baseBranch) {
    try {
        execSync(`git rev-parse origin/${baseBranch}`, { stdio: 'pipe' });
        return `origin/${baseBranch}`;
    } catch {
        try {
            execSync(`git rev-parse ${baseBranch}`, { stdio: 'pipe' });
            return baseBranch;
        } catch {
            throw new Error(`No se encontró la rama base '${baseBranch}'. Verifica que exista o usa --base para especificar otra.`);
        }
    }
}

function getBranchDiff(baseBranch) {
    try {
        execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
        
        const currentBranch = getCurrentBranch();
        const remoteBranch = getRemoteBaseBranch(baseBranch);
        
        // Obtener diff sin exclusiones
        const diffCommand = `git diff ${remoteBranch}...HEAD --no-color`;
        
        let diff = execSync(diffCommand, { 
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 10
        });
        
        if (!diff.trim()) {
            return null;
        }
        
        // Filtrar archivos excluidos programáticamente
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
        if (error.message.includes('not a git repository')) {
            throw new Error('No estás en un repositorio git.');
        }
        if (error.message.includes('ENOBUFS') || error.message.includes('maxBuffer')) {
            throw new Error('El diff es demasiado grande. Considera dividir el PR.');
        }
        throw error;
    }
}

function getCommitsList(baseBranch) {
    try {
        const remoteBranch = getRemoteBaseBranch(baseBranch);
        const commits = execSync(`git log ${remoteBranch}..HEAD --oneline --no-decorate`, { 
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024
        });
        return commits.trim().split('\n').filter(c => c);
    } catch {
        return [];
    }
}

function getChangedFiles(baseBranch) {
    try {
        const remoteBranch = getRemoteBaseBranch(baseBranch);
        const excludePatterns = getAllExcludePatterns();
        
        const files = execSync(`git diff ${remoteBranch}...HEAD --name-status`, { 
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024
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
    } catch {
        return [];
    }
}

function getFilesStats(baseBranch) {
    try {
        const remoteBranch = getRemoteBaseBranch(baseBranch);
        const stats = execSync(`git diff ${remoteBranch}...HEAD --stat`, { 
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024
        });
        return stats.trim();
    } catch {
        return '';
    }
}

function sanitizeBranchName(branchName) {
    return branchName.replace(/[\/\\:*?"<>|]/g, '_');
}

function savePRDescription(content, branchName, outputDir) {
    const sanitizedName = sanitizeBranchName(branchName);
    const fileName = `${sanitizedName}_pr.md`;
    const filePath = path.join(outputDir, fileName);
    
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

// ============================================
// CLI
// ============================================

const program = new Command();

program
    .name('mkpr')
    .description(chalk.cyan('🚀 CLI para generar descripciones de PR usando Ollama AI'))
    .version('1.0.0');

program
    .option('--set-model <model>', 'Establecer el modelo de Ollama a usar')
    .option('--set-port <port>', 'Establecer el puerto de Ollama')
    .option('--set-base <branch>', 'Establecer la rama base para comparar (default: main)')
    .option('--set-output <dir>', 'Establecer directorio de salida para los archivos PR')
    .option('--show-config', 'Mostrar la configuración actual')
    .option('--list-models', 'Listar modelos disponibles en Ollama')
    .option('--add-exclude <file>', 'Agregar archivo a la lista de exclusión')
    .option('--remove-exclude <file>', 'Eliminar archivo de la lista de exclusión')
    .option('--list-excludes', 'Listar archivos excluidos')
    .option('--reset-excludes', 'Restablecer lista de exclusión por defecto')
    .option('-b, --base <branch>', 'Rama base para esta ejecución (sin guardar)')
    .option('-o, --output <dir>', 'Directorio de salida para esta ejecución (sin guardar)')
    .option('--dry-run', 'Solo mostrar la descripción sin guardar archivo')
    .action(async (options) => {
        try {
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
                    console.log(chalk.red('❌ Puerto inválido. Debe ser un número entre 1 y 65535.'));
                    process.exit(1);
                }
                config.set('ollamaPort', port);
                console.log(chalk.green(`✅ Puerto establecido a: ${port}`));
            }

            if (options.setModel) {
                await setModel(options.setModel);
            }

            if (options.setBase) {
                config.set('baseBranch', options.setBase);
                console.log(chalk.green(`✅ Rama base establecida a: ${options.setBase}`));
            }

            if (options.setOutput) {
                config.set('outputDir', options.setOutput);
                console.log(chalk.green(`✅ Directorio de salida establecido a: ${options.setOutput}`));
            }

            if (options.setPort || options.setModel || options.setBase || options.setOutput) {
                return;
            }

            const baseBranch = options.base || config.get('baseBranch');
            const outputDir = options.output || config.get('outputDir');
            const dryRun = options.dryRun || false;

            await generatePRDescription(baseBranch, outputDir, dryRun);

        } catch (error) {
            console.error(chalk.red(`❌ Error: ${error.message}`));
            process.exit(1);
        }
    });

program.parse();

// ============================================
// FUNCIONES DE CONFIGURACIÓN
// ============================================

function showConfig() {
    console.log(chalk.cyan('\n📋 Configuración actual:\n'));
    console.log(chalk.white(`   Puerto Ollama:     ${chalk.yellow(config.get('ollamaPort'))}`));
    console.log(chalk.white(`   Modelo:            ${chalk.yellow(config.get('ollamaModel'))}`));
    console.log(chalk.white(`   Rama base:         ${chalk.yellow(config.get('baseBranch'))}`));
    console.log(chalk.white(`   Directorio salida: ${chalk.yellow(config.get('outputDir'))}`));
    console.log(chalk.white(`   Archivos excluidos: ${chalk.gray(config.get('excludeFiles').length + ' archivos')}`));
    console.log();
}

async function getAvailableModels() {
    const port = config.get('ollamaPort');
    const response = await fetch(`http://localhost:${port}/api/tags`);
    
    if (!response.ok) {
        throw new Error(`No se pudo conectar a Ollama en el puerto ${port}`);
    }
    
    const data = await response.json();
    return data.models || [];
}

async function listModels() {
    const spinner = ora('Obteniendo lista de modelos...').start();
    
    try {
        const models = await getAvailableModels();
        spinner.stop();
        
        if (models.length === 0) {
            console.log(chalk.yellow('\n⚠️  No hay modelos instalados en Ollama.'));
            console.log(chalk.white('   Ejecuta: ollama pull <modelo> para descargar uno.\n'));
            return;
        }
        
        console.log(chalk.cyan('\n📦 Modelos disponibles en Ollama:\n'));
        models.forEach((model, index) => {
            const name = model.name || model.model;
            const size = model.size ? formatSize(model.size) : 'N/A';
            const current = name === config.get('ollamaModel') ? chalk.green(' ← actual') : '';
            console.log(chalk.white(`   ${index + 1}. ${chalk.yellow(name)} ${chalk.gray(`(${size})`)}${current}`));
        });
        console.log();
        
    } catch (error) {
        spinner.fail('Error al conectar con Ollama');
        console.log(chalk.red(`\n❌ ${error.message}`));
        console.log(chalk.white('   Asegúrate de que Ollama esté corriendo.\n'));
    }
}

function formatSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

async function setModel(modelName) {
    const spinner = ora('Verificando modelo...').start();
    
    try {
        const models = await getAvailableModels();
        const modelNames = models.map(m => m.name || m.model);
        
        const exactMatch = modelNames.find(name => name === modelName);
        const partialMatch = modelNames.find(name => name.startsWith(modelName + ':') || name.split(':')[0] === modelName);
        
        if (exactMatch) {
            config.set('ollamaModel', exactMatch);
            spinner.succeed(`Modelo establecido a: ${chalk.yellow(exactMatch)}`);
        } else if (partialMatch) {
            config.set('ollamaModel', partialMatch);
            spinner.succeed(`Modelo establecido a: ${chalk.yellow(partialMatch)}`);
        } else {
            spinner.fail('Modelo no encontrado');
            console.log(chalk.red(`\n❌ El modelo "${modelName}" no está disponible.\n`));
            console.log(chalk.cyan('📦 Modelos disponibles:'));
            modelNames.forEach(name => {
                console.log(chalk.white(`   • ${chalk.yellow(name)}`));
            });
            console.log();
            process.exit(1);
        }
        
    } catch (error) {
        spinner.fail('Error al verificar modelo');
        console.log(chalk.red(`\n❌ ${error.message}`));
        process.exit(1);
    }
}

async function changeModelInteractive() {
    const spinner = ora('Obteniendo modelos disponibles...').start();
    
    try {
        const models = await getAvailableModels();
        spinner.stop();
        
        if (models.length === 0) {
            console.log(chalk.yellow('\n⚠️  No hay modelos instalados en Ollama.\n'));
            return;
        }
        
        const currentModel = config.get('ollamaModel');
        const choices = models.map(model => {
            const name = model.name || model.model;
            const size = model.size ? formatSize(model.size) : '';
            const isCurrent = name === currentModel;
            return {
                name: `${name} ${chalk.gray(size)}${isCurrent ? chalk.green(' ← actual') : ''}`,
                value: name,
                short: name
            };
        });
        
        const { selectedModel } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedModel',
                message: 'Selecciona el modelo:',
                choices,
                default: currentModel
            }
        ]);
        
        config.set('ollamaModel', selectedModel);
        console.log(chalk.green(`\n✅ Modelo cambiado a: ${chalk.yellow(selectedModel)}`));
        
    } catch (error) {
        spinner.fail('Error al obtener modelos');
        console.log(chalk.red(`\n❌ ${error.message}`));
        console.log(chalk.white('   Asegúrate de que Ollama esté corriendo.\n'));
    }
}

// ============================================
// FLUJO PRINCIPAL
// ============================================

async function generatePRDescription(baseBranch, outputDir, dryRun) {
    console.log(chalk.cyan('\n🔍 Analizando diferencias con la rama base...\n'));
    
    // Fetch para asegurar que tenemos la última versión
    const fetchSpinner = ora('Obteniendo últimos cambios de origin...').start();
    try {
        execSync('git fetch origin', { stdio: 'pipe' });
        fetchSpinner.succeed('Repositorio actualizado');
    } catch {
        fetchSpinner.warn('No se pudo hacer fetch (continuando con datos locales)');
    }
    
    const diffData = getBranchDiff(baseBranch);
    
    if (!diffData) {
        console.log(chalk.yellow('⚠️  No hay diferencias con la rama base.'));
        console.log(chalk.white(`   Tu rama está al día con ${baseBranch}.\n`));
        process.exit(0);
    }
    
    const commits = getCommitsList(baseBranch);
    const changedFiles = getChangedFiles(baseBranch);
    const stats = getFilesStats(baseBranch);
    
    // Filtrar archivos excluidos para mostrar
    const includedFiles = changedFiles.filter(f => !f.excluded);
    const excludedFiles = changedFiles.filter(f => f.excluded);
    
    console.log(chalk.white(`📌 Rama actual: ${chalk.yellow(diffData.currentBranch)}`));
    console.log(chalk.white(`📌 Rama base:   ${chalk.yellow(diffData.baseBranch)}`));
    console.log(chalk.white(`📝 Commits:     ${chalk.yellow(commits.length)}`));
    console.log(chalk.white(`📁 Archivos:    ${chalk.yellow(includedFiles.length)} ${excludedFiles.length > 0 ? chalk.gray(`(${excludedFiles.length} excluidos)`) : ''}`));
    console.log();
    
    // Mostrar archivos cambiados
    console.log(chalk.white('📁 Archivos modificados:'));
    includedFiles.slice(0, 10).forEach(f => {
        const statusColor = f.status === 'added' ? chalk.green : 
                           f.status === 'deleted' ? chalk.red : chalk.yellow;
        console.log(chalk.gray(`   ${statusColor(`[${f.statusCode}]`)} ${f.file}`));
    });
    if (includedFiles.length > 10) {
        console.log(chalk.gray(`   ... y ${includedFiles.length - 10} archivos más`));
    }
    
    // Mostrar archivos excluidos
    if (excludedFiles.length > 0) {
        console.log(chalk.gray(`\n🚫 Excluidos del análisis (${excludedFiles.length}):`));
        excludedFiles.slice(0, 5).forEach(f => {
            console.log(chalk.gray(`   • ${f.file}`));
        });
        if (excludedFiles.length > 5) {
            console.log(chalk.gray(`   ... y ${excludedFiles.length - 5} más`));
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
            text: `Generando descripción con ${chalk.yellow(config.get('ollamaModel'))}...`,
            spinner: 'dots'
        }).start();
        
        let prDescription;
        try {
            prDescription = await generatePRDescriptionText(context);
            spinner.succeed('Descripción generada');
        } catch (error) {
            spinner.fail('Error al generar descripción');
            console.log(chalk.red(`\n❌ ${error.message}`));
            console.log(chalk.white('   Verifica que Ollama esté corriendo y el modelo disponible.\n'));
            process.exit(1);
        }
        
        console.log(chalk.cyan('\n📝 Descripción del PR propuesta:\n'));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(prDescription);
        console.log(chalk.gray('─'.repeat(60)));
        console.log();
        
        const choices = [
            { name: chalk.green('✅ Aceptar y guardar archivo'), value: 'accept' },
            { name: chalk.yellow('🔄 Generar otra descripción'), value: 'regenerate' },
            { name: chalk.blue('✏️  Editar título manualmente'), value: 'edit' },
            new inquirer.Separator(),
            { name: chalk.magenta('🤖 Cambiar modelo'), value: 'change-model' },
            new inquirer.Separator(),
            { name: chalk.red('❌ Cancelar'), value: 'cancel' }
        ];
        
        if (dryRun) {
            choices[0] = { name: chalk.green('✅ Aceptar (dry-run, no se guardará)'), value: 'accept' };
        }
        
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: '¿Qué deseas hacer?',
                choices
            }
        ]);
        
        switch (action) {
            case 'accept':
                if (dryRun) {
                    console.log(chalk.yellow('\n🏃 Dry-run: descripción NO guardada.\n'));
                } else {
                    const saveSpinner = ora('Guardando archivo...').start();
                    try {
                        const filePath = savePRDescription(prDescription, diffData.currentBranch, outputDir);
                        saveSpinner.succeed(`Archivo guardado: ${chalk.green(filePath)}`);
                        console.log(chalk.cyan('\n💡 Tip: Puedes copiar el contenido del archivo para tu PR.\n'));
                    } catch (error) {
                        saveSpinner.fail('Error al guardar archivo');
                        console.log(chalk.red(`\n❌ ${error.message}\n`));
                    }
                }
                continueLoop = false;
                break;
                
            case 'regenerate':
                console.log(chalk.cyan('\n🔄 Generando nueva descripción...\n'));
                break;
                
            case 'edit':
                const { editedTitle } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'editedTitle',
                        message: 'Edita el título del PR:',
                        default: diffData.currentBranch.replace(/[-_]/g, ' ')
                    }
                ]);
                
                // Reemplazar título en el markdown
                const finalDescription = prDescription.replace(/^# .+$/m, `# ${editedTitle}`);
                
                if (!dryRun) {
                    const editSaveSpinner = ora('Guardando archivo...').start();
                    try {
                        const filePath = savePRDescription(finalDescription, diffData.currentBranch, outputDir);
                        editSaveSpinner.succeed(`Archivo guardado: ${chalk.green(filePath)}`);
                    } catch (error) {
                        editSaveSpinner.fail('Error al guardar archivo');
                        console.log(chalk.red(`\n❌ ${error.message}\n`));
                    }
                } else {
                    console.log(chalk.yellow('\n🏃 Dry-run: descripción NO guardada.\n'));
                }
                continueLoop = false;
                break;
                
            case 'change-model':
                await changeModelInteractive();
                console.log(chalk.cyan('\n🔄 Regenerando descripción con nuevo modelo...\n'));
                break;
                
            case 'cancel':
                console.log(chalk.yellow('\n👋 Operación cancelada.\n'));
                continueLoop = false;
                break;
        }
    }
}