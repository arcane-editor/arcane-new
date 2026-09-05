import { describe, it, expect } from 'bun:test';
import {
  createGraphifyQueryTool,
  createGraphifyExplainTool,
  createGraphifyPathTool,
  createProjectSymbolsTool,
  nonSourceSymbolsGuidance,
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

/**
 * The graph is built from source files only — for a Unity project `.cs` and
 * nothing else (`build-opts.ts`). A data asset can therefore never be a node,
 * but the sidecar answered every zero-match lookup with "rebuild the graph if
 * the file is new", and that reached users as "the file was not indexed" —
 * advice that could never have worked.
 */
describe('project_symbols on a file the graph cannot hold', () => {
  it('names the real reason and the tool that can answer, for .inputactions', () => {
    const text = nonSourceSymbolsGuidance('Assets/InputSystem_Actions.inputactions');
    expect(text).toContain('only covers source code');
    expect(text).toContain('unity_input_actions');
    // Rules rebuilding OUT, rather than offering it as the fix.
    expect(text).toContain('rebuilding the graph will not change that');
  });

  it('points other Unity assets at read', () => {
    expect(nonSourceSymbolsGuidance('Assets/Player.prefab')).toContain('read');
  });

  it('leaves source files alone', () => {
    expect(nonSourceSymbolsGuidance('Assets/Scripts/Player.cs')).toBeNull();
    expect(nonSourceSymbolsGuidance('src/main.ts')).toBeNull();
  });

  it('answers before the availability gate, so a missing graph is not blamed', async () => {
    // isAvailable:false would otherwise return the "build a graph" guidance,
    // which is equally useless for an asset that can never be in one.
    const tool = createProjectSymbolsTool('/ws', { isAvailable: () => false });
    const result = await tool.execute('id', { file: 'Assets/Controls.inputactions' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('unity_input_actions');
    expect(text).not.toContain('No codebase graph');
  });
});
