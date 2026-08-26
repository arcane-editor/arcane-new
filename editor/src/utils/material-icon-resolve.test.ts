import { describe, expect, it } from 'bun:test';
import {
  resolveFileIconId,
  resolveFolderIconId,
  iconFileName,
} from './material-icon-resolve';
import { ICON_PATHS, DEFAULT_FILE, DEFAULT_FOLDER, DEFAULT_FOLDER_OPEN } from './material-icon-map.generated';

describe('resolveFileIconId — compound suffixes', () => {
  // The reported bug: `.service.ts` resolved on the last dot segment (`ts`)
  // and rendered the plain TypeScript icon.
  it('resolves .service.ts to the Angular service icon, not plain typescript', () => {
    expect(resolveFileIconId('auth.service.ts', false)).toBe('angular-service');
    expect(resolveFileIconId('auth.service.ts', false)).not.toBe('typescript');
  });

  it('resolves the rest of the compound suffixes VS Code understands', () => {
    expect(resolveFileIconId('app.module.ts', false)).toBe('angular');
    expect(resolveFileIconId('auth.guard.ts', false)).toBe('angular-guard');
    expect(resolveFileIconId('parser.spec.ts', false)).toBe('test-ts');
    expect(resolveFileIconId('parser.test.ts', false)).toBe('test-ts');
    expect(resolveFileIconId('Button.test.tsx', false)).toBe('test-jsx');
    expect(resolveFileIconId('Button.stories.tsx', false)).toBe('storybook');
    expect(resolveFileIconId('globals.d.ts', false)).toBe('typescript-def');
  });

  it('prefers the longest matching suffix over the bare extension', () => {
    // `spec.ts` and `ts` both match; the compound must win.
    expect(resolveFileIconId('a.spec.ts', false)).toBe('test-ts');
    expect(resolveFileIconId('a.ts', false)).toBe('typescript');
  });

  it('walks past unknown middle segments to find a real suffix', () => {
    // `zzz.ts` is not a known compound, so it must fall back to `ts`.
    expect(resolveFileIconId('a.zzz.ts', false)).toBe('typescript');
  });
});

describe('resolveFileIconId — name and fallback rules', () => {
  it('lets an exact filename beat its extension', () => {
    expect(resolveFileIconId('tsconfig.json', false)).toBe('tsconfig');
    expect(resolveFileIconId('tsconfig.json', false)).not.toBe('json');
    expect(resolveFileIconId('package.json', false)).toBe('nodejs');
  });

  it('is case-insensitive on both names and extensions', () => {
    expect(resolveFileIconId('README.MD', false)).toBe(resolveFileIconId('readme.md', false));
    expect(resolveFileIconId('Player.CS', false)).toBe(resolveFileIconId('player.cs', false));
  });

  it('handles dotfiles, which have no leading name segment', () => {
    expect(resolveFileIconId('.gitignore', false)).toBe('git');
  });

  it('handles extensionless files by exact name', () => {
    expect(resolveFileIconId('Makefile', false)).toBe('makefile');
    expect(resolveFileIconId('LICENSE', false)).toBe('license');
  });

  it('falls back to the default icon for unknown files', () => {
    expect(resolveFileIconId('mystery.zzzznope', false)).toBe(DEFAULT_FILE);
    expect(resolveFileIconId('noextension-at-all', false)).toBe(DEFAULT_FILE);
    expect(resolveFileIconId('', false)).toBe(DEFAULT_FILE);
  });

  it('still covers the Unity and C# types the explorer leans on', () => {
    expect(resolveFileIconId('Player.cs', false)).toBe('csharp');
    expect(resolveFileIconId('Main.unity', false)).toBe('unity');
    expect(resolveFileIconId('Lit.shader', false)).toBe('shader');
  });
});

