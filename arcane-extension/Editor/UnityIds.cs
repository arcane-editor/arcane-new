// UnityIds.cs — the one seam for Unity's instance-id → entity-id rename.
//
// Unity is retiring 32-bit instance ids for the opaque EntityId struct, and the
// rename lands one member per release rather than all at once:
//
//   6000.3  EntityId (still int-backed), Object.GetEntityId and
//           EditorUtility.EntityIdToObject appear; InstanceIDToObject(int) is
//           obsolete (warning). SerializedProperty.objectReferenceEntityIdValue
//           appears in a LATER 6.3 patch than 6000.3.5, where the old name
//           becomes obsolete-as-error.
//   6000.4  EntityId.ToULong/FromULong appear; the implicit int conversions and
//           Object.GetInstanceID are obsolete (warning).
//   6000.5  EntityId is 8 bytes and every obsolete InstanceID API is a compile
//           ERROR.
//   6000.6  EditorUtility.InstanceIDToObject(int) and the implicit int→EntityId
//           conversion are runtime stubs that throw NotImplementedException.
//
// The package supports 2021.3 upward, so no name on either side of the rename
// can be written literally, and because 6.3's own boundary falls inside a patch
// series no `#if UNITY_x_y_OR_NEWER` can name it either. Every member is
// resolved here by reflection, once, newest first. The raw id crosses the wire
// as a decimal STRING: a 64-bit EntityId does not survive a JSON double (exact
// only to 2^53) on either side, and the IDE only ever echoes it back.
//
// Inputs are accepted as either a string or a number so that IDE builds and
// AI tool calls that still send the pre-0.4.2 numeric form keep resolving.

using System;
using System.Globalization;
using System.Reflection;
using UnityEditor;
using UnityIDE.Editor;

namespace UnityIDE.Bridge
{
    internal static class UnityIds
    {
        private const BindingFlags PublicStatic = BindingFlags.Public | BindingFlags.Static;
        private const BindingFlags PublicInstance = BindingFlags.Public | BindingFlags.Instance;

        /// <summary>
        /// Converts between an editor's id type and its raw wire form. Resolved
        /// against whatever <c>Object.GetEntityId</c> returns (<c>EntityId</c>
        /// from 6.3) or, on older editors, <c>int</c>. Internal so the 6.4+
        /// shape — which no editor on the build machine may have — can be
        /// exercised against a stand-in struct in the test assembly.
        /// </summary>
        internal sealed class IdConverter
        {
            public readonly Type IdType;
            /// <summary>The id of "no object": <c>EntityId.None</c>, or 0 for int.</summary>
            public readonly object Unassigned;
            private readonly MethodInfo _toULong;   // 6.4+: static ulong ToULong(EntityId), or an instance ToULong()
            private readonly MethodInfo _fromULong; // 6.4+: static EntityId FromULong(ulong)
            private readonly MethodInfo _toInt;     // 6.3:  static int op_Implicit(EntityId)
            private readonly MethodInfo _fromInt;   // 6.3:  static EntityId op_Implicit(int) / From(int)

            private IdConverter(Type idType, object unassigned, MethodInfo toULong, MethodInfo fromULong, MethodInfo toInt, MethodInfo fromInt)
            {
                IdType = idType; Unassigned = unassigned;
                _toULong = toULong; _fromULong = fromULong; _toInt = toInt; _fromInt = fromInt;
            }

            public static IdConverter For(Type idType)
            {
                if (idType == null) throw new ArgumentNullException("idType");
                if (idType == typeof(int)) return new IdConverter(idType, 0, null, null, null, null);

                MethodInfo toULong = idType.GetMethod("ToULong", PublicStatic, null, new[] { idType }, null)
                                  ?? idType.GetMethod("ToULong", PublicInstance, null, Type.EmptyTypes, null);
                if (toULong != null && toULong.ReturnType != typeof(ulong)) toULong = null;
                MethodInfo fromULong = idType.GetMethod("FromULong", PublicStatic, null, new[] { typeof(ulong) }, null);
                if (fromULong != null && fromULong.ReturnType != idType) fromULong = null;

                MethodInfo toInt = null, fromInt = null;
                foreach (MethodInfo m in idType.GetMethods(PublicStatic))
                {
                    if (m.Name != "op_Implicit" && m.Name != "op_Explicit") continue;
                    ParameterInfo[] ps = m.GetParameters();
                    if (ps.Length != 1) continue;
                    if (toInt == null && m.ReturnType == typeof(int) && ps[0].ParameterType == idType) toInt = m;
                    else if (fromInt == null && m.ReturnType == idType && ps[0].ParameterType == typeof(int)) fromInt = m;
                }
                if (fromInt == null)
                {
                    MethodInfo from = idType.GetMethod("From", PublicStatic, null, new[] { typeof(int) }, null);
                    if (from != null && from.ReturnType == idType) fromInt = from;
                }

                object none = null;
                PropertyInfo noneProperty = idType.GetProperty("None", PublicStatic);
                if (noneProperty != null && noneProperty.PropertyType == idType) none = noneProperty.GetValue(null, null);
                else
                {
                    FieldInfo noneField = idType.GetField("None", PublicStatic);
                    if (noneField != null && noneField.FieldType == idType) none = noneField.GetValue(null);
                }
                if (none == null) none = Activator.CreateInstance(idType);

                return new IdConverter(idType, none, toULong, fromULong, toInt, fromInt);
            }

