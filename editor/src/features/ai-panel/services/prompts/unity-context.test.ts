// Pins the two Task 16 additions to the static UI Toolkit context crib: the
// agent had no way to know unity_ui_write/unity_ui_layout/unity_ui_scaffold/
// unity_attach_ui_document/unity_set_property or get_console_errors/
// get_compile_errors/unity_run_tests existed until these tool names were
// named here. `UNITY_CONTEXT` is a leaf template literal (no store/Tauri
// imports), so it is safe to import and assert on directly under Bun.

import { describe, it, expect } from 'bun:test';
import { UNITY_CONTEXT } from './unity-context';

describe('UNITY_CONTEXT — UI Toolkit bullet names the write/layout/scaffold/scene tools', () => {
  it('names all five tools with the exact ids the harness registers', () => {
    for (const tool of [
      'unity_ui_write',
      'unity_ui_layout',
      'unity_ui_scaffold',
      'unity_attach_ui_document',
      'unity_set_property',
    ]) {
      expect(UNITY_CONTEXT).toContain(`\`${tool}\``);
    }
  });

  it('keeps the tool list inside the UI Toolkit bullet, not floating elsewhere', () => {
    const bullet = UNITY_CONTEXT.split('- **Input System**')[0];
    expect(bullet).toContain('unity_ui_write');
    expect(bullet).toContain('unity_ui_scaffold');
  });
});

describe('UNITY_CONTEXT — Console and tests bullet', () => {
  it('names get_console_errors, get_compile_errors, and unity_run_tests', () => {
    expect(UNITY_CONTEXT).toContain('### Console and tests');
    expect(UNITY_CONTEXT).toContain('`get_console_errors`');
    expect(UNITY_CONTEXT).toContain('`get_compile_errors`');
    expect(UNITY_CONTEXT).toContain('`unity_run_tests`');
  });

  it("says the IDE checks the console after the model's turn and may ask once", () => {
    expect(UNITY_CONTEXT).toContain('After your turn the');
    expect(UNITY_CONTEXT).toContain('checks the console for new errors');
    expect(UNITY_CONTEXT).toContain('may ask you once to fix them');
  });
});

// Constraint #7 (every backtick in added prose must be `\``, since
// UNITY_CONTEXT is a template literal): an unescaped backtick would end the
// template literal early and fail to parse, so `UNITY_CONTEXT` importing
// successfully above — and every `toContain` match landing where expected,
// not truncated mid-string — is itself the proof. No separate check needed.
