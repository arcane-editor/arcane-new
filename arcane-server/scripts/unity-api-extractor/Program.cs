// Unity API signature extractor.
//
// Reflects (reflection-ONLY, via MetadataLoadContext — never executes Unity
// code) over a Unity Editor install's managed assemblies and emits a JSON array
// of exact, version-pinned API signatures with deprecation flags. This is the
// authoritative half of the version-accurate API grounding; the JSON is fed to
// scripts/ingest-unity-docs.mjs which loads it into D1 + Vectorize.
//
// Usage:
//   dotnet run --project scripts/unity-api-extractor -- \
//     --managed "/Applications/Unity/Hub/Editor/6000.0.30f1/Unity.app/Contents/Managed" \
//     --version 6000.0 \
//     --out ./out/api-6000.0.json
//
// You can pass --managed multiple times (e.g. the Editor Managed dir AND a
// project's Library/ScriptAssemblies for package APIs).

using System.Reflection;
using System.Text;
using System.Text.Json;

var managedDirs = new List<string>();
string? version = null;
string outPath = "./out/api.json";

for (int i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--managed": managedDirs.Add(args[++i]); break;
        case "--version": version = args[++i]; break;
        case "--out": outPath = args[++i]; break;
    }
}

if (managedDirs.Count == 0 || version is null)
{
    Console.Error.WriteLine("Usage: --managed <dir> [--managed <dir> ...] --version <major.minor> [--out file]");
    return 1;
}

// Collect every DLL from the managed dirs + the running .NET runtime (so base
// types like System.Object resolve under MetadataLoadContext).
var dllPaths = new List<string>();
foreach (var dir in managedDirs)
{
    if (!Directory.Exists(dir)) { Console.Error.WriteLine($"WARN: missing dir {dir}"); continue; }
    dllPaths.AddRange(Directory.GetFiles(dir, "*.dll", SearchOption.AllDirectories));
}
var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
dllPaths.AddRange(Directory.GetFiles(runtimeDir, "*.dll"));
dllPaths = dllPaths.Distinct().ToList();

var resolver = new PathAssemblyResolver(dllPaths);
using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");

var records = new List<Record>();
var docBase = $"https://docs.unity3d.com/{version}/Documentation/ScriptReference";
int asmCount = 0;

foreach (var path in dllPaths)
{
    var fileName = Path.GetFileNameWithoutExtension(path);
    if (!IsUnityAssembly(fileName)) continue;

    Assembly asm;
    try { asm = mlc.LoadFromAssemblyPath(path); }
    catch { continue; }

    Type[] types;
    try { types = asm.GetTypes(); }
    catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray()!; }

    foreach (var type in types)
    {
        if (type is null || !type.IsPublic && !type.IsNestedPublic) continue;
        if (type.Namespace is null || !type.Namespace.StartsWith("Unity")) continue;
        ExtractType(type, asm.GetName().Name ?? "", docBase, records);
    }
    asmCount++;
}

Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
var json = JsonSerializer.Serialize(records, new JsonSerializerOptions { WriteIndented = false });
File.WriteAllText(outPath, json);
Console.WriteLine($"Extracted {records.Count} API records from {asmCount} Unity assemblies → {outPath}");
return 0;

static bool IsUnityAssembly(string name) =>
    name.StartsWith("UnityEngine") || name.StartsWith("UnityEditor") || name.StartsWith("Unity.");

