/**
 * AgentTool factories that expose the bundled graphify sidecar to the AI.
 *
 * Three tools are exposed, all read-only and safe to include in any chat
 * mode (ask, plan-planning, agent, plan-execution).
 */

import { Type, type Static } from '@sinclair/typebox';
import type {
  AgentTool,
  AgentToolResult,
} from '../../ai-panel';
import {
  graphifyExplain,
  graphifyPath,
  graphifyQuery,
  graphifySymbols,
} from './graphify-client';

/**
 * Availability gating (cache activation §1): these tools are registered in
 * EVERY conversation regardless of graph status, so the tool set — part of
 * the provider's cached prompt prefix — never changes when a graph is built
 * or goes missing mid-session. When no graph exists, execute() answers with
 * guidance instead of the tool disappearing.
 */
export interface GraphifyToolOpts {
  /** Injectable for tests; defaults to reading the graphify store. */
  isAvailable?: () => boolean;
}

const GRAPH_UNAVAILABLE_TEXT =
  'No codebase graph has been built for this workspace yet. Suggest the user builds one from the Graphify panel; until then, use read/list to explore the codebase directly.';

/**
 * Extensions the codebase graph structurally cannot contain.
 *
 * The graph is built from SOURCE files — for a Unity project `.cs` only
 * (`build-opts.ts`: `includeExt: ['.cs']`). A Unity data asset can therefore
 * never be a node, but the sidecar answered any zero-match lookup with a
 * generic "rebuild the graph if the file is new", and models relayed that to
 * users as "the file was not indexed" — advice that could never work. Answer
 * with the real reason instead, and name the tool that can help.
 */
const NON_SOURCE_EXTENSIONS = [
  '.inputactions',
  '.prefab',
  '.unity',
  '.asset',
  '.mat',
  '.anim',
  '.controller',
  '.meta',
  '.asmdef',
  '.asmref',
  '.uxml',
  '.uss',
  '.shadergraph',
  '.json',
];

/** Guidance for a `file` the graph cannot hold, or null when it is source. */
export function nonSourceSymbolsGuidance(file: string): string | null {
  const lower = file.toLowerCase();
  const ext = NON_SOURCE_EXTENSIONS.find((e) => lower.endsWith(e));
  if (!ext) return null;
  // Each of these has a tool that answers in a fraction of the tokens `read`
  // would spend, and — for `.asset` — answers questions the file alone cannot
  // (its schema lives in the C# class, and the drift between them in neither).
  const REDIRECTS: Record<string, string> = {
    '.inputactions': 'Call unity_input_actions to list its maps, actions and bindings',
    '.uxml': 'Call unity_ui_toolkit to get its element tree, names and stylesheets',
    '.uss': 'Call unity_ui_toolkit to get the classes it declares and where they are used',
    '.asset': 'Call unity_scriptable_objects to get its typed field values and its class schema',
  };
  const alternative = REDIRECTS[ext] ?? 'Use read to open it directly';
  return (
    `project_symbols only covers source code: the codebase graph indexes C# scripts, not ${ext} ` +
    `data assets, so ${file} will never appear in it and rebuilding the graph will not change that. ` +
    `${alternative}.`
  );
}

/**
 * Default availability check. The graphify store is reached via a dynamic
 * import (same pattern as turn-governor's `defaultOnCapReached`): its import
 * chain transitively touches `document` via the theme store, which is fatal
 * under Bun where these tool factories are imported directly by tests.
 */
async function defaultIsAvailable(): Promise<boolean> {
  const { useGraphifyStore } = await import('../../../stores/graphify');
  const status = useGraphifyStore.getState().status;
  return status === 'present' || status === 'stale';
}

async function gateUnavailable(opts?: GraphifyToolOpts): Promise<boolean> {
  const available = opts?.isAvailable ? opts.isAvailable() : await defaultIsAvailable();
  return !available;
}

const queryArgs = Type.Object({
  question: Type.String({
    description:
      'Free-text question about the codebase. Routes to a BFS or DFS traversal over the AST graph.',
  }),
  budget: Type.Optional(
    Type.Number({
      description: 'Approximate token budget for the returned subgraph (default 2000).',
    }),
  ),
  dfs: Type.Optional(
    Type.Boolean({
      description: 'Use depth-first traversal (trace a specific chain) instead of BFS.',
    }),
  ),
});
type QueryArgs = Static<typeof queryArgs>;

