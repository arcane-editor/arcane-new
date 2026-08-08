/**
 * File and folder icons, resolved against the vendored Material Icon Theme set.
 *
 * The resolution rules live in `material-icon-resolve.ts` (pure, unit-tested);
 * this file only binds them to React and to the active theme.
 *
 * `getFileIcon` / `getFolderIcon` keep their original call signatures and are
 * thin wrappers returning a component. They must stay wrappers rather than
 * become hooks themselves: callers invoke them mid-render inside `.map()`
 * callbacks and conditionals, where a hook call would violate the rules of
 * hooks. Returning an element defers the `useThemeStore` subscription into a
 * real component boundary, which is also what makes icons re-resolve on a
 * light/dark theme switch without any caller doing anything.
 */

import React from 'react';
import { useThemeStore } from '../stores/theme';
import { resolveFileIconId, resolveFolderIconId, iconUrl } from './material-icon-resolve';

interface IconImgProps {
  iconId: string;
  size: number;
}

function IconImg({ iconId, size }: IconImgProps) {
  return (
    <img
      src={iconUrl(iconId)}
      width={size}
      height={size}
      alt=""
      title=""
      aria-hidden="true"
      style={{ flexShrink: 0, pointerEvents: 'none' }}
      draggable={false}
    />
  );
}

/**
 * Subscribes to the theme *type* only — not the whole theme object — so
 * switching between two dark themes re-renders no icons at all.
 */
function useIsLightTheme(): boolean {
  return useThemeStore((s) => s.getActiveTheme().type === 'light');
}

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const isLight = useIsLightTheme();
  return <IconImg iconId={resolveFileIconId(name, isLight)} size={size} />;
}

export function FolderIcon({
  name,
  isOpen,
  size = 16,
}: {
  name: string;
  isOpen: boolean;
  size?: number;
}) {
  const isLight = useIsLightTheme();
  return <IconImg iconId={resolveFolderIconId(name, isOpen, isLight)} size={size} />;
}

export function getFileIcon(filename: string, size = 16): React.ReactElement {
  return <FileIcon name={filename} size={size} />;
}

export function getFolderIcon(
  isOpen: boolean,
  size = 16,
  folderName?: string,
): React.ReactElement {
  return <FolderIcon name={folderName ?? ''} isOpen={isOpen} size={size} />;
}
