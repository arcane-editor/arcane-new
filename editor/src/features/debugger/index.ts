// Unity Mono debugger (DAP client + UI). Drives the Rust DAP host (dap.rs)
// which runs the mono-debug adapter. Degrades gracefully when Mono is absent.

export { dapClient } from './services/dap-client';
export { attachBreakpointGutter } from './services/breakpoint-gutter';
export { renderValue } from './services/value-rendering';
export { DebugPanel } from './components/DebugPanel';
