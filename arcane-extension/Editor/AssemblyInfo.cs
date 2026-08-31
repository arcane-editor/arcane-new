using System.Reflection;
using System.Runtime.CompilerServices;

[assembly: AssemblyTitle("UnityIDE.Editor")]
[assembly: AssemblyDescription("UnityIDE Integration for Unity Editor")]
[assembly: AssemblyCompany("UnityIDE")]
[assembly: AssemblyProduct("UnityIDE Integration")]
[assembly: AssemblyCopyright("Copyright © 2026 UnityIDE")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("1.0.0")]

// The test assembly (Tests/Editor/UnityIDE.Editor.Tests.asmdef) exercises types
// that are deliberately internal — Discovery, Journal, and the launcher's
// argument building. Without this it cannot see any of them, and every test in
// that assembly fails to compile.
//
// `using System.Runtime.CompilerServices` has sat unused at the top of this file
// since it was written, which is where this attribute was meant to be. Nothing
// caught the omission: CI does not compile the C# package, and the Tests folder
// is stripped from the shipped UPM package by scripts/sync-unity-bridge.mjs.
[assembly: InternalsVisibleTo("UnityIDE.Editor.Tests")]
