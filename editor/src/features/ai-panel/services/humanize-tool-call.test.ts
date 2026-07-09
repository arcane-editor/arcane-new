import { describe, it, expect } from 'bun:test';
import { humanizeToolCall } from './humanize-tool-call';

describe('humanizeToolCall', () => {
  describe('write / edit', () => {
    it('edit: shows the workspace-relative path with +/- line counts from status.diffs', () => {
      const out = humanizeToolCall(
        'edit',
        { path: 'Assets/Scripts/Player.cs' },
        { diffs: [{ path: '/abs/Assets/Scripts/Player.cs', oldText: 'foo\n', newText: 'bar\n' }] },
      );
      expect(out.title).toBe('Edited Assets/Scripts/Player.cs (+1 −1)');
    });

    it('write: uses "Wrote" and counts an all-new file as pure additions', () => {
      const out = humanizeToolCall(
        'write',
        { path: 'Assets/Scripts/New.cs' },
        { diffs: [{ path: '/abs/New.cs', oldText: '', newText: 'a\nb\nc' }] },
      );
      expect(out.title).toBe('Wrote Assets/Scripts/New.cs (+3 −0)');
    });

    it('edit: pure removal counts only removed lines', () => {
      const out = humanizeToolCall(
        'edit',
        { path: 'Foo.cs' },
        { diffs: [{ path: '/abs/Foo.cs', oldText: 'line1\nline2\n', newText: 'line1\n' }] },
      );
      expect(out.title).toBe('Edited Foo.cs (+0 −1)');
    });

    it('omits the count suffix when there is no status yet (still running)', () => {
      const out = humanizeToolCall('write', { path: 'Assets/Foo.cs' });
      expect(out.title).toBe('Wrote Assets/Foo.cs');
    });

    it('omits the count suffix when status.diffs is empty', () => {
      const out = humanizeToolCall('edit', { path: 'Assets/Foo.cs' }, { diffs: [] });
      expect(out.title).toBe('Edited Assets/Foo.cs');
    });

    it('sums counts across multiple diffs', () => {
      const out = humanizeToolCall(
        'edit',
        { path: 'Assets/Foo.cs' },
        {
          diffs: [
            { path: '/abs/a', oldText: 'x\n', newText: 'y\n' },
            { path: '/abs/b', oldText: '', newText: '1\n2\n' },
          ],
        },
      );
      expect(out.title).toBe('Edited Assets/Foo.cs (+3 −1)');
    });
  });

  describe('header-prefix collisions (regression — Finding 1)', () => {
    it('counts an added line whose content starts with "++" (e.g. "++i;") as +1, not a dropped header', () => {
      const out = humanizeToolCall(
        'edit',
        { path: 'Foo.cs' },
        { diffs: [{ path: '/abs/Foo.cs', oldText: 'a\n', newText: 'a\n++i;\n' }] },
      );
      expect(out.title).toBe('Edited Foo.cs (+1 −0)');
    });

    it('counts a removed line whose content starts with "--" (e.g. "--count;") as -1', () => {
      const out = humanizeToolCall(
        'edit',
        { path: 'Foo.cs' },
        { diffs: [{ path: '/abs/Foo.cs', oldText: 'a\n--count;\n', newText: 'a\n' }] },
      );
      expect(out.title).toBe('Edited Foo.cs (+0 −1)');
    });

    it('counts an added line starting with "=== section ===" as a normal addition, not a dropped separator', () => {
      const out = humanizeToolCall(
        'edit',
        { path: 'Foo.cs' },
        { diffs: [{ path: '/abs/Foo.cs', oldText: 'a\n', newText: 'a\n=== section ===\n' }] },
      );
      expect(out.title).toBe('Edited Foo.cs (+1 −0)');
    });
  });

  describe('path relativization (regression — Finding 4)', () => {
    it('relativizes an absolute path under the workspace root', () => {
      const out = humanizeToolCall(
        'edit',
        { path: '/Users/dev/MyProj/Assets/Scripts/Player.cs' },
        undefined,
        '/Users/dev/MyProj',
      );
      expect(out.title).toBe('Edited Assets/Scripts/Player.cs');
    });

    it('matches the workspace root case-tolerantly', () => {
      const out = humanizeToolCall(
        'write',
        { path: '/USERS/dev/myproj/Assets/Foo.cs' },
        undefined,
        '/Users/dev/MyProj',
      );
      expect(out.title).toBe('Wrote Assets/Foo.cs');
    });

    it('falls back to the basename for an absolute path outside the workspace root', () => {
      const out = humanizeToolCall('edit', { path: '/etc/hosts' }, undefined, '/Users/dev/MyProj');
      expect(out.title).toBe('Edited hosts');
    });

    it('falls back to the basename for an absolute path when no workspacePath is given at all', () => {
      const out = humanizeToolCall('edit', { path: '/Users/dev/MyProj/Assets/Foo.cs' });
      expect(out.title).toBe('Edited Foo.cs');
    });

    it('leaves a relative path unchanged regardless of workspacePath', () => {
      const out = humanizeToolCall(
        'edit',
        { path: 'Assets/Scripts/Player.cs' },
        undefined,
        '/Users/dev/MyProj',
      );
      expect(out.title).toBe('Edited Assets/Scripts/Player.cs');
    });

    it('also relativizes an absolute path for the "list" tool', () => {
      const out = humanizeToolCall(
        'list',
        { path: '/Users/dev/MyProj/Assets/Scripts' },
        undefined,
        '/Users/dev/MyProj',
      );
      expect(out.title).toBe('Listed Assets/Scripts');
    });
  });

  describe('read', () => {
    it('shows only the basename, not the full path', () => {
      const out = humanizeToolCall('read', { path: 'Assets/Scripts/Player.cs' });
      expect(out.title).toBe('Read Player.cs');
    });
  });

  describe('list', () => {
    it('shows the listed path when given', () => {
      const out = humanizeToolCall('list', { path: 'Assets/Scripts' });
      expect(out.title).toBe('Listed Assets/Scripts');
    });

    it('falls back to a friendly label when no path is given', () => {
      const out = humanizeToolCall('list', {});
      expect(out.title).toBe('Listed workspace root');
    });
  });

  describe('bash', () => {
    it('shows the command in backticks, no subtitle, when short and single-line', () => {
      const out = humanizeToolCall('bash', { command: 'git status --short' });
      expect(out.title).toBe('Ran `git status --short`');
      expect(out.subtitle).toBeUndefined();
    });

    it('truncates a long command to <=60 chars and keeps the full command as subtitle', () => {
      const long = 'find . -type f -name "*.meta" -newer Assets/Scripts/Player.cs -print0 | xargs -0 ls -la';
      const out = humanizeToolCall('bash', { command: long });
      const inner = out.title.slice('Ran `'.length, -1); // strip "Ran `" and trailing "`"
      expect(inner.length).toBeLessThanOrEqual(60);
      expect(inner.endsWith('…')).toBe(true);
      expect(out.subtitle).toBe(long);
    });

    it('collapses a multi-line command onto one line in the title and keeps the raw text as subtitle', () => {
      const multi = 'echo one\necho two\necho three';
      const out = humanizeToolCall('bash', { command: multi });
      expect(out.title).toBe('Ran `echo one echo two echo three`');
      expect(out.subtitle).toBe(multi);
    });
  });

  describe('todo_update', () => {
    it('reports done/total counts', () => {
      const out = humanizeToolCall('todo_update', {
        items: [
          { text: 'a', status: 'done' },
          { text: 'b', status: 'done' },
          { text: 'c', status: 'in_progress' },
          { text: 'd', status: 'pending' },
        ],
      });
      expect(out.title).toBe('Updated todo list (2/4 done)');
    });
  });

  describe('unity mutate tools', () => {
    it('unity_play', () => {
      expect(humanizeToolCall('unity_play', {}).title).toBe('Entered Play Mode');
    });
    it('unity_stop', () => {
      expect(humanizeToolCall('unity_stop', {}).title).toBe('Exited Play Mode');
    });
    it('unity_refresh', () => {
      expect(humanizeToolCall('unity_refresh', {}).title).toBe('Refreshed Unity assets');
    });
    it('unity_run_tests defaults to EditMode with no filter', () => {
      expect(humanizeToolCall('unity_run_tests', {}).title).toBe('Ran EditMode tests');
    });
    it('unity_run_tests reports mode + truncated filter', () => {
      const out = humanizeToolCall('unity_run_tests', { mode: 'PlayMode', filter: 'MyNamespace.MyTests.SomeVeryLongTestNameThatGoesOnForAWhile' });
      expect(out.title.startsWith('Ran PlayMode tests (filter: ')).toBe(true);
      expect(out.title.length).toBeLessThan(120);
    });
    it('unity_execute_menu_item', () => {
      expect(humanizeToolCall('unity_execute_menu_item', { path: 'Assets/Refresh' }).title).toBe(
        'Executed menu item "Assets/Refresh"',
      );
    });
  });

  describe('unity read tools', () => {
    it('unity_api_search truncates the query to <=40 chars', () => {
      const out = humanizeToolCall('unity_api_search', {
        query: 'apply an instantaneous force at a specific point on a rigidbody without torque',
      });
      expect(out.title.startsWith('Searched Unity docs: ')).toBe(true);
      expect(out.title.length).toBeLessThanOrEqual('Searched Unity docs: '.length + 40);
    });
    it('get_unity_docs', () => {
      expect(humanizeToolCall('get_unity_docs', { symbol: 'Rigidbody.AddForce' }).title).toBe(
        'Searched Unity docs: Rigidbody.AddForce',
      );
    });
    it('get_console_errors', () => {
      expect(humanizeToolCall('get_console_errors', {}).title).toBe('Checked Unity console');
    });
    it('get_editor_state', () => {
      expect(humanizeToolCall('get_editor_state', {}).title).toBe('Checked Unity editor state');
    });
    it('get_scene_hierarchy', () => {
      expect(humanizeToolCall('get_scene_hierarchy', {}).title).toBe('Read Unity scene hierarchy');
    });
    it('get_game_object', () => {
      expect(humanizeToolCall('get_game_object', {}).title).toBe('Inspected a Unity GameObject');
    });
    it('find_asset_references', () => {
      expect(humanizeToolCall('find_asset_references', {}).title).toBe('Searched asset references');
    });
    it('get_unity_script_map', () => {
      expect(humanizeToolCall('get_unity_script_map', {}).title).toBe('Mapped Unity scripts');
    });
    it('unity_plan_migration includes the kind', () => {
      expect(humanizeToolCall('unity_plan_migration', { kind: 'builtin-to-urp' }).title).toBe(
        'Planned Unity migration (builtin-to-urp)',
      );
    });
  });

  describe('graphify', () => {
    it('every graphify_* tool maps to the same label', () => {
      expect(humanizeToolCall('graphify_query', {}).title).toBe('Queried code graph');
      expect(humanizeToolCall('graphify_explain', {}).title).toBe('Queried code graph');
      expect(humanizeToolCall('graphify_path', {}).title).toBe('Queried code graph');
    });
  });

  describe('unknown tools', () => {
    it('falls back to the raw tool name (e.g. a Claude ACP-provided title)', () => {
      expect(humanizeToolCall('Edit file.ts', {}).title).toBe('Edit file.ts');
      expect(humanizeToolCall('some_custom_tool', {}).title).toBe('some_custom_tool');
    });
  });
});
