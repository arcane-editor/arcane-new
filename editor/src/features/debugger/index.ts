import './styles/debugger.css';

// Unity Mono debugger. Speaks DAP to the native Mono soft-debugger client in
// `src-tauri/src/debug/` — there is no adapter process and nothing to install,
// which is what the previous `vscode-mono-debug` sidecar could never manage in
// a packaged build.

export { dapClient } from './services/dap-client';
export { attachBreakpointGutter } from './services/breakpoint-gutter';
export { attachInlineValues } from './services/inline-values';
export { renderValue } from './services/value-rendering';
export { DebugPanel } from './components/DebugPanel';
export { DebugConsole } from './components/DebugConsole';
export { BreakpointsPanel } from './components/BreakpointsPanel';
