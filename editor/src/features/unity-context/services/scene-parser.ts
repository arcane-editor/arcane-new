// Unity scene/prefab YAML parser — ported from scene-graph-parser.ts
// Unity uses a subset of YAML with document separators: --- !u!<classID> &<fileID>

export interface SceneFieldRef {
  label: string;
  value: string;
}

export interface SceneGameObject {
  fileId: string;
  name: string;
  tag: string;
  layer: number;
  isActive: boolean;
  components: SceneComponent[];
  children: SceneGameObject[];
}

export interface SceneComponent {
  fileId: string;
  classId: string;
  typeName: string;
  scriptGuid?: string;
  fields: Record<string, string>;
  rawContent?: string;
}

export interface SceneGraph {
  gameObjects: SceneGameObject[];
  rootObjects: SceneGameObject[];
}

interface YamlDocument {
  classId: string;
  fileId: string;
  content: string;
}

const DOCUMENT_SEPARATOR = /^--- !u!(\d+) &(\d+)/gm;

// Known Unity class IDs
const CLASS_NAMES: Record<string, string> = {
  '1': 'GameObject',
  '4': 'Transform',
  '114': 'MonoBehaviour',
  '224': 'RectTransform',
  '20': 'Camera',
  '23': 'MeshRenderer',
  '33': 'MeshFilter',
  '108': 'Light',
  '65': 'BoxCollider',
  '136': 'CapsuleCollider',
  '54': 'Rigidbody',
  '50': 'Rigidbody2D',
  '212': 'SpriteRenderer',
  '222': 'Canvas',
  '223': 'CanvasGroup',
  '225': 'CanvasRenderer',
  '226': 'Text',
  '82': 'AudioSource',
  '95': 'Animator',
  '61': 'BoxCollider2D',
  '58': 'CircleCollider2D',
  '120': 'LineRenderer',
  '199': 'ParticleSystem',
};

function splitDocuments(content: string): YamlDocument[] {
  const docs: YamlDocument[] = [];
  const matches: { classId: string; fileId: string; start: number }[] = [];

  DOCUMENT_SEPARATOR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DOCUMENT_SEPARATOR.exec(content)) !== null) {
    matches.push({
      classId: match[1],
      fileId: match[2],
      start: match.index + match[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start - matches[i + 1].fileId.length - matches[i + 1].classId.length - 8 : content.length;
    docs.push({
      classId: matches[i].classId,
      fileId: matches[i].fileId,
      content: content.slice(matches[i].start, end),
    });
  }

  return docs;
}

function extractField(content: string, field: string): string | undefined {
  const regex = new RegExp(`^\\s*${field}:\\s*(.+)$`, 'm');
  const match = regex.exec(content);
  return match ? match[1].trim() : undefined;
}

function extractGuid(content: string): string | undefined {
  const match = /m_Script:\s*\{[^}]*guid:\s*([0-9a-f]+)/m.exec(content);
  return match ? match[1] : undefined;
}

export function extractMonoBehaviourFields(rawContent: string): SceneFieldRef[] {
  const fields: SceneFieldRef[] = [];
  const lines = rawContent.split('\n');
  for (const line of lines) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key.startsWith('m_')) continue;
    if (key === 'serializedVersion') continue;
    if (value.startsWith('{') && value.includes('fileID')) continue;
    if (value === '' || value === '[]') continue;
    fields.push({ label: key, value: value.length > 80 ? value.slice(0, 77) + '…' : value });
    if (fields.length >= 8) break;
  }
  return fields;
}

/**
 * Parse a ScriptableObject .asset file. SO assets are a single classId=114
 * MonoBehaviour document — no GameObjects, no hierarchy. Returns the script
 * GUID the asset is an instance of, and its top-level serialized fields.
 */
export function parseScriptableObjectAsset(content: string): {
  scriptGuid: string | null;
  fields: SceneFieldRef[];
} {
  const docs = splitDocuments(content);
  for (const doc of docs) {
    if (doc.classId !== '114') continue;
    const scriptGuid = extractGuid(doc.content) ?? null;
    const fields = extractMonoBehaviourFields(doc.content);
    return { scriptGuid, fields };
  }
  return { scriptGuid: null, fields: [] };
}

function extractComponentRefs(content: string): string[] {
  const refs: string[] = [];
  const regex = /- component:\s*\{fileID:\s*(\d+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

export function parseSceneFile(content: string): SceneGraph {
  const docs = splitDocuments(content);

  // Index all documents by fileId
  const docMap = new Map<string, YamlDocument>();
  for (const doc of docs) {
    docMap.set(doc.fileId, doc);
  }

  // Parse GameObjects (classId = 1)
  const gameObjects = new Map<string, SceneGameObject>();
  for (const doc of docs) {
    if (doc.classId !== '1') continue;

    const name = extractField(doc.content, 'm_Name') ?? 'Unnamed';
    const tag = extractField(doc.content, 'm_TagString') ?? 'Untagged';
    const layer = parseInt(extractField(doc.content, 'm_Layer') ?? '0', 10);
    const isActive = extractField(doc.content, 'm_IsActive') !== '0';

    // Get component references
    const componentFileIds = extractComponentRefs(doc.content);
    const components: SceneComponent[] = [];
    for (const compId of componentFileIds) {
      const compDoc = docMap.get(compId);
      if (!compDoc) continue;

      const typeName = CLASS_NAMES[compDoc.classId] ?? `Unknown(${compDoc.classId})`;
      const comp: SceneComponent = {
        fileId: compDoc.fileId,
        classId: compDoc.classId,
        typeName,
        fields: {},
        rawContent: compDoc.content,
      };

      if (compDoc.classId === '114') {
        comp.scriptGuid = extractGuid(compDoc.content);
      }

      components.push(comp);
    }

    gameObjects.set(doc.fileId, {
      fileId: doc.fileId,
      name,
      tag,
      layer,
      isActive,
      components,
      children: [],
    });
  }

  // Build hierarchy via Transform components (classId = 4 or 224)
  const parentMap = new Map<string, string>(); // transform fileId -> parent transform fileId
  const transformToGo = new Map<string, string>(); // transform fileId -> gameObject fileId
  const goToTransform = new Map<string, string>(); // gameObject fileId -> transform fileId

  for (const doc of docs) {
    if (doc.classId !== '4' && doc.classId !== '224') continue;

    const goRef = /m_GameObject:\s*\{fileID:\s*(\d+)\}/.exec(doc.content);
    if (goRef) {
      transformToGo.set(doc.fileId, goRef[1]);
      goToTransform.set(goRef[1], doc.fileId);
    }

    const fatherRef = /m_Father:\s*\{fileID:\s*(\d+)\}/.exec(doc.content);
    if (fatherRef && fatherRef[1] !== '0') {
      parentMap.set(doc.fileId, fatherRef[1]);
    }
  }

  // Build children lists
  for (const [transformId, parentTransformId] of parentMap) {
    const childGoId = transformToGo.get(transformId);
    const parentGoId = transformToGo.get(parentTransformId);
    if (childGoId && parentGoId) {
      const parentGo = gameObjects.get(parentGoId);
      const childGo = gameObjects.get(childGoId);
      if (parentGo && childGo) {
        parentGo.children.push(childGo);
      }
    }
  }

  // Root objects: those whose transform has no parent
  const rootObjects: SceneGameObject[] = [];
  for (const [goId, go] of gameObjects) {
    const transformId = goToTransform.get(goId);
    if (transformId && !parentMap.has(transformId)) {
      rootObjects.push(go);
    }
  }

  return {
    gameObjects: Array.from(gameObjects.values()),
    rootObjects,
  };
}
