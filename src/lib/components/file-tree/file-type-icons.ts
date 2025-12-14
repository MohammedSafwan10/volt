/**
 * VS Code-style file type icon mapping using Iconify vscode-icons
 * Maps file extensions and special filenames to their corresponding icons
 */

/** Icon definition with name and optional color override */
export interface FileTypeIcon {
  /** Iconify icon name (vscode-icons collection) */
  icon: string;
}

/** Special filename mappings (exact match, case-insensitive) */
const SPECIAL_FILES: Record<string, FileTypeIcon> = {
  // Package managers
  'package.json': { icon: 'vscode-icons:file-type-node' },
  'package-lock.json': { icon: 'vscode-icons:file-type-npm' },
  'yarn.lock': { icon: 'vscode-icons:file-type-yarn' },
  'pnpm-lock.yaml': { icon: 'vscode-icons:file-type-pnpm' },
  'bun.lockb': { icon: 'vscode-icons:file-type-bun' },
  
  // Config files
  'tsconfig.json': { icon: 'vscode-icons:file-type-tsconfig' },
  'jsconfig.json': { icon: 'vscode-icons:file-type-jsconfig' },
  'vite.config.js': { icon: 'vscode-icons:file-type-vite' },
  'vite.config.ts': { icon: 'vscode-icons:file-type-vite' },
  'svelte.config.js': { icon: 'vscode-icons:file-type-svelte' },
  'svelte.config.ts': { icon: 'vscode-icons:file-type-svelte' },
  'tailwind.config.js': { icon: 'vscode-icons:file-type-tailwind' },
  'tailwind.config.ts': { icon: 'vscode-icons:file-type-tailwind' },
  'postcss.config.js': { icon: 'vscode-icons:file-type-postcss' },
  'postcss.config.cjs': { icon: 'vscode-icons:file-type-postcss' },
  'webpack.config.js': { icon: 'vscode-icons:file-type-webpack' },
  'rollup.config.js': { icon: 'vscode-icons:file-type-rollup' },
  'babel.config.js': { icon: 'vscode-icons:file-type-babel' },
  '.babelrc': { icon: 'vscode-icons:file-type-babel' },
  'eslint.config.js': { icon: 'vscode-icons:file-type-eslint' },
  'eslint.config.mjs': { icon: 'vscode-icons:file-type-eslint' },
  '.eslintrc': { icon: 'vscode-icons:file-type-eslint' },
  '.eslintrc.js': { icon: 'vscode-icons:file-type-eslint' },
  '.eslintrc.json': { icon: 'vscode-icons:file-type-eslint' },
  '.eslintrc.cjs': { icon: 'vscode-icons:file-type-eslint' },
  '.prettierrc': { icon: 'vscode-icons:file-type-prettier' },
  '.prettierrc.json': { icon: 'vscode-icons:file-type-prettier' },
  'prettier.config.js': { icon: 'vscode-icons:file-type-prettier' },
  
  // Git
  '.gitignore': { icon: 'vscode-icons:file-type-git' },
  '.gitattributes': { icon: 'vscode-icons:file-type-git' },
  '.gitmodules': { icon: 'vscode-icons:file-type-git' },
  
  // Environment
  '.env': { icon: 'vscode-icons:file-type-dotenv' },
  '.env.local': { icon: 'vscode-icons:file-type-dotenv' },
  '.env.development': { icon: 'vscode-icons:file-type-dotenv' },
  '.env.production': { icon: 'vscode-icons:file-type-dotenv' },
  '.env.example': { icon: 'vscode-icons:file-type-dotenv' },
  
  // Docker
  'dockerfile': { icon: 'vscode-icons:file-type-docker' },
  'docker-compose.yml': { icon: 'vscode-icons:file-type-docker' },
  'docker-compose.yaml': { icon: 'vscode-icons:file-type-docker' },
  '.dockerignore': { icon: 'vscode-icons:file-type-docker' },

  // Documentation
  'readme.md': { icon: 'vscode-icons:file-type-readme' },
  'readme': { icon: 'vscode-icons:file-type-readme' },
  'license': { icon: 'vscode-icons:file-type-license' },
  'license.md': { icon: 'vscode-icons:file-type-license' },
  'license.txt': { icon: 'vscode-icons:file-type-license' },
  'changelog.md': { icon: 'vscode-icons:file-type-changelog' },
  'contributing.md': { icon: 'vscode-icons:file-type-contributing' },
  
  // Rust
  'cargo.toml': { icon: 'vscode-icons:file-type-cargo' },
  'cargo.lock': { icon: 'vscode-icons:file-type-cargo' },
  
  // Editor config
  '.editorconfig': { icon: 'vscode-icons:file-type-editorconfig' },
  
  // Vercel/Netlify
  'vercel.json': { icon: 'vscode-icons:file-type-vercel' },
  'netlify.toml': { icon: 'vscode-icons:file-type-netlify' },
  
  // Testing
  'jest.config.js': { icon: 'vscode-icons:file-type-jest' },
  'jest.config.ts': { icon: 'vscode-icons:file-type-jest' },
  'vitest.config.js': { icon: 'vscode-icons:file-type-vitest' },
  'vitest.config.ts': { icon: 'vscode-icons:file-type-vitest' },
  'playwright.config.ts': { icon: 'vscode-icons:file-type-playwright' },
  'cypress.config.js': { icon: 'vscode-icons:file-type-cypress' },
  'cypress.config.ts': { icon: 'vscode-icons:file-type-cypress' },
};

