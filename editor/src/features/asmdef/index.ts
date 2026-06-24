// Public API for the asmdef (assembly-definition awareness) feature.
//
// Activation is Unity-gated and internally inert for non-Unity projects:
// nothing is invoked, no diagnostics are published, and no UI is shown unless
// the active workspace is a Unity project (and, for diagnostics, the
// `unity.asmdef.diagnostics` setting is enabled).

export {
  buildGraph,
  getGraph,
  getOwningAssembly,
  type AsmdefNode,
} from './services/asmdef-service';

export { initAsmdefFeature } from './services/activation';
