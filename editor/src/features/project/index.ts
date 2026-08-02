export { default as WelcomeScreen } from './components/WelcomeScreen';
export { default as ProjectRootBanner } from './components/ProjectRootBanner';
export { initialBootSurface } from './services/boot-gate';
export type { BootSurface } from './services/boot-gate';
export {
  openProjectInNewWindow,
  openFolderInNewWindow,
  openWelcomeWindow,
  setProjectWindowTitle,
} from './services/multi-window';
export { rootBannerFor } from './services/root-banner';
export type { RootBanner, RootBannerInput } from './services/root-banner';