static void ExtractType(Type type, string assembly, string docBase, List<Record> records)
{
    var ns = type.Namespace ?? "";
    var typeName = type.Name;

    // The type itself (so "what is Rigidbody" grounds too).
    Try(() =>
    {
        var (typeDep, typeMsg) = ReadObsolete(type.GetCustomAttributesData());
        var typeKeyword = type.IsEnum ? "enum" : type.IsValueType ? "struct" : type.IsInterface ? "interface" : "class";
        records.Add(new Record("", ns, typeName, typeName,
            type.IsEnum ? "enum" : "type",
            $"public {typeKeyword} {typeName}",
            null, assembly, typeDep, typeMsg, $"{docBase}/{typeName}.html"));
    });

    const BindingFlags Flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    // Methods grouped by name → overloads. Each member is wrapped in Try() so a
    // single member whose signature references an unresolvable assembly is
    // skipped, not fatal (reflection-only loading can't resolve everything).
    var methodsByName = new Dictionary<string, List<MethodInfo>>();
    foreach (var m in Safe(() => type.GetMethods(Flags)) ?? Array.Empty<MethodInfo>())
    {
        if (m.IsSpecialName) continue; // skip property/event accessors
        (methodsByName.TryGetValue(m.Name, out var l) ? l : methodsByName[m.Name] = new()).Add(m);
    }
    foreach (var (name, overloads) in methodsByName)
    {
        Try(() =>
        {
            var sigs = overloads.Select(MethodSig).ToList();
            var (dep, msg) = ReadObsolete(overloads[0].GetCustomAttributesData());
            records.Add(new Record("", ns, typeName, name, "method", sigs[0], sigs.Count > 1 ? sigs : null,
                assembly, dep, msg, $"{docBase}/{typeName}.{name}.html"));
        });
    }

    foreach (var p in Safe(() => type.GetProperties(Flags)) ?? Array.Empty<PropertyInfo>())
    {
        Try(() =>
        {
            var (dep, msg) = ReadObsolete(p.GetCustomAttributesData());
            records.Add(new Record("", ns, typeName, p.Name, "property",
                $"{Vis(p.GetMethod)} {TypeName(p.PropertyType)} {p.Name} {{ {(p.CanRead ? "get; " : "")}{(p.CanWrite ? "set; " : "")}}}",
                null, assembly, dep, msg, $"{docBase}/{typeName}-{p.Name}.html"));
        });
    }

    foreach (var f in Safe(() => type.GetFields(Flags)) ?? Array.Empty<FieldInfo>())
    {
        if (!f.IsPublic) continue;
        Try(() =>
        {
            var (dep, msg) = ReadObsolete(f.GetCustomAttributesData());
            records.Add(new Record("", ns, typeName, f.Name, f.IsLiteral ? "const" : "field",
                $"{TypeName(f.FieldType)} {f.Name}", null, assembly, dep, msg, $"{docBase}/{typeName}-{f.Name}.html"));
        });
    }

    foreach (var e in Safe(() => type.GetEvents(Flags)) ?? Array.Empty<EventInfo>())
    {
        Try(() =>
        {
            var (dep, msg) = ReadObsolete(e.GetCustomAttributesData());
            var handler = e.EventHandlerType is { } et ? TypeName(et) : "Delegate";
            records.Add(new Record("", ns, typeName, e.Name, "event",
                $"event {handler} {e.Name}", null, assembly, dep, msg, $"{docBase}/{typeName}-{e.Name}.html"));
        });
    }
}

static void Try(Action a) { try { a(); } catch { /* skip unresolvable member */ } }
static T? Safe<T>(Func<T> f) where T : class { try { return f(); } catch { return null; } }

static string MethodSig(MethodInfo m)
{
    var ps = string.Join(", ", m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}"));
    var generics = m.IsGenericMethodDefinition ? "<" + string.Join(", ", m.GetGenericArguments().Select(a => a.Name)) + ">" : "";
    return $"{TypeName(m.ReturnType)} {m.Name}{generics}({ps})";
}

static string Vis(MethodBase? m) => m is null ? "public" : m.IsPublic ? "public" : m.IsFamily ? "protected" : "public";

static string TypeName(Type t)
{
    if (t.IsByRef) return "ref " + TypeName(t.GetElementType()!);
    if (t.IsArray) return TypeName(t.GetElementType()!) + "[]";
    if (t.IsGenericType)
    {
        var baseName = t.Name.Contains('`') ? t.Name[..t.Name.IndexOf('`')] : t.Name;
        var argList = string.Join(", ", t.GetGenericArguments().Select(TypeName));
        return $"{baseName}<{argList}>";
    }
    return t.Name switch
    {
        "Void" => "void", "Int32" => "int", "Single" => "float", "Boolean" => "bool",
        "String" => "string", "Double" => "double", "Object" => "object", _ => t.Name,
    };
}

static (bool deprecated, string? message) ReadObsolete(IList<CustomAttributeData> attrs)
{
    foreach (var a in attrs)
    {
        try
        {
            if (a.AttributeType.Name != "ObsoleteAttribute") continue;
            var msg = a.ConstructorArguments.Count > 0 ? a.ConstructorArguments[0].Value as string : null;
            return (true, msg);
        }
        catch
        {
            // Attribute type lives in an unresolvable assembly — ignore it.
        }
    }
    return (false, null);
}

// JSON keys match the server's UnityApiRecord exactly. `unityVersion` is left
// empty here — the ingest script stamps the real version per run. `member`
// equals the type name for type/enum rows.
record Record(
    string unityVersion, string @namespace, string type, string member, string kind,
    string signature, List<string>? overloads, string assembly,
    bool deprecated, string? obsoleteMessage, string docUrl);
