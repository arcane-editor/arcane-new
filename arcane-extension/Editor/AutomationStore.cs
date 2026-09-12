using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace UnityIDE.Bridge
{
    // Durable operation identity. A disconnected caller queries rather than repeats.
    internal static class AutomationStore
    {
        internal static string DirectoryPath => Path.Combine(Discovery.ProjectRoot(Application.dataPath), "Library", "UnityIDE", "automation");
        internal static string Id(string id)
        {
            if (string.IsNullOrEmpty(id) || !Regex.IsMatch(id, "^[A-Za-z0-9_-]{1,96}$"))
                throw new ArgumentException("Invalid operation id.");
            return id;
        }
        internal static string AssetPath(string path)
        {
            if (string.IsNullOrEmpty(path) || !path.StartsWith("Assets/", StringComparison.Ordinal) || path.Contains("\\") || path.Contains(".."))
                throw new ArgumentException("Use a project-relative Assets path without traversal.");
            string full = Path.GetFullPath(path);
            string root = Path.GetFullPath(Application.dataPath) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Path outside Assets.");
            for (string current = full; current != null && current.Length >= root.Length; current = Path.GetDirectoryName(current))
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new ArgumentException("Automation does not follow asset symlinks.");
            return path;
        }
        internal static JsonValue Report(string id, string status, string reason = null)
        {
            var result = JsonValue.NewObject(); result["operationId"] = id; result["status"] = status;
            if (reason != null) result["reason"] = reason;
            return result;
        }
        internal static string Hash(string value)
        {
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "");
        }
        internal static void Save(string kind, string id, JsonValue value)
        {
            Directory.CreateDirectory(DirectoryPath);
            string path = Path.Combine(DirectoryPath, kind + "-" + Id(id) + ".json");
            string temporary = path + ".tmp";
            File.WriteAllText(temporary, value.Serialize());
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
        }
        internal static JsonValue Read(string kind, string id)
        {
            string path = Path.Combine(DirectoryPath, kind + "-" + Id(id) + ".json");
            return File.Exists(path) ? JsonValue.Parse(File.ReadAllText(path)) : Report(id, "unsupported", "Unknown operation.");
        }
    }

    // The optional Input System assembly registers this adapter without imposing
    // an Input System package dependency on every Unity project.
    public interface IAutomationInput : IDisposable
    {
        void Send(string device, string control, float[] values);
    }
    public static class AutomationInput
    {
        public static Func<IAutomationInput> Create;
    }
}
