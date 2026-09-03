// Discovery.cs — locate the IDE's journal directory and read its session identity.
//
// <projectRoot>/Library/UnityIDE/bridge.json is written by the IDE when it opens
// the project:
//   { "transport":"journal", "protocolVersion":2, "ideSessionId":"…",
//     "ideVersion":"x.y.z", "idePid":12345 }
//
// There is NO computed fallback. The socket transport needed one because it had a
// path to guess; a journal has nothing to derive — the files sit at a fixed
// location relative to the project. That also retires the sha1(projectRoot)
// fallback whose symlink mismatch (Rust's std::fs::canonicalize resolves
// symlinks, .NET's Path.GetFullPath does not) silently sent the two sides to
// different socket paths on any project under a symlinked directory.
//
// projectRoot is the folder ABOVE Assets/. Unity's Application.dataPath is
// "<projectRoot>/Assets", so projectRoot = Directory.GetParent(dataPath).

using System.IO;

namespace UnityIDE.Bridge
{
    internal struct BridgeDiscovery
    {
        /// <summary>Fresh per IDE workspace-open. A change means "new IDE session — re-handshake".</summary>
        public string IdeSessionId;
        public int ProtocolVersion;
        public string IdeVersion;
        public int IdePid;
    }

    internal static class Discovery
    {
        /// <summary>
        /// Bridge wire-protocol major version.
        ///   2 = journal transport.
        ///   3 = queued commands: refreshAssets/requestCompile answer
        ///       `{queued:true}` on ACCEPTANCE and report real completion with
        ///       `refresh_completed`.
        ///
        /// The bump is what keeps an IDE that predates 3 safe. Such an IDE reads
        /// an rpc_response to refreshAssets as "the import finished", so handing
        /// it a queued ack would make it report a clean no-op compile for a file
        /// Unity has not looked at — the exact bug queueing exists to fix,
        /// re-created by updating only the Unity package. RpcDispatcher compares
        /// the IDE's advertised version against this and keeps the old blocking
        /// behaviour for anything older.
        /// </summary>
        public const int ProtocolVersion = 3;

        /// <summary>projectRoot = parent of Application.dataPath ("…/Assets").</summary>
        public static string ProjectRoot(string applicationDataPath)
        {
            var parent = Directory.GetParent(applicationDataPath.TrimEnd('/', '\\'));
            return parent != null ? parent.FullName : applicationDataPath;
        }

        public static string BridgeDir(string projectRoot)
        {
            return Path.Combine(Path.Combine(projectRoot, "Library"), "UnityIDE");
        }

        public static string BridgeJsonPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "bridge.json");
        }

        // Unity writes to-ide.jsonl and reads to-unity.jsonl. Ownership follows
        // from that: Unity owns to-unity.ack (it is that journal's reader) and
        // to-ide.epoch (it is that journal's writer); the IDE owns the mirror pair.
        // Every file therefore has exactly one writer and nothing needs locking.
        public static string ToIdeJournalPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "to-ide.jsonl");
        }

        public static string ToIdeAckPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "to-ide.ack");
        }

        public static string ToUnityJournalPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "to-unity.jsonl");
        }

        public static string ToUnityAckPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "to-unity.ack");
        }

        /// <summary>
        /// Read bridge.json. False when it is absent (no IDE has the project open),
        /// unreadable, or carries no ideSessionId (nothing to handshake against).
        /// Never throws.
        /// </summary>
        public static bool TryResolve(string projectRoot, out BridgeDiscovery result)
        {
            result = default(BridgeDiscovery);
            try
            {
                string file = BridgeJsonPath(projectRoot);
                if (!File.Exists(file)) return false;

                JsonValue json = JsonValue.TryParse(File.ReadAllText(file));
                if (json == null || !json.IsObject) return false;

                string sessionId = json["ideSessionId"].AsString;
                if (string.IsNullOrEmpty(sessionId)) return false;

                result = new BridgeDiscovery
                {
                    IdeSessionId = sessionId,
                    ProtocolVersion = json["protocolVersion"].IsNumber
                        ? json["protocolVersion"].AsInt : ProtocolVersion,
                    IdeVersion = json["ideVersion"].AsStringOr(""),
                    IdePid = json["idePid"].AsInt,
                };
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
