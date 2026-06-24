// Manual-test fixture for the Unity performance analyzers (T4.3) + near-miss (T4.1).
// Each member is annotated with the EXPECTED analyzer behaviour. These files are
// documentation/manual fixtures — they are not auto-run. Open this file in a
// Unity project with `unity.analyzers.enabled` to see the diagnostics live.

using System.Collections;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

public class PerformanceRules : MonoBehaviour
{
    private Rigidbody _rb;
    private Animator _animator;

    // ── getcomponent-in-update (UNITY0201) ──────────────────────────────────
    void Update()
    {
        // EXPECTED: warning — GetComponent in Update (quick-fix: cache + Awake).
        var rb = GetComponent<Rigidbody>();
        rb.AddForce(Vector3.up);

        // EXPECTED: warning — FindObjectOfType in Update.
        var cam = FindObjectOfType<Camera>();

        // EXPECTED: warning — GameObject.Find in Update.
        var player = GameObject.Find("Player");

        // ── camera-main (UNITY0202) — version-gated ─────────────────────────
        // EXPECTED: warning ONLY when project Unity version < 2020.2.
        var c = Camera.main;

        // ── alloc-in-update (UNITY0205/0206/0207/0208) — info ───────────────
        // EXPECTED: info — LINQ allocates each frame.
        var bigs = new List<int>().Where(x => x > 0).ToList();
        // EXPECTED: info — `new` reference type each frame.
        var list = new List<int>();
        // EXPECTED: info — string concat in a loop.
        string s = "";
        for (int i = 0; i < 10; i++)
        {
            s += "x";
        }
        // EXPECTED: NOT flagged — `new Vector3` is a struct (value type).
        var v = new Vector3(1, 2, 3);
    }

    // ── deltatime-in-fixedupdate (UNITY0303) ────────────────────────────────
    void FixedUpdate()
    {
        // EXPECTED: warning — deltaTime in FixedUpdate (quick-fix: fixedDeltaTime).
        transform.position += Vector3.up * Time.deltaTime;
        // EXPECTED: NOT flagged — fixedDeltaTime is correct here.
        float step = Time.fixedDeltaTime;
    }

    // ── string-apis (UNITY0203/0204) ────────────────────────────────────────
    void DoStuff()
    {
        // EXPECTED: info — Invoke with string literal (suggest nameof).
        Invoke("DelayedCall", 1f);
        // EXPECTED: info — SendMessage string literal.
        SendMessage("OnHit");
        // EXPECTED: info — Animator SetFloat string (quick-fix: StringToHash).
        _animator.SetFloat("Speed", 1f);
        // EXPECTED: NOT flagged — already uses a hash id.
        _animator.SetTrigger(Animator.StringToHash("Jump"));
    }

    void DelayedCall() { }

    // ── empty-messages (UNITY0209) ──────────────────────────────────────────
    // EXPECTED: warning — empty Update-family message (quick-fix: delete).
    void LateUpdate()
    {
    }

    // ── waitforseconds-in-loop (UNITY0210) ──────────────────────────────────
    IEnumerator Pulse()
    {
        while (true)
        {
            // EXPECTED: warning — new WaitForSeconds allocated each iteration.
            yield return new WaitForSeconds(0.5f);
        }
    }

    IEnumerator GoodPulse()
    {
        // EXPECTED: NOT flagged — cached instance reused.
        var wait = new WaitForSeconds(0.5f);
        while (true)
        {
            yield return wait;
        }
    }
}

// ── near-miss-messages (UNITY0001/0002/0003) ────────────────────────────────
public class NearMissRules : MonoBehaviour
{
    // EXPECTED: warning — wrong casing 'update' → 'Update' (quick-fix).
    void update() { }

    // EXPECTED: warning — accidentally static 'Start' (quick-fix: remove static).
    static void Start() { }

    // EXPECTED: warning — wrong param type Collider should be Collision (quick-fix).
    void OnCollisionEnter(Collider other) { }

    // EXPECTED: warning — 2D trigger needs Collider2D, not Collider.
    void OnTriggerEnter2D(Collider other) { }

    // EXPECTED: NOT flagged — correct signature.
    void OnCollisionExit(Collision other) { }

    // EXPECTED: NOT flagged — unrelated method, no near-miss to any message.
    void HandleInput() { }

    // EXPECTED: NOT flagged — correctly cased and typed.
    void Awake() { }
}

// EXPECTED: nothing in this class is flagged by Unity-message rules — it is not
// a MonoBehaviour/ScriptableObject, so it receives no Unity messages.
public class PlainClass
{
    void update() { }
    void OnCollisionEnter(Collider c) { }
}
