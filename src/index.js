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

const config = new Conf({
    projectName: 'mkpr',
    defaults: {
        ollamaPort: 11434,
        ollamaModel: 'llama3.2',
        baseBranch: 'main',
        outputDir: '.'
    }
});

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

            // Configuraciones persistentes
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

            // Si solo se están configurando opciones, salir
            if (options.setPort || options.setModel || options.setBase || options.setOutput) {
                return;
            }

            // Opciones temporales para esta ejecución
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

function showConfig() {
    console.log(chalk.cyan('\n📋 Configuración actual:\n'));
    console.log(chalk.white(`   Puerto Ollama:     ${chalk.yellow(config.get('ollamaPort'))}`));
    console.log(chalk.white(`   Modelo:            ${chalk.yellow(config.get('ollamaModel'))}`));
    console.log(chalk.white(`   Rama base:         ${chalk.yellow(config.get('baseBranch'))}`));
    console.log(chalk.white(`   Directorio salida: ${chalk.yellow(config.get('outputDir'))}`));
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

function getCurrentBranch() {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    } catch (error) {
        throw new Error('No se pudo obtener la rama actual.');
    }
}

function getRemoteBaseBranch(baseBranch) {
    try {
        // Verificar si existe origin/baseBranch
        execSync(`git rev-parse origin/${baseBranch}`, { stdio: 'pipe' });
        return `origin/${baseBranch}`;
    } catch {
        // Intentar con solo baseBranch local
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
        
        // Obtener el diff entre la rama base y la actual
        const diff = execSync(`git diff ${remoteBranch}...HEAD --no-color`, { 
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 10 // 10MB
        });
        
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
        const files = execSync(`git diff ${remoteBranch}...HEAD --name-status`, { 
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024
        });
        return files.trim().split('\n').filter(f => f).map(line => {
            const [status, ...fileParts] = line.split('\t');
            const file = fileParts.join('\t');
            const statusMap = { 'A': 'added', 'M': 'modified', 'D': 'deleted', 'R': 'renamed' };
            return { status: statusMap[status[0]] || status, file };
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

async function generatePRDescriptionText(context) {
    const port = config.get('ollamaPort');
    const model = config.get('ollamaModel');
    
    const prompt = `Eres un experto en escribir descripciones de Pull Requests claras y profesionales.

Genera una descripción de PR en formato Markdown basándote en el siguiente contexto:

**Rama actual:** ${context.currentBranch}
**Rama base:** ${context.baseBranch}

**Commits incluidos:**
${context.commits.map(c => `- ${c}`).join('\n')}

**Archivos modificados:**
${context.changedFiles.map(f => `- [${f.status}] ${f.file}`).join('\n')}

**Estadísticas:**
${context.stats}

**Diff (primeros 6000 caracteres):**
\`\`\`
${context.diff.substring(0, 6000)}
\`\`\`

Genera la descripción del PR con las siguientes secciones en Markdown:

## Descripción
(Resumen claro de qué hace este PR y por qué)

## Cambios realizados
(Lista de los cambios principales)

## Tipo de cambio
(Indica si es: feature, fix, refactor, docs, test, chore)

## Checklist
- [ ] El código sigue los estándares del proyecto
- [ ] Se han añadido tests (si aplica)
- [ ] La documentación ha sido actualizada (si aplica)

Escribe la descripción en español, siendo conciso pero completo. No incluyas el diff en la salida.`;

    const response = await fetch(`http://localhost:${port}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.4,
                num_predict: 1500
            }
        })
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error de Ollama: ${errorText}`);
    }
    
    const data = await response.json();
    return data.response.trim();
}

function sanitizeBranchName(branchName) {
    return branchName.replace(/[\/\\:*?"<>|]/g, '_');
}

function savePRDescription(content, branchName, outputDir) {
    const sanitizedName = sanitizeBranchName(branchName);
    const fileName = `${sanitizedName}_pr.md`;
    const filePath = path.join(outputDir, fileName);
    
    // Crear directorio si no existe
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

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
    
    console.log(chalk.white(`📌 Rama actual: ${chalk.yellow(diffData.currentBranch)}`));
    console.log(chalk.white(`📌 Rama base:   ${chalk.yellow(diffData.baseBranch)}`));
    console.log(chalk.white(`📝 Commits:     ${chalk.yellow(commits.length)}`));
    console.log(chalk.white(`📁 Archivos:    ${chalk.yellow(changedFiles.length)}`));
    console.log();
    
    // Mostrar archivos cambiados
    console.log(chalk.white('📁 Archivos modificados:'));
    changedFiles.slice(0, 10).forEach(f => {
        const statusColor = f.status === 'added' ? chalk.green : 
                           f.status === 'deleted' ? chalk.red : chalk.yellow;
        console.log(chalk.gray(`   ${statusColor(`[${f.status[0].toUpperCase()}]`)} ${f.file}`));
    });
    if (changedFiles.length > 10) {
        console.log(chalk.gray(`   ... y ${changedFiles.length - 10} archivos más`));
    }
    console.log();
    
    const context = {
        currentBranch: diffData.currentBranch,
        baseBranch: diffData.baseBranch,
        diff: diffData.diff,
        commits,
        changedFiles,
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
                // Extraer y editar solo el título/primera línea
                const firstLine = prDescription.split('\n').find(l => l.startsWith('## Descripción'));
                const { editedTitle } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'editedTitle',
                        message: 'Edita el título del PR:',
                        default: diffData.currentBranch.replace(/[-_]/g, ' ')
                    }
                ]);
                
                // Agregar título editado al inicio
                const finalDescription = `# ${editedTitle}\n\n${prDescription}`;
                
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
                
            case 'cancel':
                console.log(chalk.yellow('\n👋 Operación cancelada.\n'));
                continueLoop = false;
                break;
        }
    }
}
