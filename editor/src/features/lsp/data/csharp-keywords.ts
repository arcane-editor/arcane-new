/**
 * C# language keywords used by the fallback completion provider.
 * These appear with low priority (sortText '9_...') so the LSP and
 * snippet/Unity providers always rank above them.
 */
export const CSHARP_KEYWORDS: string[] = [
  'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case', 'catch',
  'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate',
  'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally',
  'fixed', 'float', 'for', 'foreach', 'get', 'goto', 'if', 'implicit', 'in', 'init',
  'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null',
  'object', 'operator', 'out', 'override', 'params', 'partial', 'private', 'protected',
  'public', 'readonly', 'record', 'ref', 'required', 'return', 'sbyte', 'sealed',
  'set', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe',
  'ushort', 'using', 'var', 'virtual', 'void', 'volatile', 'when', 'where', 'while',
  'yield',
];