const explainArgs = Type.Object({
  node: Type.String({
    description: 'Name or label of a node to explain (e.g. function, class, file).',
  }),
});
type ExplainArgs = Static<typeof explainArgs>;

const pathArgs = Type.Object({
  from: Type.String({ description: 'Source node label.' }),
  to: Type.String({ description: 'Target node label.' }),
});
type PathArgs = Static<typeof pathArgs>;

function textResult(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(err: unknown): AgentToolResult {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `graphify error: ${text}` }] };
}

export function createGraphifyQueryTool(workspacePath: string, opts?: GraphifyToolOpts): AgentTool {
  return {
    name: 'graphify_query',
    label: 'graphify_query',
    description:
      'Traverse the codebase knowledge graph to answer a free-text question. ' +
      'Returns a relevant subgraph (nodes + edges with confidence tags) bounded by a token budget. ' +
      'Use this when you need to understand structural relationships (calls, imports, hierarchies) ' +
      'rather than reading individual files.',
    parameters: queryArgs,
    async execute(_id: string, params: unknown): Promise<AgentToolResult> {
      if (await gateUnavailable(opts)) return textResult(GRAPH_UNAVAILABLE_TEXT);
      const { question, budget, dfs } = params as QueryArgs;
      try {
        const out = await graphifyQuery(workspacePath, question, { budget, dfs });
        return textResult(out || '(empty)');
      } catch (e) {
        return errorResult(e);
      }
    },
  };
}

const symbolsArgs = Type.Object({
  file: Type.Optional(
    Type.String({ description: 'File path (relative paths match by suffix), e.g. Assets/Scripts/Player.cs' }),
  ),
  type: Type.Optional(Type.String({ description: 'Type/class name to look up instead of a file.' })),
});
type SymbolsArgs = Static<typeof symbolsArgs>;

export function createProjectSymbolsTool(workspacePath: string, opts?: GraphifyToolOpts): AgentTool {
  return {
    name: 'project_symbols',
    label: 'project_symbols',
    description:
      'List the types and member symbols in a file (or the file owning a type) without reading the whole file. ' +
      'Prefer this over read when you only need to know what exists or where a member is declared.',
    parameters: symbolsArgs,
    async execute(_id: string, params: unknown): Promise<AgentToolResult> {
      const { file, type } = params as SymbolsArgs;
      // Checked BEFORE the availability gate: a data asset is permanently
      // absent from the graph, so "build a graph" would be wrong advice even
      // when no graph exists yet.
      const guidance = file ? nonSourceSymbolsGuidance(file) : null;
      if (guidance) return textResult(guidance);
      if (await gateUnavailable(opts)) return textResult(GRAPH_UNAVAILABLE_TEXT);
      try {
        const out = await graphifySymbols(workspacePath, { file, typeName: type });
        return textResult(out || '(empty)');
      } catch (e) {
        return errorResult(e);
      }
    },
  };
}

export function createGraphifyExplainTool(workspacePath: string, opts?: GraphifyToolOpts): AgentTool {
  return {
    name: 'graphify_explain',
    label: 'graphify_explain',
    description:
      'Describe a graph node and list all its direct connections (incoming and outgoing). ' +
      'Useful when you need to understand what a specific symbol does and what depends on it.',
    parameters: explainArgs,
    async execute(_id: string, params: unknown): Promise<AgentToolResult> {
      if (await gateUnavailable(opts)) return textResult(GRAPH_UNAVAILABLE_TEXT);
      const { node } = params as ExplainArgs;
      try {
        const out = await graphifyExplain(workspacePath, node);
        return textResult(out || '(empty)');
      } catch (e) {
        return errorResult(e);
      }
    },
  };
}

export function createGraphifyPathTool(workspacePath: string, opts?: GraphifyToolOpts): AgentTool {
  return {
    name: 'graphify_path',
    label: 'graphify_path',
    description:
      'Find the shortest path between two named concepts in the codebase graph. ' +
      'Reveals how one component reaches another through calls, imports, or references.',
    parameters: pathArgs,
    async execute(_id: string, params: unknown): Promise<AgentToolResult> {
      if (await gateUnavailable(opts)) return textResult(GRAPH_UNAVAILABLE_TEXT);
      const { from, to } = params as PathArgs;
      try {
        const out = await graphifyPath(workspacePath, from, to);
        return textResult(out || '(empty)');
      } catch (e) {
        return errorResult(e);
      }
    },
  };
}
