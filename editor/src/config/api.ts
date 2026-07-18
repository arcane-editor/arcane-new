// Single source of truth for every backend endpoint the editor talks to.
// Values come from Vite env files (.env.development / .env.production,
// overridable via .env.development.local or shell env at build time).
// Fallbacks are the PRODUCTION endpoints so a build with missing env vars
// fails safe.
export const ARCANE_API_URL: string =
  import.meta.env.VITE_ARCANE_API_URL ?? 'https://api.arcaneai.org';

export const ARCANE_WEB_URL: string =
  import.meta.env.VITE_ARCANE_WEB_URL ?? 'https://arcaneai.org';
