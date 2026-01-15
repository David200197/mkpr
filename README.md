# mkpr 🚀

CLI para generar descripciones de Pull Request automáticamente usando **Ollama** con IA local.

## Características

- ✨ Genera descripciones de PR completas y profesionales
- 🔍 Compara tu rama actual contra la rama base (origin/main por defecto)
- 📝 Guarda la descripción en un archivo `{branch_name}_pr.md`
- 🤖 Usa modelos de IA locales a través de **Ollama**
- 🎨 Interfaz interactiva con colores y spinners
- ⚙️ Configuración persistente

## Instalación

### Desde el directorio del proyecto:

```bash
npm install -g .
```

### O ejecutar sin instalar:

```bash
node src/index.js
```

## Requisitos

- **Node.js** >= 14.0.0
- **Ollama** corriendo localmente
- Un modelo instalado en Ollama (ej: `ollama pull llama3.2`)
- Estar en un repositorio git con una rama diferente a la base

## Uso

### Generar descripción de PR

```bash
# Estando en tu feature branch
mkpr
```

### Opciones de ejecución

```bash
# Comparar contra una rama base diferente (solo esta ejecución)
mkpr -b develop

# Guardar en un directorio específico (solo esta ejecución)
mkpr -o ./docs/prs

# Solo ver la descripción sin guardar archivo
mkpr --dry-run

# Combinar opciones
mkpr -b develop -o ./prs --dry-run
```

### Configuración persistente

```bash
# Ver configuración actual
mkpr --show-config

# Cambiar el modelo de Ollama
mkpr --set-model llama3.1

# Cambiar el puerto de Ollama
mkpr --set-port 11434

# Cambiar la rama base por defecto
mkpr --set-base develop

# Cambiar el directorio de salida por defecto
mkpr --set-output ./docs/prs

# Listar modelos disponibles
mkpr --list-models

# Ver ayuda
mkpr --help
```

## Flujo de trabajo

1. Creas tu feature branch: `git checkout -b feature/nueva-funcionalidad`
2. Haces tus commits normalmente
3. Cuando estés listo para el PR, ejecutas: `mkpr`
4. El CLI:
   - Hace `git fetch origin` para actualizar
   - Compara tu rama contra `origin/main` (o la rama configurada)
   - Obtiene todos los commits, archivos cambiados y el diff
   - Genera una descripción usando IA
5. Puedes:
   - ✅ **Aceptar** y guardar el archivo
   - 🔄 **Regenerar** otra descripción
   - ✏️ **Editar** el título manualmente
   - ❌ **Cancelar** la operación

## Ejemplo de salida

El archivo generado `feature_nueva-funcionalidad_pr.md` contendrá:

```markdown
## Descripción
Este PR implementa la nueva funcionalidad de...

## Cambios realizados
- Añadido nuevo componente X
- Modificado servicio Y para soportar Z
- Actualizada documentación

## Tipo de cambio
feature

## Checklist
- [ ] El código sigue los estándares del proyecto
- [ ] Se han añadido tests (si aplica)
- [ ] La documentación ha sido actualizada (si aplica)
```

## Ejemplo de uso

```
$ mkpr

🔍 Analizando diferencias con la rama base...

✔ Repositorio actualizado
📌 Rama actual: feature/add-user-auth
📌 Rama base:   origin/main
📝 Commits:     5
📁 Archivos:    12

📁 Archivos modificados:
   [A] src/auth/AuthService.js
   [A] src/auth/AuthController.js
   [M] src/routes/index.js
   [M] package.json
   ... y 8 archivos más

- Generando descripción con llama3.2...
✔ Descripción generada

📝 Descripción del PR propuesta:
────────────────────────────────────────────────────────────
## Descripción
Este PR implementa el sistema de autenticación de usuarios...

## Cambios realizados
- Nuevo servicio de autenticación con JWT
- Endpoints de login y registro
- Middleware de validación de tokens
...
────────────────────────────────────────────────────────────

? ¿Qué deseas hacer? (Use arrow keys)
❯ ✅ Aceptar y guardar archivo
  🔄 Generar otra descripción
  ✏️  Editar título manualmente
  ❌ Cancelar

✔ Archivo guardado: ./feature_add-user-auth_pr.md

💡 Tip: Puedes copiar el contenido del archivo para tu PR.
```

## Configuración por defecto

| Opción | Valor por defecto |
|--------|-------------------|
| Puerto | `11434` |
| Modelo | `llama3.2` |
| Rama base | `main` |
| Directorio salida | `.` (directorio actual) |

## Tips

- El archivo se guarda con el nombre de la rama, reemplazando caracteres especiales
- Usa `--dry-run` para previsualizar sin crear archivos
- Si trabajas con `develop` como rama base, usa `mkpr --set-base develop` una vez
- Puedes regenerar la descripción tantas veces como quieras antes de aceptar

## Licencia

MIT
