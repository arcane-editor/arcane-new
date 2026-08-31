export { default as WelcomeScreen } from './components/WelcomeScreen';
export { default as ProjectRootBanner } from './components/ProjectRootBanner';
export { initialBootSurface } from './services/boot-gate';
export type { BootSurface } from './services/boot-gate';
export {
  openProjectInNewWindow,
  openDroppedProject,
  openFolderInNewWindow,
  openWelcomeWindow,
  setProjectWindowTitle,
} from './services/multi-window';
export {
  consumePendingOpenForWorkspace,
  routePendingOpenToProjectWindow,
} from './services/startup-open';
export type { OpenRequest, StartupOpenDeps } from './services/startup-open';
export { rootBannerFor } from './services/root-banner';
export type { RootBanner, RootBannerInput } from './services/root-banner';
export { signpostShortcuts } from './services/signpost';
export type { SignpostShortcut } from './services/signpost';
