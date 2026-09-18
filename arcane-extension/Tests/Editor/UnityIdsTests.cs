#if UNITYIDE_HAS_TEST_FRAMEWORK
using System;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityIDE.Bridge;

namespace UnityIDE.Tests
{
    /// <summary>
    /// UnityIds is the package's only seam for the instance-id → entity-id
    /// rename, and the editor on the build machine has exactly one of its
    /// shapes. The stand-in structs below reproduce the others — 6.4+ (a 64-bit
    /// value with ToULong/FromULong and a distinct None) and 6.3 (an int-backed
    /// struct with implicit int conversions) — so every branch is exercised no
    /// matter which Unity runs the suite.
    /// </summary>
    public class UnityIdsTests
    {
        /// <summary>The 6.4+ shape. None is deliberately NOT default, to catch a converter that assumes zero.</summary>
        public struct FakeEntityId64 : IEquatable<FakeEntityId64>
        {
            public ulong Data;
            public static FakeEntityId64 None => new FakeEntityId64 { Data = ulong.MaxValue };
            public static ulong ToULong(FakeEntityId64 id) => id.Data;
            public static FakeEntityId64 FromULong(ulong raw) => new FakeEntityId64 { Data = raw };
            public bool Equals(FakeEntityId64 other) => Data == other.Data;
            public override bool Equals(object obj) => obj is FakeEntityId64 other && Equals(other);
            public override int GetHashCode() => Data.GetHashCode();
        }

        /// <summary>The 6.3 shape: int-backed, implicit conversions both ways, no ToULong.</summary>
        public struct FakeEntityId32 : IEquatable<FakeEntityId32>
        {
            public int Data;
            public static FakeEntityId32 None => default(FakeEntityId32);
            public static implicit operator int(FakeEntityId32 id) => id.Data;
            public static implicit operator FakeEntityId32(int value) => new FakeEntityId32 { Data = value };
            public bool Equals(FakeEntityId32 other) => Data == other.Data;
            public override bool Equals(object obj) => obj is FakeEntityId32 other && Equals(other);
            public override int GetHashCode() => Data;
        }

