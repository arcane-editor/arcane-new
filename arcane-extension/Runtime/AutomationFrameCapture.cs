#if UNITY_EDITOR
using System;
using System.Collections;
using UnityEngine;

namespace UnityIDE.Automation
{
    // Compiles out of player builds. A runtime assembly is needed because Unity
    // cannot attach an Editor-assembly MonoBehaviour to a live GameObject.
    public sealed class AutomationFrameCapture : MonoBehaviour
    {
        public static void Capture(Action<byte[], string> completed)
        {
            var go = new GameObject("UnityIDE frame capture") { hideFlags = HideFlags.HideAndDontSave };
            DontDestroyOnLoad(go);
            go.AddComponent<AutomationFrameCapture>().StartCoroutine(Record(go, completed));
        }

        private static IEnumerator Record(GameObject owner, Action<byte[], string> completed)
        {
            yield return new WaitForEndOfFrame();
            Texture2D texture = null;
            try
            {
                texture = ScreenCapture.CaptureScreenshotAsTexture();
                if (texture == null || texture.width == 0 || texture.height == 0) throw new InvalidOperationException("Game view did not render.");
                // Keep screenshots below the journal and model transport budgets.
                if (texture.width > 1280 || texture.height > 1280)
                {
                    float ratio = 1280f / Mathf.Max(texture.width, texture.height);
                    var rt = RenderTexture.GetTemporary(Mathf.RoundToInt(texture.width * ratio), Mathf.RoundToInt(texture.height * ratio), 0);
                    var previous = RenderTexture.active;
                    try {
                        Graphics.Blit(texture, rt); RenderTexture.active = rt;
                        var scaled = new Texture2D(rt.width, rt.height, TextureFormat.RGB24, false);
                        scaled.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0); scaled.Apply();
                        Destroy(texture); texture = scaled;
                    } finally { RenderTexture.active = previous; RenderTexture.ReleaseTemporary(rt); }
                }
                var bytes = texture.EncodeToPNG();
                if (bytes.Length > 2 * 1024 * 1024) throw new InvalidOperationException("Capture exceeds 2 MiB.");
                completed(bytes, null);
            }
            catch (Exception e) { completed(null, e.Message); }
            finally { if (texture != null) Destroy(texture); Destroy(owner); }
        }
    }
}
#endif
