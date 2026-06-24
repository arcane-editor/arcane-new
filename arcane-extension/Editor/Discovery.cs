// Discovery.cs — find the IDE's Unix socket path.
//
// PRIMARY: read <projectRoot>/Library/ArcaneIDE/bridge.json, which the IDE writes
// when it opens the project:
//   { "transport":"unix", "socketPath":"/tmp/unity-ide-<sha1hex>.sock",
//     "protocolVersion":1, "ideVersion":"x.y.z", "idePid":12345 }
// We read `socketPath` verbatim from that file. The file is the source of truth
// because the IDE computes the hash from ITS canonical view of the project path.
//
// projectRoot is the folder ABOVE Assets/. Unity's Application.dataPath is
// "<projectRoot>/Assets", so projectRoot = Directory.GetParent(dataPath).
//
// FALLBACK (best-effort): if the file is absent, compute the path ourselves as
//   /tmp/unity-ide-<sha1(canonicalProjectPath)>.sock
// where canonicalProjectPath is the absolute, symlink-resolved project root.
// This matches the IDE's compute_pipe_path() (sha1 hex lowercase of the
// canonicalized path). It can MISMATCH if symlinks resolve differently between
// the two processes — which is exactly why the discovery file exists. Prefer the
// file; treat the fallback as a convenience for the first-launch race.

using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Arcane.Bridge
{
    internal struct BridgeDiscovery
    {
        public string SocketPath;
        public int ProtocolVersion;
        public string IdeVersion;
        public int IdePid;
        /// <summary>True when these values came from bridge.json (authoritative).</summary>
        public bool FromFile;
    }

    internal static class Discovery
    {
        public const int ProtocolVersion = 1; // bridge wire-protocol major version

        /// <summary>projectRoot = parent of Application.dataPath ("…/Assets").</summary>
        public static string ProjectRoot(string applicationDataPath)
        {
            // Directory.GetParent on "…/Assets" yields the project root.
            var parent = Directory.GetParent(applicationDataPath.TrimEnd('/', '\\'));
            return parent != null ? parent.FullName : applicationDataPath;
        }

        public static string BridgeJsonPath(string projectRoot) =>
            Path.Combine(projectRoot, "Library", "ArcaneIDE", "bridge.json");

        /// <summary>
        /// Attempt discovery. Returns true and fills <paramref name="result"/> when
        /// a socket path is available (from the file, or via the SHA1 fallback).
        /// Never throws — I/O and parse errors degrade to the fallback.
        /// </summary>
        public static bool TryResolve(string projectRoot, out BridgeDiscovery result)
        {
            result = default;

            // 1) Authoritative: the discovery file.
            try
            {
                string file = BridgeJsonPath(projectRoot);
                if (File.Exists(file))
                {
                    string text = File.ReadAllText(file);
                    var json = JsonValue.TryParse(text);
                    if (json != null && json.IsObject)
                    {
                        string sock = json["socketPath"].AsString;
                        if (!string.IsNullOrEmpty(sock))
                        {
                            result = new BridgeDiscovery
                            {
                                SocketPath = sock,
                                ProtocolVersion = json["protocolVersion"].IsNumber
                                    ? json["protocolVersion"].AsInt : ProtocolVersion,
                                IdeVersion = json["ideVersion"].AsStringOr(""),
                                IdePid = json["idePid"].AsInt,
                                FromFile = true,
                            };
                            return true;
                        }
                    }
                }
            }
            catch
            {
                // fall through to the computed fallback
            }

            // 2) Fallback: compute the path the same way the IDE does.
            try
            {
                string canonical = Canonicalize(projectRoot);
                string sock = "/tmp/unity-ide-" + Sha1Hex(canonical) + ".sock";
                result = new BridgeDiscovery
                {
                    SocketPath = sock,
                    ProtocolVersion = ProtocolVersion,
                    IdeVersion = "",
                    IdePid = 0,
                    FromFile = false,
                };
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Absolute, symlink-resolved path. .NET on macOS does not expose a direct
        /// realpath, so we resolve via the canonical full path; symlink components
        /// may remain unresolved (documented mismatch risk vs. the IDE's
        /// std::fs::canonicalize). The discovery file avoids this entirely.
        /// </summary>
        private static string Canonicalize(string path)
        {
            try
            {
                // GetFullPath normalizes separators and "." / ".." but does NOT
                // resolve symlinks. It is the closest portable approximation.
                return Path.GetFullPath(path);
            }
            catch
            {
                return path;
            }
        }

        private static string Sha1Hex(string input)
        {
            using (var sha1 = SHA1.Create())
            {
                byte[] hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(input));
                var sb = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash)
                    sb.Append(b.ToString("x2")); // lowercase hex, matches Rust format!("{:x}")
                return sb.ToString();
            }
        }
    }
}
