import { posix, win32 } from 'node:path';

export function compilerLayout(resources: string, platform: NodeJS.Platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  const scripting = platform === 'win32' ? paths.normalize(resources) : paths.join(resources, 'Scripting');
  return {
    scripting,
    mono: paths.join(scripting, 'MonoBleedingEdge/bin', platform === 'win32' ? 'mono.exe' : 'mono'),
    csc: paths.join(scripting, 'MonoBleedingEdge/lib/mono/4.5/csc.exe'),
  };
}

export function isOptionalInputSource(path: string): boolean {
  return path.replace(/\\/g, '/').includes('/Editor/InputSystem/');
}
