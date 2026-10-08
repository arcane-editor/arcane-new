import { create } from 'zustand';

export interface ChangePreviewFile { path: string; before: string; after: string; buffer: boolean }
interface PreviewState {
  files: ChangePreviewFile[] | null;
  resolve: ((approved: boolean) => void) | null;
}
export const useWorkspaceChangePreview = create<PreviewState>(() => ({ files: null, resolve: null }));

export function requestWorkspaceChangePreview(files: ChangePreviewFile[]): Promise<boolean> {
  if (useWorkspaceChangePreview.getState().files) throw new Error('Another change is awaiting review');
  return new Promise(resolve => useWorkspaceChangePreview.setState({ files, resolve }));
}

export function finishWorkspaceChangePreview(approved: boolean): void {
  const resolve = useWorkspaceChangePreview.getState().resolve;
  useWorkspaceChangePreview.setState({ files: null, resolve: null });
  resolve?.(approved);
}