        [Test]
        public void SixtyFourBitIdsRoundTripExactlyAndUseNoneAsUnassigned()
        {
            var ids = UnityIds.IdConverter.For(typeof(FakeEntityId64));
            Assert.IsTrue(ids.CanConvert); Assert.IsTrue(ids.Is64Bit);
            ulong beyondDouble = (1UL << 53) + 1, beyondInt = (1UL << 40) | 7, topBit = 1UL << 63;
            foreach (ulong raw in new[] { 0UL, 1UL, beyondDouble, beyondInt, topBit, ulong.MaxValue - 1 })
            {
                string wire = ids.Raw(FakeEntityId64.FromULong(raw));
                Assert.AreEqual(raw.ToString(), wire);
                ulong parsed; Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of(wire), out parsed));
                Assert.AreEqual(FakeEntityId64.FromULong(raw), ids.FromRaw(parsed));
            }
            Assert.AreEqual(FakeEntityId64.None, ids.Unassigned);
            Assert.IsTrue(ids.IsUnassigned(FakeEntityId64.None));
            Assert.IsFalse(ids.IsUnassigned(default(FakeEntityId64)), "default(EntityId) is not the unassigned id when None says otherwise");
        }

        [Test]
        public void IntBackedIdsRoundTripThroughTheImplicitConversions()
        {
            var ids = UnityIds.IdConverter.For(typeof(FakeEntityId32));
            Assert.IsTrue(ids.CanConvert); Assert.IsFalse(ids.Is64Bit);
            foreach (int value in new[] { 0, 42, -42, int.MinValue, int.MaxValue })
            {
                string wire = ids.Raw((FakeEntityId32)value);
                Assert.AreEqual(value.ToString(), wire);
                ulong parsed; Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of(wire), out parsed));
                Assert.AreEqual((FakeEntityId32)value, ids.FromRaw(parsed));
            }
            Assert.IsTrue(ids.IsUnassigned(FakeEntityId32.None));
            Assert.IsFalse(ids.IsUnassigned((FakeEntityId32)5));
        }

        [Test]
        public void PlainIntIdsAreTheirOwnWireForm()
        {
            var ids = UnityIds.IdConverter.For(typeof(int));
            Assert.AreEqual("-7", ids.Raw(-7));
            ulong parsed; Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of("-7"), out parsed));
            Assert.AreEqual(-7, ids.FromRaw(parsed));
            Assert.IsTrue(ids.IsUnassigned(0)); Assert.IsFalse(ids.IsUnassigned(1));
        }

        [Test]
        public void WireIdsParseAsStringsOrNumbersAndRejectEverythingElse()
        {
            ulong raw;
            Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of("18446744073709551615"), out raw)); Assert.AreEqual(ulong.MaxValue, raw);
            Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of(" 12 "), out raw)); Assert.AreEqual(12UL, raw);
            Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of("-5"), out raw)); Assert.AreEqual(unchecked((ulong)-5L), raw);
            Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of(-5), out raw)); Assert.AreEqual(unchecked((ulong)-5L), raw);
            Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of(9007199254740992d), out raw)); Assert.AreEqual(1UL << 53, raw);
            foreach (var bad in new[] { JsonValue.Of(""), JsonValue.Of("abc"), JsonValue.Of("1.5"), JsonValue.Of(1.5), JsonValue.Of(true), JsonValue.Null, null })
                Assert.IsFalse(UnityIds.TryParseRaw(bad, out raw), bad == null ? "null" : bad.Serialize());
            Assert.IsTrue(UnityIds.IsId(JsonValue.Of("3"))); Assert.IsFalse(UnityIds.IsId(JsonValue.Of("Player")));
            Assert.AreEqual("3", UnityIds.Describe(JsonValue.Of("3"))); Assert.AreEqual("3", UnityIds.Describe(JsonValue.Of(3)));
        }

        /// <summary>
        /// Runs <paramref name="body"/> in a fresh empty scene and leaves a clean
        /// untitled scene behind, so a later fixture's additive NewScene is not
        /// refused for an unsaved scene this one dirtied.
        /// </summary>
        private static void InACleanScene(Action body)
        {
            for (int i = 0; i < SceneManager.sceneCount; i++)
                if (SceneManager.GetSceneAt(i).isDirty) Assert.Ignore("Needs a clean editor scene; no user scene was discarded.");
            var setup = EditorSceneManager.GetSceneManagerSetup();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            try { body(); }
            finally
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                if (setup.Length > 0 && Array.TrueForAll(setup, s => !string.IsNullOrEmpty(s.path))) EditorSceneManager.RestoreSceneManagerSetup(setup);
            }
        }

        [Test]
        public void LiveObjectsRoundTripThroughTheirWireIdInEitherForm() => InACleanScene(() =>
        {
            var go = new GameObject("UnityIds_" + Guid.NewGuid().ToString("N"));
            var collider = go.AddComponent<BoxCollider>();
            try
            {
                string id = UnityIds.IdOf(go);
                Assert.IsNotNull(id); ulong raw; Assert.IsTrue(UnityIds.TryParseRaw(JsonValue.Of(id), out raw), id);
                Assert.AreSame(go, UnityIds.ToObject(JsonValue.Of(id)), "string form");
                Assert.AreSame(go, UnityIds.ToObject(JsonValue.Of(long.Parse(id))), "numeric form sent by older IDE builds");
                Assert.AreSame(collider, UnityIds.ToObject(JsonValue.Of(UnityIds.IdOf(collider))));
                Assert.AreNotEqual(UnityIds.IdOf(go), UnityIds.IdOf(collider));
                Assert.IsNull(UnityIds.ToObject(JsonValue.Of("not-an-id")));

                var target = JsonValue.NewObject(); target["instanceId"] = id;
                Assert.AreSame(go, HierarchyHandlers.ResolveGameObject(target), "ResolveGameObject by string id");
                target["instanceId"] = UnityIds.IdOf(collider);
                Assert.AreSame(go, HierarchyHandlers.ResolveGameObject(target), "a component id resolves to its GameObject");
                target["instanceId"] = long.Parse(id);
                Assert.AreSame(go, HierarchyHandlers.ResolveGameObject(target), "ResolveGameObject by numeric id");

                var node = HierarchySerializer.SerializeGameObject(go, new HierarchySerializer.Budget(10000));
                Assert.IsTrue(node["instanceId"].IsString, "ids cross the wire as strings so 64-bit values survive JSON");
                Assert.AreEqual(id, node["instanceId"].AsString);
            }
            finally { UnityEngine.Object.DestroyImmediate(go); }
            Assert.IsNull(UnityIds.ToObject(JsonValue.Of(UnityIds.IdOf(go))), "a destroyed object resolves to null, not a stale wrapper");
        });

        [Test]
        public void MissingReferencesAreDetectedAndUnassignedOnesAreNot() => InACleanScene(() =>
        {
            {
                var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
                var filter = cube.GetComponent<MeshFilter>();
                var meshProperty = new SerializedObject(filter).FindProperty("m_Mesh");
                Assert.IsTrue(UnityIds.IsReferenceSet(meshProperty), "the built-in cube mesh is a set reference");
                Assert.DoesNotThrow(() => AuthoringHandlers.AssertPersistentDependencies(cube.scene),
                    "unassigned references (a root's m_Father, m_CorrespondingSourceObject…) must not read as missing");

                filter.sharedMesh = null;
                Assert.IsFalse(UnityIds.IsReferenceSet(new SerializedObject(filter).FindProperty("m_Mesh")), "an emptied slot is unassigned");

                var transient = new Mesh();
                filter.sharedMesh = transient;
                UnityEngine.Object.DestroyImmediate(transient);
                var dangling = new SerializedObject(filter).FindProperty("m_Mesh");
                Assert.IsNull(dangling.objectReferenceValue);
                Assert.IsTrue(UnityIds.IsReferenceSet(dangling), "a destroyed target leaves its id behind");
                var error = Assert.Throws<InvalidOperationException>(() => AuthoringHandlers.AssertPersistentDependencies(cube.scene));
                StringAssert.Contains("Missing reference", error.Message);
                StringAssert.Contains("m_Mesh", error.Message);
            }
        });
    }
}
#endif
