import React from 'react';

// --- File icon mappings ---

const EXTENSION_ICONS: Record<string, string> = {
  // TypeScript / JavaScript
  ts: 'typescript',
  tsx: 'react_ts',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'react',
  // Web
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'css',
  // Markup / Data
  md: 'markdown',
  mdx: 'markdown',
  xml: 'xml',
  svg: 'svg',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  // Languages
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  sql: 'database',
  // Shell
  sh: 'console',
  bash: 'console',
  zsh: 'console',
  // C# / Unity
  cs: 'csharp',
  shader: 'shader',
  hlsl: 'shader',
  glsl: 'shader',
  cginc: 'shader',
  compute: 'shader',
  unity: 'unity',
  prefab: 'unity',
  asset: 'unity',
  asmdef: 'unity',
  asmref: 'unity',
  controller: 'unity',
  mat: 'unity',
  physicMaterial: 'unity',
  physicsMaterial: 'unity',
  // Images
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  bmp: 'image',
  tga: 'image',
  psd: 'image',
  exr: 'image',
  hdr: 'image',
  // Fonts
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  // Config / misc
  env: 'document',
  lock: 'lock',
  log: 'log',
  txt: 'document',
};

const FILENAME_ICONS: Record<string, string> = {
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.env': 'document',
  '.env.local': 'document',
  '.env.development': 'document',
  '.env.production': 'document',
  'Dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'Makefile': 'makefile',
  'LICENSE': 'license',
  'README.md': 'readme',
  'package.json': 'npm',
  'package-lock.json': 'lock',
  'bun.lockb': 'lock',
  'bun.lock': 'lock',
  'tsconfig.json': 'tsconfig',
  'tsconfig.node.json': 'tsconfig',
  'vite.config.ts': 'vite',
  'vite.config.js': 'vite',
  'tailwind.config.js': 'tailwindcss',
  'tailwind.config.ts': 'tailwindcss',
  '.prettierrc': 'prettier',
  '.eslintrc': 'eslint',
  '.eslintrc.js': 'eslint',
  '.eslintrc.json': 'eslint',
  'eslint.config.js': 'eslint',
  'eslint.config.ts': 'eslint',
  'Cargo.toml': 'rust',
  'Cargo.lock': 'lock',
  'rust-toolchain.toml': 'rust',
};

function resolveFileIcon(filename: string): string {
  // Exact filename match
  const nameIcon = FILENAME_ICONS[filename];
  if (nameIcon) return nameIcon;

  // Extension match
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const extIcon = EXTENSION_ICONS[ext];
  if (extIcon) return extIcon;

  // Compound extensions
  const parts = filename.split('.');
  if (parts.length > 2) {
    const compoundExt = parts.slice(-2).join('.');
    if (compoundExt === 'd.ts') return 'typescript';
  }

  return 'document';
}

// --- Folder icon mappings ---

const FOLDER_ICONS: Record<string, string> = {
  // Unity folders
  assets: 'unity',
  scripts: 'scripts',
  prefabs: 'unity',
  scenes: 'unity',
  editor: 'config',
  plugins: 'plugin',
  resources: 'resource',
  shaders: 'shader',
  shader: 'shader',
  materials: 'resource',
  textures: 'images',
  animations: 'animation',
  streamingassets: 'resource',
  // Standard dev folders
  src: 'src',
  'src-tauri': 'src-tauri',
  lib: 'lib',
  dist: 'dist',
  build: 'dist',
  out: 'dist',
  public: 'public',
  components: 'components',
  features: 'features',
  hooks: 'hook',
  hook: 'hook',
  utils: 'utils',
  types: 'typescript',
  stores: 'store',
  store: 'store',
  config: 'config',
  docs: 'docs',
  test: 'test',
  tests: 'test',
  __tests__: 'test',
  node_modules: 'node',
  '.git': 'git',
  '.github': 'github',
  api: 'api',
  routes: 'routes',
  server: 'server',
  client: 'client',
  shared: 'shared',
  theme: 'theme',
  themes: 'theme',
  styles: 'css',
  css: 'css',
  images: 'images',
  img: 'images',
  fonts: 'font',
  audio: 'audio',
  video: 'video',
  database: 'database',
  db: 'database',
  docker: 'docker',
  templates: 'template',
  template: 'template',
  app: 'app',
  rust: 'rust',
  target: 'target',
  content: 'content',
  project: 'project',
};

function resolveFolderIcon(folderName: string, isOpen: boolean): string {
  const key = folderName.toLowerCase();
  const iconName = FOLDER_ICONS[key];
  if (iconName) {
    return isOpen ? `folder-${iconName}-open` : `folder-${iconName}`;
  }
  return isOpen ? 'folder-base-open' : 'folder-base';
}

// --- Exported functions ---

export function getFileIcon(filename: string, size = 16): React.ReactElement {
  const iconName = resolveFileIcon(filename);
  return (
    <img
      src={`/icons/files/${iconName}.svg`}
      width={size}
      height={size}
      alt=""
      title=""
      aria-hidden="true"
      style={{ flexShrink: 0, pointerEvents: 'none' }}
      draggable={false}
    />
  );
}

export function getFolderIcon(isOpen: boolean, size = 16, folderName?: string): React.ReactElement {
  const iconFile = resolveFolderIcon(folderName ?? '', isOpen);
  return (
    <img
      src={`/icons/folders/${iconFile}.svg`}
      width={size}
      height={size}
      alt=""
      title=""
      aria-hidden="true"
      style={{ flexShrink: 0, pointerEvents: 'none' }}
      draggable={false}
    />
  );
}
