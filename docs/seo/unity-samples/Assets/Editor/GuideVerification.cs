using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;

namespace UnityIdeSeoSamples
{
    // A deliberately small, disposable fixture. It does not open a user's project.
    public static class GuideVerification
    {
        private const string Generated = "Assets/Generated";
        private static readonly List<string> Passed = new List<string>();

        [Serializable]
        private class Report
        {
            public string unityVersion;
            public string platform;
            public string verifiedAt;
            public string[] passed;
            public string failure;
        }

        public static void Run()
        {
            Directory.CreateDirectory(Generated);
            Directory.CreateDirectory("Evidence");
            var report = new Report
            {
                unityVersion = Application.unityVersion,
                platform = SystemInfo.operatingSystem,
                verifiedAt = DateTime.UtcNow.ToString("O")
            };
            try
            {
                EditorSettings.serializationMode = SerializationMode.ForceText;
                AssetDatabase.Refresh();
                VerifyFieldMigration();
                VerifyQueries();
                VerifyPrefabMerge();
                report.passed = Passed.ToArray();
                File.WriteAllText("Evidence/report.json", JsonUtility.ToJson(report, true));
                Debug.Log("UNITYIDE_SEO_GUIDES_PASS: " + string.Join(", ", Passed));
            }
            catch (Exception error)
            {
                report.passed = Passed.ToArray();
                report.failure = error.ToString();
                File.WriteAllText("Evidence/report.json", JsonUtility.ToJson(report, true));
                Debug.LogException(error);
                EditorApplication.Exit(1);
            }
        }

        private static void Require(bool condition, string description)
        {
            if (!condition) throw new InvalidOperationException(description);
            Passed.Add(description);
        }

        private static void VerifyFieldMigration()
        {
            var path = Generated + "/Weapon.asset";
            AssetDatabase.DeleteAsset(path);
            var weapon = ScriptableObject.CreateInstance<WeaponStats>();
            weapon.damage = 73;
            AssetDatabase.CreateAsset(weapon, path);
            AssetDatabase.SaveAssets();
            var yaml = File.ReadAllText(path);
            Require(yaml.Contains("damage: 73"), "Serialized sample contains non-default damage 73");
            // Recreate a pre-rename asset with the old key. This tests Editor
            // deserialization, not a runtime JsonUtility save-game migration.
            File.WriteAllText(path, yaml.Replace("damage: 73", "oldDamage: 73"));
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
            weapon = AssetDatabase.LoadAssetAtPath<WeaponStats>(path);
            Require(weapon != null && weapon.damage == 73, "FormerlySerializedAs preserves oldDamage 73 on asset import");
            AssetDatabase.ForceReserializeAssets(new[] { path });
            var saved = File.ReadAllText(path);
            Require(saved.Contains("damage: 73") && !saved.Contains("oldDamage:"), "Reserialized asset uses new field name and preserves value");
            File.Copy(path, "Evidence/Weapon.asset", true);
        }

        private static void VerifyQueries()
        {
            var source = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>("Assets/Samples/MainMenu.uxml");
            Require(source != null, "Sample UXML imports into a VisualTreeAsset");
            var root = source.CloneTree();
            Require(root.Q<Button>("play") != null, "Q<Button> finds matching name and type");
            Require(root.Q<Button>("play-btn") == null, "A mismatched UXML name returns null");
            Require(root.Q<Label>("play") == null, "A mismatched visual element type returns null");
            Require(root.Q<Button>(className: "primary") != null, "A class selector finds the button");
            Require(new VisualElement().Q<Button>("play") == null, "A different visual tree does not find the button");
        }

        private static void VerifyPrefabMerge()
        {
            var path = Generated + "/Merge.prefab";
            var root = new GameObject("MergeFixture");
            var left = new GameObject("Left");
            var right = new GameObject("Right");
            left.transform.SetParent(root.transform);
            right.transform.SetParent(root.transform);
            try
            {
                PrefabUtility.SaveAsPrefabAsset(root, path);
                File.Copy(path, "Evidence/base.prefab", true);
                left.transform.localPosition = new Vector3(1, 0, 0);
                PrefabUtility.SaveAsPrefabAsset(root, path);
                File.Copy(path, "Evidence/remote.prefab", true);
                left.transform.localPosition = Vector3.zero;
                right.transform.localPosition = new Vector3(0, 2, 0);
                PrefabUtility.SaveAsPrefabAsset(root, path);
                File.Copy(path, "Evidence/local.prefab", true);
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }

            var executable = Path.Combine(EditorApplication.applicationContentsPath, "Tools", "UnityYAMLMerge");
            if (Application.platform == RuntimePlatform.WindowsEditor) executable += ".exe";
            Require(File.Exists(executable), "UnityYAMLMerge exists in this Editor installation");
            var start = new ProcessStartInfo
            {
                FileName = executable,
                Arguments = "merge -p \"" + Path.GetFullPath("Evidence/base.prefab") + "\" \"" +
                    Path.GetFullPath("Evidence/remote.prefab") + "\" \"" +
                    Path.GetFullPath("Evidence/local.prefab") + "\" \"" +
                    Path.GetFullPath("Evidence/merged.prefab") + "\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            using (var process = Process.Start(start))
            {
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(30000)) { process.Kill(); throw new TimeoutException("UnityYAMLMerge exceeded 30 seconds"); }
                File.WriteAllText("Evidence/merge.log", stdout.GetAwaiter().GetResult() + "\n" + stderr.GetAwaiter().GetResult());
                Require(process.ExitCode == 0, "UnityYAMLMerge accepts independent changes");
            }
            File.Copy("Evidence/merged.prefab", path, true);
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
            var merged = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            Require(merged != null, "Merged prefab imports into Unity");
            Require(merged.transform.Find("Left").localPosition == new Vector3(1, 0, 0), "Merge retains remote Left position");
            Require(merged.transform.Find("Right").localPosition == new Vector3(0, 2, 0), "Merge retains local Right position");
        }
    }
}