/** Extension mappings */
const EXTENSION_ICONS: Record<string, FileTypeIcon> = {
  // TypeScript
  ts: { icon: 'vscode-icons:file-type-typescript' },
  tsx: { icon: 'vscode-icons:file-type-reactts' },
  mts: { icon: 'vscode-icons:file-type-typescript' },
  cts: { icon: 'vscode-icons:file-type-typescript' },
  'd.ts': { icon: 'vscode-icons:file-type-typescriptdef' },
  
  // JavaScript
  js: { icon: 'vscode-icons:file-type-js' },
  jsx: { icon: 'vscode-icons:file-type-reactjs' },
  mjs: { icon: 'vscode-icons:file-type-js' },
  cjs: { icon: 'vscode-icons:file-type-js' },
  
  // Web frameworks
  svelte: { icon: 'vscode-icons:file-type-svelte' },
  vue: { icon: 'vscode-icons:file-type-vue' },
  astro: { icon: 'vscode-icons:file-type-astro' },
  
  // Markup
  html: { icon: 'vscode-icons:file-type-html' },
  htm: { icon: 'vscode-icons:file-type-html' },
  
  // Styles
  css: { icon: 'vscode-icons:file-type-css' },
  scss: { icon: 'vscode-icons:file-type-scss' },
  sass: { icon: 'vscode-icons:file-type-sass' },
  less: { icon: 'vscode-icons:file-type-less' },
  styl: { icon: 'vscode-icons:file-type-stylus' },
  
  // Data formats
  json: { icon: 'vscode-icons:file-type-json' },
  jsonc: { icon: 'vscode-icons:file-type-json' },
  json5: { icon: 'vscode-icons:file-type-json5' },
  yaml: { icon: 'vscode-icons:file-type-yaml' },
  yml: { icon: 'vscode-icons:file-type-yaml' },
  toml: { icon: 'vscode-icons:file-type-toml' },
  xml: { icon: 'vscode-icons:file-type-xml' },
  csv: { icon: 'vscode-icons:file-type-csv' },
  
  // Markdown
  md: { icon: 'vscode-icons:file-type-markdown' },
  mdx: { icon: 'vscode-icons:file-type-mdx' },
  txt: { icon: 'vscode-icons:file-type-text' },
  
  // Images
  png: { icon: 'vscode-icons:file-type-image' },
  jpg: { icon: 'vscode-icons:file-type-image' },
  jpeg: { icon: 'vscode-icons:file-type-image' },
  gif: { icon: 'vscode-icons:file-type-image' },
  webp: { icon: 'vscode-icons:file-type-image' },
  ico: { icon: 'vscode-icons:file-type-favicon' },
  svg: { icon: 'vscode-icons:file-type-svg' },
  bmp: { icon: 'vscode-icons:file-type-image' },
  
  // Fonts
  woff: { icon: 'vscode-icons:file-type-font' },
  woff2: { icon: 'vscode-icons:file-type-font' },
  ttf: { icon: 'vscode-icons:file-type-font' },
  otf: { icon: 'vscode-icons:file-type-font' },
  eot: { icon: 'vscode-icons:file-type-font' },

  // Archives
  zip: { icon: 'vscode-icons:file-type-zip' },
  tar: { icon: 'vscode-icons:file-type-zip' },
  gz: { icon: 'vscode-icons:file-type-zip' },
  rar: { icon: 'vscode-icons:file-type-zip' },
  '7z': { icon: 'vscode-icons:file-type-zip' },
  
  // Shell
  sh: { icon: 'vscode-icons:file-type-shell' },
  bash: { icon: 'vscode-icons:file-type-shell' },
  zsh: { icon: 'vscode-icons:file-type-shell' },
  fish: { icon: 'vscode-icons:file-type-shell' },
  ps1: { icon: 'vscode-icons:file-type-powershell' },
  bat: { icon: 'vscode-icons:file-type-bat' },
  cmd: { icon: 'vscode-icons:file-type-bat' },
  
  // Other languages
  rs: { icon: 'vscode-icons:file-type-rust' },
  py: { icon: 'vscode-icons:file-type-python' },
  pyw: { icon: 'vscode-icons:file-type-python' },
  go: { icon: 'vscode-icons:file-type-go' },
  java: { icon: 'vscode-icons:file-type-java' },
  c: { icon: 'vscode-icons:file-type-c' },
  cpp: { icon: 'vscode-icons:file-type-cpp' },
  h: { icon: 'vscode-icons:file-type-cheader' },
  hpp: { icon: 'vscode-icons:file-type-cppheader' },
  cs: { icon: 'vscode-icons:file-type-csharp' },
  php: { icon: 'vscode-icons:file-type-php' },
  rb: { icon: 'vscode-icons:file-type-ruby' },
  swift: { icon: 'vscode-icons:file-type-swift' },
  kt: { icon: 'vscode-icons:file-type-kotlin' },
  dart: { icon: 'vscode-icons:file-type-dart' },
  
  // Database
  sql: { icon: 'vscode-icons:file-type-sql' },
  db: { icon: 'vscode-icons:file-type-sql' },
  sqlite: { icon: 'vscode-icons:file-type-sqlite' },
  
  // GraphQL
  graphql: { icon: 'vscode-icons:file-type-graphql' },
  gql: { icon: 'vscode-icons:file-type-graphql' },
  
  // Lock files
  lock: { icon: 'vscode-icons:file-type-lock' },
  
  // Logs
  log: { icon: 'vscode-icons:file-type-log' },
  
  // PDF/Docs
  pdf: { icon: 'vscode-icons:file-type-pdf' },
  doc: { icon: 'vscode-icons:file-type-word' },
  docx: { icon: 'vscode-icons:file-type-word' },
  xls: { icon: 'vscode-icons:file-type-excel' },
  xlsx: { icon: 'vscode-icons:file-type-excel' },
  
  // Video/Audio
  mp3: { icon: 'vscode-icons:file-type-audio' },
  wav: { icon: 'vscode-icons:file-type-audio' },
  ogg: { icon: 'vscode-icons:file-type-audio' },
  mp4: { icon: 'vscode-icons:file-type-video' },
  webm: { icon: 'vscode-icons:file-type-video' },
  mov: { icon: 'vscode-icons:file-type-video' },
};

