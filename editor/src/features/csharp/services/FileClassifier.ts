export enum FilePriority {
    MonoBehaviour = 0,
    EditorScript = 1,
    Other = 2,
}

/**
 * Classifies a .cs file into a priority tier based on its path.
 * MonoBehaviour/runtime scripts (Assets/ but not Assets/Editor/) come first,
 * then editor scripts (Assets/Editor/), then everything else.
 */
export function classifyFile(relativePath: string): FilePriority {
    const normalized = relativePath.replace(/\\/g, '/');

    if (normalized.startsWith('Assets/')) {
        if (normalized.startsWith('Assets/Editor/')) {
            return FilePriority.EditorScript;
        }
        return FilePriority.MonoBehaviour;
    }

    return FilePriority.Other;
}

/**
 * Sorts file paths by priority: runtime scripts > editor scripts > other.
 */
export function sortFilesByPriority(files: string[]): string[] {
    return [...files].sort((a, b) => {
        const priorityA = classifyFile(a);
        const priorityB = classifyFile(b);
        return priorityA - priorityB;
    });
}
