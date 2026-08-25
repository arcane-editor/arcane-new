// Public API of the updates feature. `check:modules` requires that every
// feature expose one, and that other features import only through it.
export { startUpdateNotices, updateReadyMessage } from './services/update-notice';
export type { UpdateReadyPayload } from './services/update-notice';