/** Special folder name mappings */
const FOLDER_ICONS: Record<string, { closed: string; open: string }> = {
  src: { closed: 'vscode-icons:folder-type-src', open: 'vscode-icons:folder-type-src-opened' },
  source: { closed: 'vscode-icons:folder-type-src', open: 'vscode-icons:folder-type-src-opened' },
  lib: { closed: 'vscode-icons:folder-type-library', open: 'vscode-icons:folder-type-library-opened' },
  dist: { closed: 'vscode-icons:folder-type-dist', open: 'vscode-icons:folder-type-dist-opened' },
  build: { closed: 'vscode-icons:folder-type-dist', open: 'vscode-icons:folder-type-dist-opened' },
  out: { closed: 'vscode-icons:folder-type-dist', open: 'vscode-icons:folder-type-dist-opened' },
  node_modules: { closed: 'vscode-icons:folder-type-node', open: 'vscode-icons:folder-type-node-opened' },
  components: { closed: 'vscode-icons:folder-type-component', open: 'vscode-icons:folder-type-component-opened' },
  pages: { closed: 'vscode-icons:folder-type-view', open: 'vscode-icons:folder-type-view-opened' },
  views: { closed: 'vscode-icons:folder-type-view', open: 'vscode-icons:folder-type-view-opened' },
  routes: { closed: 'vscode-icons:folder-type-route', open: 'vscode-icons:folder-type-route-opened' },
  api: { closed: 'vscode-icons:folder-type-api', open: 'vscode-icons:folder-type-api-opened' },
  public: { closed: 'vscode-icons:folder-type-public', open: 'vscode-icons:folder-type-public-opened' },
  static: { closed: 'vscode-icons:folder-type-public', open: 'vscode-icons:folder-type-public-opened' },
  assets: { closed: 'vscode-icons:folder-type-asset', open: 'vscode-icons:folder-type-asset-opened' },
  images: { closed: 'vscode-icons:folder-type-images', open: 'vscode-icons:folder-type-images-opened' },
  img: { closed: 'vscode-icons:folder-type-images', open: 'vscode-icons:folder-type-images-opened' },
  icons: { closed: 'vscode-icons:folder-type-images', open: 'vscode-icons:folder-type-images-opened' },
  styles: { closed: 'vscode-icons:folder-type-style', open: 'vscode-icons:folder-type-style-opened' },
  css: { closed: 'vscode-icons:folder-type-style', open: 'vscode-icons:folder-type-style-opened' },
  scss: { closed: 'vscode-icons:folder-type-sass', open: 'vscode-icons:folder-type-sass-opened' },

  scripts: { closed: 'vscode-icons:folder-type-script', open: 'vscode-icons:folder-type-script-opened' },
  utils: { closed: 'vscode-icons:folder-type-helper', open: 'vscode-icons:folder-type-helper-opened' },
  helpers: { closed: 'vscode-icons:folder-type-helper', open: 'vscode-icons:folder-type-helper-opened' },
  hooks: { closed: 'vscode-icons:folder-type-hook', open: 'vscode-icons:folder-type-hook-opened' },
  stores: { closed: 'vscode-icons:folder-type-state', open: 'vscode-icons:folder-type-state-opened' },
  store: { closed: 'vscode-icons:folder-type-state', open: 'vscode-icons:folder-type-state-opened' },
  state: { closed: 'vscode-icons:folder-type-state', open: 'vscode-icons:folder-type-state-opened' },
  types: { closed: 'vscode-icons:folder-type-typings', open: 'vscode-icons:folder-type-typings-opened' },
  typings: { closed: 'vscode-icons:folder-type-typings', open: 'vscode-icons:folder-type-typings-opened' },
  '@types': { closed: 'vscode-icons:folder-type-typings', open: 'vscode-icons:folder-type-typings-opened' },
  config: { closed: 'vscode-icons:folder-type-config', open: 'vscode-icons:folder-type-config-opened' },
  configs: { closed: 'vscode-icons:folder-type-config', open: 'vscode-icons:folder-type-config-opened' },
  test: { closed: 'vscode-icons:folder-type-test', open: 'vscode-icons:folder-type-test-opened' },
  tests: { closed: 'vscode-icons:folder-type-test', open: 'vscode-icons:folder-type-test-opened' },
  __tests__: { closed: 'vscode-icons:folder-type-test', open: 'vscode-icons:folder-type-test-opened' },
  spec: { closed: 'vscode-icons:folder-type-test', open: 'vscode-icons:folder-type-test-opened' },
  specs: { closed: 'vscode-icons:folder-type-test', open: 'vscode-icons:folder-type-test-opened' },
  docs: { closed: 'vscode-icons:folder-type-docs', open: 'vscode-icons:folder-type-docs-opened' },
  documentation: { closed: 'vscode-icons:folder-type-docs', open: 'vscode-icons:folder-type-docs-opened' },
  '.git': { closed: 'vscode-icons:folder-type-git', open: 'vscode-icons:folder-type-git-opened' },
  '.github': { closed: 'vscode-icons:folder-type-github', open: 'vscode-icons:folder-type-github-opened' },
  '.vscode': { closed: 'vscode-icons:folder-type-vscode', open: 'vscode-icons:folder-type-vscode-opened' },
  '.svelte-kit': { closed: 'vscode-icons:folder-type-svelte', open: 'vscode-icons:folder-type-svelte-opened' },
  services: { closed: 'vscode-icons:folder-type-services', open: 'vscode-icons:folder-type-services-opened' },
  middleware: { closed: 'vscode-icons:folder-type-middleware', open: 'vscode-icons:folder-type-middleware-opened' },
  models: { closed: 'vscode-icons:folder-type-model', open: 'vscode-icons:folder-type-model-opened' },
  layouts: { closed: 'vscode-icons:folder-type-layout', open: 'vscode-icons:folder-type-layout-opened' },
  templates: { closed: 'vscode-icons:folder-type-template', open: 'vscode-icons:folder-type-template-opened' },
  plugins: { closed: 'vscode-icons:folder-type-plugin', open: 'vscode-icons:folder-type-plugin-opened' },
  locales: { closed: 'vscode-icons:folder-type-locale', open: 'vscode-icons:folder-type-locale-opened' },
  i18n: { closed: 'vscode-icons:folder-type-locale', open: 'vscode-icons:folder-type-locale-opened' },
  themes: { closed: 'vscode-icons:folder-type-theme', open: 'vscode-icons:folder-type-theme-opened' },
  fonts: { closed: 'vscode-icons:folder-type-font', open: 'vscode-icons:folder-type-font-opened' },
  vendor: { closed: 'vscode-icons:folder-type-vendor', open: 'vscode-icons:folder-type-vendor-opened' },
  bin: { closed: 'vscode-icons:folder-type-binary', open: 'vscode-icons:folder-type-binary-opened' },
  binaries: { closed: 'vscode-icons:folder-type-binary', open: 'vscode-icons:folder-type-binary-opened' },
  target: { closed: 'vscode-icons:folder-type-dist', open: 'vscode-icons:folder-type-dist-opened' },
};

