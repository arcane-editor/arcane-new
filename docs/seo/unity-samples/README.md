# Unity editorial verification fixture

This isolated Unity project exercises the examples behind the serialized-field,
UI Toolkit query, and prefab-merge guides. It deliberately does not test or rank
any IDE. IntelliSense verification requires a separate language-server check.

With Unity 6000.3.5f2 installed, run from this project directory:

```sh
/Applications/Unity/Hub/Editor/6000.3.5f2/Unity.app/Contents/MacOS/Unity \
  -batchmode -nographics -projectPath "$PWD" \
  -executeMethod UnityIdeSeoSamples.GuideVerification.Run \
  -quit -logFile /tmp/unityide-seo-guides.log
```

Check the process exit status and `Evidence/report.json`. Success produces
`UNITYIDE_SEO_GUIDES_PASS` in the log. Generated asset fixtures, merge output,
library, and logs are ignored. Preserve a concise reviewed evidence record
outside this project when promoting a draft.

Coverage is intentionally narrow: actual Unity asset import/reserialization,
actual imported UXML query matching, and actual UnityYAMLMerge plus prefab
reimport. It does not cover UI document lifecycle in Play Mode, every kind of
serialization migration, conflicting edits to the same property, or a full
platform/Unity-version matrix. Do not describe these missing checks as passed.