            /// <summary>False when the editor's id type offers no numeric round trip at all.</summary>
            public bool CanConvert => IdType == typeof(int) || (_toULong != null && _fromULong != null) || (_toInt != null && _fromInt != null);

            /// <summary>Prefers the 64-bit round trip: it is the only one that is neither lossy nor a throwing stub on 6.5+.</summary>
            public bool Is64Bit => IdType != typeof(int) && _toULong != null && _fromULong != null;

            public string Raw(object id)
            {
                if (IdType == typeof(int)) return ((int)id).ToString(CultureInfo.InvariantCulture);
                if (_toULong != null && _fromULong != null)
                {
                    object raw = _toULong.IsStatic ? _toULong.Invoke(null, new[] { id }) : _toULong.Invoke(id, null);
                    return ((ulong)raw).ToString(CultureInfo.InvariantCulture);
                }
                if (_toInt != null) return ((int)_toInt.Invoke(null, new[] { id })).ToString(CultureInfo.InvariantCulture);
                throw new NotSupportedException(IdType.FullName + " offers neither ToULong nor an int conversion; ids cannot be serialized on this Unity version.");
            }

            public object FromRaw(ulong raw)
            {
                if (IdType == typeof(int)) return unchecked((int)raw);
                if (_toULong != null && _fromULong != null) return _fromULong.Invoke(null, new object[] { raw });
                if (_fromInt != null) return _fromInt.Invoke(null, new object[] { unchecked((int)raw) });
                throw new NotSupportedException(IdType.FullName + " offers neither FromULong nor an int conversion; ids cannot be resolved on this Unity version.");
            }

            public bool IsUnassigned(object id) => id == null || id.Equals(Unassigned);
        }

