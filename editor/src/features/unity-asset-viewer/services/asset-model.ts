// TS mirrors of the Rust `unity_yaml.rs` serde shapes (camelCase) returned by
// the `unity_parse_asset` command.

export interface SceneComponentRef {
  fileId: string;
  classId: string;
  typeName: string;
  scriptGuid?: string | null;
}

export interface SceneGameObject {
  fileId: string;
  name: string;
  tag: string;
  layer: number;
  isActive: boolean;
  components: SceneComponentRef[];
  children: SceneGameObject[];
}

export interface UnityYamlDocument {
  classId: string;
  fileId: string;
  typeName: string;
  scriptGuid?: string | null;
  properties: Array<[string, string]>;
  componentFileIds: string[];
  gameObjectFileId?: string | null;
  fatherFileId?: string | null;
}

export interface UnityAssetModel {
  documents: UnityYamlDocument[];
  gameObjects: SceneGameObject[];
}

// Files that get the structured viewer. `.meta` is deliberately excluded — it's
// a small text file better seen raw.
const ASSET_EXTS = ['.unity', '.prefab', '.asset', '.mat', '.anim', '.controller'];

export function isUnityAssetFile(name: string): boolean {
  const l = name.toLowerCase();
  return ASSET_EXTS.some((e) => l.endsWith(e));
}

const GUID_RE = /guid:\s*([0-9a-fA-F]{32})/;

/** Extract a 32-hex guid from a Unity YAML scalar value (e.g. an object ref). */
export function extractGuid(value: string): string | null {
  const m = GUID_RE.exec(value);
  return m ? m[1] : null;
}
