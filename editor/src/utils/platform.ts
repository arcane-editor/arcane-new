function ua(): string {
  if (typeof navigator === 'undefined') return '';
  return (navigator.platform || navigator.userAgent || '').toUpperCase();
}

export function isMac(): boolean {
  return ua().includes('MAC');
}

export function isWindows(): boolean {
  return ua().includes('WIN');
}

export function isLinux(): boolean {
  return ua().includes('LINUX');
}
