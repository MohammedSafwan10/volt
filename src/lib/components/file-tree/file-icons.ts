/**
 * File type icons mapping
 * Returns appropriate emoji icons based on file extension or name
 */

// Extension to icon mapping
const extensionIcons: Record<string, string> = {
  // JavaScript/TypeScript
  js: '📜',
  mjs: '📜',
  cjs: '📜',
  jsx: '⚛️',
  ts: '📘',
  tsx: '⚛️',
  mts: '📘',
  cts: '📘',

  // Web
  html: '🌐',
  htm: '🌐',
  css: '🎨',
  scss: '🎨',
  sass: '🎨',
  less: '🎨',
  svg: '🖼️',

  // Frameworks
  svelte: '🔶',
  vue: '💚',
  astro: '🚀',

  // Data/Config
  json: '📋',
  yaml: '📋',
  yml: '📋',
  toml: '📋',
  xml: '📋',
  csv: '📊',

  // Markdown/Docs
  md: '📝',
  mdx: '📝',
  txt: '📄',
  rst: '📄',

  // Images
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  webp: '🖼️',
  ico: '🖼️',
  bmp: '🖼️',

  // Fonts
  woff: '🔤',
  woff2: '🔤',
  ttf: '🔤',
  otf: '🔤',
  eot: '🔤',

  // Rust
  rs: '🦀',

  // Python
  py: '🐍',
  pyw: '🐍',
  pyx: '🐍',

  // Go
  go: '🐹',

  // Ruby
  rb: '💎',
  erb: '💎',

  // PHP
  php: '🐘',

  // Java/Kotlin
  java: '☕',
  kt: '🟣',
  kts: '🟣',

  // C/C++
  c: '🔧',
  h: '🔧',
  cpp: '🔧',
  hpp: '🔧',
  cc: '🔧',
  cxx: '🔧',

  // C#
  cs: '🟢',

  // Shell
  sh: '🐚',
  bash: '🐚',
  zsh: '🐚',
  fish: '🐚',
  ps1: '🐚',
  bat: '🐚',
  cmd: '🐚',

  // Database
  sql: '🗃️',
  db: '🗃️',
  sqlite: '🗃️',

  // Lock files
  lock: '🔒',

  // Archives
  zip: '📦',
  tar: '📦',
  gz: '📦',
  rar: '📦',
  '7z': '📦',

  // Misc
  log: '📋',
  env: '🔐',
  gitignore: '🙈',
  dockerignore: '🐳',
  dockerfile: '🐳',
  makefile: '🔨',
  license: '📜'
};

// Special filename mappings (case-insensitive)
const filenameIcons: Record<string, string> = {
  'package.json': '📦',
  'package-lock.json': '🔒',
  'yarn.lock': '🔒',
  'pnpm-lock.yaml': '🔒',
  'bun.lockb': '🔒',
  'cargo.toml': '📦',
  'cargo.lock': '🔒',
  'go.mod': '📦',
  'go.sum': '🔒',
  'gemfile': '💎',
  'gemfile.lock': '🔒',
  'requirements.txt': '📋',
  'pipfile': '🐍',
  'pipfile.lock': '🔒',
  'composer.json': '📦',
  'composer.lock': '🔒',
  '.gitignore': '🙈',
  '.gitattributes': '🙈',
  '.gitmodules': '🙈',
  '.npmrc': '📦',
  '.nvmrc': '📦',
  '.prettierrc': '✨',
  '.prettierrc.json': '✨',
  '.prettierrc.js': '✨',
  '.prettierrc.cjs': '✨',
  '.eslintrc': '🔍',
  '.eslintrc.json': '🔍',
  '.eslintrc.js': '🔍',
  '.eslintrc.cjs': '🔍',
  'eslint.config.js': '🔍',
  'eslint.config.mjs': '🔍',
  '.editorconfig': '⚙️',
  'tsconfig.json': '📘',
  'jsconfig.json': '📜',
  'vite.config.js': '⚡',
  'vite.config.ts': '⚡',
  'svelte.config.js': '🔶',
  'svelte.config.ts': '🔶',
  'tailwind.config.js': '🎨',
  'tailwind.config.ts': '🎨',
  'postcss.config.js': '🎨',
  'postcss.config.cjs': '🎨',
  'webpack.config.js': '📦',
  'rollup.config.js': '📦',
  'dockerfile': '🐳',
  'docker-compose.yml': '🐳',
  'docker-compose.yaml': '🐳',
  '.dockerignore': '🐳',
  'makefile': '🔨',
  'cmakelists.txt': '🔨',
  'readme.md': '📖',
  'readme': '📖',
  'license': '📜',
  'license.md': '📜',
  'license.txt': '📜',
  'changelog.md': '📋',
  'changelog': '📋',
  '.env': '🔐',
  '.env.local': '🔐',
  '.env.development': '🔐',
  '.env.production': '🔐',
  '.env.example': '🔐',
  'vercel.json': '▲',
  'netlify.toml': '🌐',
  'tauri.conf.json': '🦀'
};

// Folder icons
const folderIcons: Record<string, string> = {
  src: '📁',
  lib: '📚',
  components: '🧩',
  pages: '📄',
  routes: '🛤️',
  api: '🔌',
  utils: '🔧',
  helpers: '🔧',
  hooks: '🪝',
  stores: '🗄️',
  types: '📘',
  styles: '🎨',
  assets: '🖼️',
  images: '🖼️',
  public: '🌐',
  static: '🌐',
  dist: '📦',
  build: '📦',
  out: '📦',
  node_modules: '📦',
  '.git': '🌿',
  '.github': '🐙',
  '.vscode': '💻',
  '.idea': '💡',
  test: '🧪',
  tests: '🧪',
  '__tests__': '🧪',
  spec: '🧪',
  docs: '📖',
  documentation: '📖',
  config: '⚙️',
  configs: '⚙️',
  scripts: '📜',
  bin: '⚙️',
  vendor: '📦',
  packages: '📦',
  'src-tauri': '🦀'
};

/**
 * Get icon for a file based on its name and extension
 */
export function getFileIcon(filename: string): string {
  const lowerName = filename.toLowerCase();

  // Check special filenames first
  if (filenameIcons[lowerName]) {
    return filenameIcons[lowerName];
  }

  // Get extension
  const lastDot = filename.lastIndexOf('.');
  if (lastDot !== -1) {
    const ext = filename.slice(lastDot + 1).toLowerCase();
    if (extensionIcons[ext]) {
      return extensionIcons[ext];
    }
  }

  // Default file icon
  return '📄';
}

/**
 * Get icon for a folder based on its name
 */
export function getFolderIcon(foldername: string, expanded: boolean): string {
  const lowerName = foldername.toLowerCase();

  // Check special folder names
  if (folderIcons[lowerName]) {
    return folderIcons[lowerName];
  }

  // Default folder icon
  return expanded ? '📂' : '📁';
}

/**
 * Get icon for a tree node (file or folder)
 */
export function getNodeIcon(name: string, isDir: boolean, expanded: boolean = false): string {
  if (isDir) {
    return getFolderIcon(name, expanded);
  }
  return getFileIcon(name);
}