/** Default icons */
const DEFAULT_FILE_ICON = 'vscode-icons:default-file';
const DEFAULT_FOLDER_CLOSED = 'vscode-icons:default-folder';
const DEFAULT_FOLDER_OPEN = 'vscode-icons:default-folder-opened';

/**
 * Get the icon name for a file based on its filename
 */
export function getFileIcon(filename: string): string {
  const lower = filename.toLowerCase();
  
  // Check special files first (exact match)
  if (SPECIAL_FILES[lower]) {
    return SPECIAL_FILES[lower].icon;
  }
  
  // Check for .d.ts files
  if (lower.endsWith('.d.ts')) {
    return EXTENSION_ICONS['d.ts'].icon;
  }
  
  // Get extension
  const ext = lower.includes('.') ? lower.split('.').pop() || '' : '';
  
  // Check extension mapping
  if (ext && EXTENSION_ICONS[ext]) {
    return EXTENSION_ICONS[ext].icon;
  }
  
  return DEFAULT_FILE_ICON;
}

/**
 * Get the icon name for a folder based on its name and state
 */
export function getFolderIcon(folderName: string, isOpen: boolean): string {
  const lower = folderName.toLowerCase();
  
  if (FOLDER_ICONS[lower]) {
    return isOpen ? FOLDER_ICONS[lower].open : FOLDER_ICONS[lower].closed;
  }
  
  return isOpen ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER_CLOSED;
}

/**
 * Get the icon name for a file or folder
 */
export function getNodeIcon(name: string, isDir: boolean, isOpen = false): string {
  return isDir ? getFolderIcon(name, isOpen) : getFileIcon(name);
}
