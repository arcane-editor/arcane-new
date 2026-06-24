// Manual-test fixture for the Unity correctness analyzers (T4.4) + serialization (T4.2).
// Each member is annotated with the EXPECTED analyzer behaviour. Documentation /
// manual fixture only — not auto-run.

using System.Collections.Generic;
using UnityEngine;
// using UnityEngine.Serialization;  // FormerlySerializedAs adds this on rename.

public class CorrectnessRules : MonoBehaviour
{
    // ── serialization: serialized-field detection (T4.2) ────────────────────
    // EXPECTED: renaming this field offers FormerlySerializedAs (public => serialized).
    public int health;
    // EXPECTED: renaming this offers FormerlySerializedAs ([SerializeField] private).
    [SerializeField] private float speed;
    // EXPECTED: NOT serialized — [NonSerialized] public field, no FSA on rename.
    [System.NonSerialized] public int runtimeOnly;
    // EXPECTED: NOT serialized — private without [SerializeField].
    private int _internal;
    // EXPECTED: NOT serialized — static field.
    public static int Shared;

    // ── non-serializable-types (UNITY0101/0102/0103) ────────────────────────
    // EXPECTED: warning — Dictionary is not Unity-serializable.
    [SerializeField] private Dictionary<string, int> _lookup;
    // EXPECTED: warning — nested generic collection.
    [SerializeField] private List<List<int>> _grid;
    // EXPECTED: warning — interface field (quick-fix: add [SerializeReference]).
    [SerializeField] private IDamageable _target;
    // EXPECTED: NOT flagged — already opts into polymorphic serialization.
    [SerializeReference] private IDamageable _ok;
    // EXPECTED: NOT flagged — plain serializable list of a value type.
    [SerializeField] private List<int> _numbers;
    // EXPECTED: NOT flagged — Vector3 is a serializable Unity struct.
    [SerializeField] private Vector3 _offset;

    private Transform _cachedTransform;

    void Start()
    {
        // ── null-propagation-unity-object (UNITY0301) ───────────────────────
        Rigidbody rb = GetComponent<Rigidbody>();
        // EXPECTED: warning — ?. bypasses Unity's lifetime check (Unity type).
        rb?.Sleep();
        // EXPECTED: warning — ?? bypasses Unity's lifetime check.
        var t = _cachedTransform ?? transform;
        // EXPECTED: warning — `is null` bypasses Unity check (quick-fix: == null).
        if (rb is null) { }
        // EXPECTED: warning — `is not null` (quick-fix: != null).
        if (rb is not null) { }
        // EXPECTED: NOT flagged — explicit != null is the correct form.
        if (rb != null) { }

        // ── destroy-this (UNITY0302) ────────────────────────────────────────
        // EXPECTED: info — Destroy(this) destroys only the component.
        Destroy(this);
        // EXPECTED: NOT flagged — destroys the whole GameObject.
        Destroy(gameObject);

        // ── transform-position-per-axis (UNITY0304) ─────────────────────────
        // EXPECTED: info — position read 3+ times; cache into a local.
        float x = transform.position.x;
        float y = transform.position.y;
        float z = transform.position.z;
    }

    void Move()
    {
        // EXPECTED: info — transform.position assigned twice in sequence.
        transform.position = new Vector3(1, 0, 0);
        transform.position = new Vector3(0, 1, 0);
    }
}

public interface IDamageable
{
    void Damage(int amount);
}

// ── editor-api-in-runtime (UNITY0305) ───────────────────────────────────────
// EXPECTED: ERROR — `using UnityEditor;` in a runtime assembly (Assembly-CSharp).
//           Quick-fix: wrap file in #if UNITY_EDITOR.
//   using UnityEditor;   // (left commented so this fixture still parses cleanly)
public class RuntimeUsesEditor : MonoBehaviour
{
    void Setup()
    {
        // EXPECTED: ERROR — UnityEditor.* member access in a runtime assembly.
        //   UnityEditor.AssetDatabase.Refresh();

        // EXPECTED: NOT flagged — wrapped in an editor guard.
#if UNITY_EDITOR
        UnityEditor.EditorUtility.SetDirty(this);
#endif
    }
}

// EXPECTED: a file under an `Editor/` folder, or in an editor-only asmdef, is
// SILENT for editor-api-in-runtime even with `using UnityEditor;` at the top.
