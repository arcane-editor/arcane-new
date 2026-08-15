import { describe, it, expect } from 'bun:test';
import {
  createGraphifyQueryTool,
  createGraphifyExplainTool,
  createGraphifyPathTool,
} from './graphify-tools';

/**
 * Availability gating (cache activation §1): the tools stay registered even
 * without a graph, and answer with guidance instead of vanishing from the
 * tool set (which would change the cached prompt prefix mid-conversation).
 */
describe('graphify tools availability gate', () => {
  const unavailable = { isAvailable: () => false };

  it('each tool answers with build guidance when no graph exists', async () => {
    const tools = [
      { tool: createGraphifyQueryTool('/ws', unavailable), params: { question: 'q' } },
      { tool: createGraphifyExplainTool('/ws', unavailable), params: { node: 'n' } },
      { tool: createGraphifyPathTool('/ws', unavailable), params: { from: 'a', to: 'b' } },
    ];
    for (const { tool, params } of tools) {
      const result = await tool.execute('id', params);
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('No codebase graph');
      expect(text).toContain('Graphify panel');
    }
  });

  it('an available graph proceeds past the gate (into the real client path)', async () => {
    const tool = createGraphifyQueryTool('/ws', { isAvailable: () => true });
    const result = await tool.execute('id', { question: 'q' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    // Outside a Tauri runtime the client invoke fails — but the gate must NOT
    // have answered with the unavailable guidance.
    expect(text).not.toContain('No codebase graph');
  });
});
