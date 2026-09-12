import { describe, expect, it } from 'bun:test';
import * as project from './multi-window';

type OpenDroppedProject = (
  paths: string[],
  openProject: (path: string) => Promise<void>,
) => Promise<boolean>;

function getOpenDroppedProject(): OpenDroppedProject | undefined {
  return (project as { openDroppedProject?: OpenDroppedProject }).openDroppedProject;
}

describe('openDroppedProject', () => {
  it('opens the single folder dropped into the project manager', async () => {
    const openDroppedProject = getOpenDroppedProject();
    expect(openDroppedProject).toBeTypeOf('function');
    if (!openDroppedProject) return;

    const openedPaths: string[] = [];
    const opened = await openDroppedProject(['/Games/MyGame'], async (path) => {
      openedPaths.push(path);
    });

    expect(opened).toBe(true);
    expect(openedPaths).toEqual(['/Games/MyGame']);
  });

  it('ignores drops that do not contain exactly one folder path', async () => {
    const openDroppedProject = getOpenDroppedProject();
    expect(openDroppedProject).toBeTypeOf('function');
    if (!openDroppedProject) return;

    let opens = 0;
    const openProject = async () => {
      opens += 1;
    };

    expect(await openDroppedProject([], openProject)).toBe(false);
    expect(await openDroppedProject(['/Games/One', '/Games/Two'], openProject)).toBe(false);
    expect(opens).toBe(0);
  });
});
