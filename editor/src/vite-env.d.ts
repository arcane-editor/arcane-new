/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARCANE_API_URL?: string;
  readonly VITE_ARCANE_WEB_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