        /// <summary>
        /// Parse a wire id: a decimal string (what this package sends), or a
        /// number (what pre-0.4.2 IDE builds and integer tool arguments send).
        /// Negative values are the pre-6.5 runtime-object ids and round-trip
        /// through the two's-complement ulong unchanged.
        /// </summary>
        internal static bool TryParseRaw(JsonValue value, out ulong raw)
        {
            raw = 0;
            if (value == null) return false;
            if (value.IsString)
            {
                string s = value.AsString.Trim();
                if (s.Length == 0) return false;
                if (ulong.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out raw)) return true;
                long signed;
                if (!long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out signed)) return false;
                raw = unchecked((ulong)signed);
                return true;
            }
            if (value.IsNumber)
            {
                double d = value.AsNumber;
                if (double.IsNaN(d) || double.IsInfinity(d) || d != Math.Floor(d)) return false;
                if (d < long.MinValue || d >= 18446744073709551616.0) return false;
                raw = d < 0 ? unchecked((ulong)(long)d) : (ulong)d;
                return true;
            }
            return false;
        }

        // ── The running editor's API, resolved once ──────────────────────────

        private sealed class Api
        {
            public readonly MethodInfo GetEntityId;        // 6.3+
            public readonly MethodInfo GetInstanceID;      // pre-6.5 (obsolete from 6.4, an error from 6.5)
            public readonly IdConverter Ids;
            public readonly MethodInfo EntityIdToObject;   // 6.3+
            public readonly MethodInfo InstanceIDToObject; // pre-6.6 (a throwing stub on 6.6)
            public readonly PropertyInfo ObjectReferenceId; // SerializedProperty.objectReferenceEntityIdValue, else ...InstanceIDValue
            public readonly IdConverter ReferenceIds;
            public readonly string Problem;

            public Api(Type objectType, Type editorUtilityType, Type serializedPropertyType)
            {
                GetEntityId = objectType.GetMethod("GetEntityId", PublicInstance, null, Type.EmptyTypes, null);
                GetInstanceID = objectType.GetMethod("GetInstanceID", PublicInstance, null, Type.EmptyTypes, null);
                Type idType = GetEntityId != null ? GetEntityId.ReturnType : typeof(int);
                Ids = IdConverter.For(idType);
                EntityIdToObject = GetEntityId == null ? null
                    : editorUtilityType.GetMethod("EntityIdToObject", PublicStatic, null, new[] { idType }, null);
                InstanceIDToObject = editorUtilityType.GetMethod("InstanceIDToObject", PublicStatic, null, new[] { typeof(int) }, null);
                ObjectReferenceId = serializedPropertyType.GetProperty("objectReferenceEntityIdValue", PublicInstance)
                                 ?? serializedPropertyType.GetProperty("objectReferenceInstanceIDValue", PublicInstance);
                ReferenceIds = ObjectReferenceId == null ? null
                    : ObjectReferenceId.PropertyType == idType ? Ids : IdConverter.For(ObjectReferenceId.PropertyType);

                if (GetEntityId == null && GetInstanceID == null) Problem = "UnityEngine.Object has neither GetEntityId nor GetInstanceID";
                else if (!Ids.CanConvert) Problem = idType.FullName + " has no numeric round trip";
                else if (EntityIdToObject == null && InstanceIDToObject == null) Problem = "EditorUtility has neither EntityIdToObject nor InstanceIDToObject";
            }
        }

        private static Api _api;
        private static bool _reported;

        private static Api Current
        {
            get
            {
                if (_api == null)
                {
                    _api = new Api(typeof(UnityEngine.Object), typeof(EditorUtility), typeof(SerializedProperty));
                    if (_api.Problem != null && !_reported)
                    {
                        _reported = true;
                        UnityIDELog.Error("Object ids cannot be resolved on this Unity version (" + _api.Problem +
                                          "). Address scene objects by hierarchy path or globalObjectId until the package is updated.");
                    }
                }
                return _api;
            }
        }

        /// <summary>The object's session id in its wire form — a decimal string.</summary>
        public static string IdOf(UnityEngine.Object obj)
        {
            if ((object)obj == null) return null;
            Api api = Current;
            object id;
            if (api.GetEntityId != null && api.Ids.CanConvert) id = Invoke(api.GetEntityId, obj, null);
            else if (api.GetInstanceID != null) return ((int)Invoke(api.GetInstanceID, obj, null)).ToString(CultureInfo.InvariantCulture);
            else throw new NotSupportedException(api.Problem);
            return api.Ids.Raw(id);
        }

        /// <summary>True when the value can address an object by id (a numeric string or a number).</summary>
        public static bool IsId(JsonValue value)
        {
            ulong raw;
            return TryParseRaw(value, out raw);
        }

        /// <summary>The id as text for refusal messages.</summary>
        public static string Describe(JsonValue value) => value == null ? "" : value.IsString ? value.AsString : value.Serialize();

        /// <summary>
        /// The live object for a wire id, or null when it is unparseable, names
        /// nothing, or names an object that has since been destroyed.
        /// </summary>
        public static UnityEngine.Object ToObject(JsonValue value)
        {
            ulong raw;
            if (!TryParseRaw(value, out raw)) return null;
            Api api = Current;
            UnityEngine.Object obj;
            if (api.EntityIdToObject != null && api.Ids.CanConvert)
                obj = (UnityEngine.Object)Invoke(api.EntityIdToObject, null, new[] { api.Ids.FromRaw(raw) });
            else if (api.InstanceIDToObject != null)
                obj = (UnityEngine.Object)Invoke(api.InstanceIDToObject, null, new object[] { unchecked((int)raw) });
            else
                return null;
            return obj == null ? null : obj; // Unity's == folds a destroyed object to null
        }

        /// <summary>
        /// Whether an ObjectReference property holds an id at all. Combined with
        /// a null <c>objectReferenceValue</c> that is a reference to an object
        /// that no longer exists. When no editor accessor can be found the id is
        /// unreadable, so this reports "not set": refusing a save that is in fact
        /// fine is worse than letting one assertion go unenforced.
        /// </summary>
        public static bool IsReferenceSet(SerializedProperty property)
        {
            Api api = Current;
            if (api.ObjectReferenceId == null || api.ReferenceIds == null) return false;
            object id = api.ObjectReferenceId.GetValue(property, null);
            return !api.ReferenceIds.IsUnassigned(id);
        }

        private static object Invoke(MethodInfo method, object target, object[] args)
        {
            try { return method.Invoke(target, args); }
            catch (TargetInvocationException e) when (e.InnerException != null)
            {
                throw new InvalidOperationException(method.DeclaringType.Name + "." + method.Name + " failed on this Unity version: " + e.InnerException.Message, e.InnerException);
            }
        }
    }
}