describe('Unity extension overlay', () => {
  // Upstream covers `.unity` and `.unitypackage` but nothing else in Unity's
  // asset family, so without the overlay these regress to a blank file icon
  // in what is primarily a Unity IDE.
  it('gives Unity asset types a real icon where upstream has none', () => {
    expect(resolveFileIconId('Player.prefab', false)).toBe('unity');
    expect(resolveFileIconId('Settings.asset', false)).toBe('unity');
    expect(resolveFileIconId('Ground.mat', false)).toBe('unity');
    expect(resolveFileIconId('Hero.controller', false)).toBe('unity');
    expect(resolveFileIconId('Walk.anim', false)).toBe('unity');
    expect(resolveFileIconId('Game.asmdef', false)).toBe('settings');
    expect(resolveFileIconId('Panel.uxml', false)).toBe('xml');
    expect(resolveFileIconId('Panel.uss', false)).toBe('css');
  });

  it('does not regress any extension the previous hand-written map covered', () => {
    // Guards the vendoring swap: every mapping the old 84-entry table had must
    // still resolve to something other than the blank default.
    const previouslyCovered = [
      'a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.json', 'a.html',
      'a.css', 'a.scss', 'a.sass', 'a.less', 'a.md', 'a.xml', 'a.svg',
      'a.yaml', 'a.yml', 'a.toml', 'a.py', 'a.rs', 'a.go', 'a.java', 'a.c',
      'a.h', 'a.cpp', 'a.hpp', 'a.rb', 'a.php', 'a.sql', 'a.sh', 'a.cs',
      'a.shader', 'a.hlsl', 'a.glsl', 'a.cginc', 'a.compute', 'a.unity',
      'a.prefab', 'a.asset', 'a.asmdef', 'a.asmref', 'a.controller', 'a.mat',
      'a.png', 'a.jpg', 'a.gif', 'a.webp', 'a.ico', 'a.tga', 'a.psd', 'a.exr',
      'a.hdr', 'a.ttf', 'a.otf', 'a.woff', 'a.woff2', 'a.log',
    ];
    const regressed = previouslyCovered.filter(
      (f) => resolveFileIconId(f, false) === DEFAULT_FILE,
    );
    expect(regressed).toEqual([]);
  });

  it('gives Unity folders an icon where upstream has none', () => {
    // Prefabs / Scenes / Materials / Editor / StreamingAssets are five of the
    // folders in Unity's own standard project layout, and upstream has none of
    // them — they would all render as the plain default folder.
    expect(resolveFolderIconId('Prefabs', false, false)).not.toBe(DEFAULT_FOLDER);
    expect(resolveFolderIconId('Scenes', false, false)).not.toBe(DEFAULT_FOLDER);
    expect(resolveFolderIconId('Materials', false, false)).not.toBe(DEFAULT_FOLDER);
    expect(resolveFolderIconId('Editor', false, false)).not.toBe(DEFAULT_FOLDER);
    expect(resolveFolderIconId('StreamingAssets', false, false)).not.toBe(DEFAULT_FOLDER);
  });

  it('derives a real open variant for every overridden folder', () => {
    // The `-open` id is derived by suffix rather than looked up, so it has to
    // be asserted against the icon set rather than assumed.
    for (const name of ['Prefabs', 'Scenes', 'Materials', 'Editor', 'StreamingAssets']) {
      const open = resolveFolderIconId(name, true, false);
      expect(open).toEndWith('-open');
      expect(ICON_PATHS[open]).toBeDefined();
    }
  });

  it('does not regress any folder the previous hand-written map covered', () => {
    // Companion to the file-extension guard above. Its absence is what let the
    // five Unity folders above regress unnoticed when the vendored set landed.
    const previouslyCovered = [
      'assets', 'scripts', 'prefabs', 'scenes', 'editor', 'plugins', 'resources',
      'shaders', 'materials', 'textures', 'animations', 'streamingassets',
      'src', 'lib', 'dist', 'build', 'public', 'components', 'features', 'hooks',
      'utils', 'types', 'stores', 'config', 'docs', 'test', 'tests', 'node_modules',
      '.git', '.github', 'api', 'routes', 'server', 'client', 'shared', 'theme',
      'styles', 'css', 'images', 'img', 'fonts', 'audio', 'video', 'database',
      'docker', 'templates', 'app', 'rust', 'target', 'content', 'project',
    ];
    const regressed = previouslyCovered.filter(
      (f) => resolveFolderIconId(f, false, false) === DEFAULT_FOLDER,
    );
    expect(regressed).toEqual([]);
  });

  it('resolves every overlay target to a real SVG', () => {
    const overlayTargets = [
      'unity', 'shader', 'settings', 'xml', 'css', 'document', 'image',
      'folder-unity', 'folder-resource', 'folder-config',
    ];
    const orphans = overlayTargets.filter((id) => !ICON_PATHS[id]);
    expect(orphans).toEqual([]);
  });
});

