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
} from './graphify-client';

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

export function createGraphifyQueryTool(workspacePath: string): AgentTool {
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

export function createGraphifyExplainTool(workspacePath: string): AgentTool {
  return {
    name: 'graphify_explain',
    label: 'graphify_explain',
    description:
      'Describe a graph node and list all its direct connections (incoming and outgoing). ' +
      'Useful when you need to understand what a specific symbol does and what depends on it.',
    parameters: explainArgs,
    async execute(_id: string, params: unknown): Promise<AgentToolResult> {
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

export function createGraphifyPathTool(workspacePath: string): AgentTool {
  return {
    name: 'graphify_path',
    label: 'graphify_path',
    description:
      'Find the shortest path between two named concepts in the codebase graph. ' +
      'Reveals how one component reaches another through calls, imports, or references.',
    parameters: pathArgs,
    async execute(_id: string, params: unknown): Promise<AgentToolResult> {
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