describe('resolveFolderIconId', () => {
  it('returns matching closed and open variants for a known folder', () => {
    const closed = resolveFolderIconId('src', false, false);
    const open = resolveFolderIconId('src', true, false);
    expect(closed).toBe('folder-src');
    expect(open).toBe('folder-src-open');
  });

  it('falls back to the generic folder for unknown names', () => {
    expect(resolveFolderIconId('zzzz-unknown', false, false)).toBe(DEFAULT_FOLDER);
    expect(resolveFolderIconId('zzzz-unknown', true, false)).toBe(DEFAULT_FOLDER_OPEN);
  });

  it('is case-insensitive', () => {
    expect(resolveFolderIconId('SRC', false, false)).toBe('folder-src');
  });
});

describe('light theme overrides', () => {
  it('swaps in the light variant when one exists', () => {
    // `light.fileNames` covers icons that wash out on light backgrounds.
    // Pick one dynamically so this test survives upstream changes.
    const { LIGHT_FILE_NAMES } = require('./material-icon-map.generated');
    const [name, lightId] = Object.entries(LIGHT_FILE_NAMES)[0] as [string, string];
    expect(resolveFileIconId(name, true)).toBe(lightId);
  });

  it('falls through to the base map when no light variant exists', () => {
    // .cs has no light override, so both themes must agree.
    expect(resolveFileIconId('Player.cs', true)).toBe(resolveFileIconId('Player.cs', false));
  });
});

// A plan is one of the most-opened files in the app; the generic document
// icon made it indistinguishable from every other text file in the tree.
describe('resolveFileIconId — UnityIDE file types', () => {
  it('gives a plan its own icon', () => {
    const id = resolveFileIconId('20260810-1432-add-enemy.aplan', false);
    expect(id).toBe('todo');
    expect(id).not.toBe(resolveFileIconId('notes.txt', false));
  });

  it('resolves that icon to a real SVG', () => {
    expect(ICON_PATHS[resolveFileIconId('a.aplan', false)]).toBeDefined();
  });

  it('is case-insensitive, like every other extension', () => {
    expect(resolveFileIconId('A.APLAN', false)).toBe(resolveFileIconId('a.aplan', false));
  });
});

describe('map integrity', () => {
  it('resolves every icon id the maps can produce to a real SVG', () => {
    const maps = require('./material-icon-map.generated');
    const ids = new Set<string>([
      DEFAULT_FILE,
      DEFAULT_FOLDER,
      DEFAULT_FOLDER_OPEN,
      ...Object.values(maps.FILE_NAMES as Record<string, string>),
      ...Object.values(maps.FILE_EXTENSIONS as Record<string, string>),
      ...Object.values(maps.FOLDER_NAMES as Record<string, string>),
      ...Object.values(maps.FOLDER_NAMES_EXPANDED as Record<string, string>),
      ...Object.values(maps.LIGHT_FILE_NAMES as Record<string, string>),
      ...Object.values(maps.LIGHT_FILE_EXTENSIONS as Record<string, string>),
      ...Object.values(maps.LIGHT_FOLDER_NAMES as Record<string, string>),
      ...Object.values(maps.LIGHT_FOLDER_NAMES_EXPANDED as Record<string, string>),
    ]);

    const orphans = [...ids].filter((id) => !ICON_PATHS[id]);
    expect(orphans).toEqual([]);
  });

  it('maps an icon id to a bare svg filename', () => {
    expect(iconFileName('angular-service')).toMatch(/\.svg$/);
    expect(iconFileName('angular-service')).not.toContain('/');
  });

  it('falls back to the default file icon for an unknown id', () => {
    expect(iconFileName('no-such-icon')).toBe(ICON_PATHS[DEFAULT_FILE]);
  });
});
