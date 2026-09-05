import { useEffect, useRef, useState, type ReactElement } from "react";

/**
 * "Every Unity file opens as itself."
 *
 * A generic editor opens .asset, .prefab, .uxml and .inputactions as thousands
 * of lines of serialized YAML/JSON. UnityIDE routes each one to a real editor —
 * that ladder is `EditorPanel.tsx`, and this panel is that ladder made visible:
 * the raw serialization resolves into the native editor the app actually gives
 * that file type.
 *
 * The raw/resolved split is the page's one colour rule: unresolved is
 * monochrome and dim, resolved lights up. Nothing else on the site uses it, so
 * it stays the signature rather than becoming decoration.
 */

type FileKind = {
  /** Real filename — these are what appear in a Unity project, not stand-ins. */
  name: string;
  /** Where it sits, shown in the title bar. */
  dir: string;
  /** What every other editor hands you. */
  raw: string;
  /** What the native editor is called, in the app's own words. */
  nativeLabel: string;
  /** The honest size of the raw form, so the contrast is a fact not a mood. */
  rawNote: string;
  render: () => ReactElement;
};

const swatch = "inline-block h-2 w-2 shrink-0 rounded-[2px]";

/** One label/value row of a Unity Inspector. */
function Field({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-border/30 py-[7px] last:border-0">
      <span className="w-[120px] shrink-0 truncate text-[12px] text-muted-foreground">{label}</span>
      <span
        className={`truncate font-mono text-[12px] ${accent ? "text-primary" : "text-foreground/90"}`}
      >
        {value}
      </span>
    </div>
  );
}

/** One row of the prefab/scene hierarchy, indented by depth. */
function Node({
  depth,
  name,
  components,
}: {
  depth: number;
  name: string;
  components?: string[];
}) {
  return (
    <div
      className="flex items-center gap-2 py-[5px] text-[12px]"
      style={{ paddingLeft: `${depth * 14}px` }}
    >
      <span className={`${swatch} bg-primary/70`} />
      <span className="text-foreground/90">{name}</span>
      {components?.map((c) => (
        <span
          key={c}
          className="rounded border border-border/60 bg-secondary/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

const FILES: FileKind[] = [
  {
    name: "PlayerStats.asset",
    dir: "Assets/Data",
    rawNote: "412 lines of YAML",
    nativeLabel: "ScriptableObject inspector",
    raw: `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_Script: {fileID: 11500000, guid: 8f3c1a2d9b7e
  m_Name: PlayerStats
  maxHealth: 100
  moveSpeed: 5.5`,
    render: () => (
      <div>
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className={`${swatch} bg-primary`} />
          <span className="font-mono">PlayerStats</span>
          <span className="text-muted-foreground/60">· ScriptableObject</span>
        </div>
        <Field label="Max Health" value="100" />
        <Field label="Move Speed" value="5.5" />
        <Field label="Jump Force" value="12" />
        <Field label="Damage Curve" value="AnimationCurve" />
        <Field label="Starting Weapon" value="Pistol.asset" accent />
      </div>
    ),
  },
  {
    name: "Player.prefab",
    dir: "Assets/Prefabs",
    rawNote: "1,847 lines of YAML",
    nativeLabel: "Prefab hierarchy",
    raw: `--- !u!1 &6438273645192837465
GameObject:
  m_Component:
  - component: {fileID: 6438273645192837466}
  - component: {fileID: 6438273645192837467}
  m_Name: Player
  m_TagString: Player
--- !u!4 &6438273645192837466
Transform:
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_Children:
  - {fileID: 8812094471029384756}`,
    render: () => (
      <div>
        <Node depth={0} name="Player" components={["Transform", "Rigidbody"]} />
        <Node depth={1} name="Model" components={["MeshRenderer"]} />
        <Node depth={1} name="Camera Rig" />
        <Node depth={2} name="Main Camera" components={["Camera"]} />
        <Node depth={1} name="Weapon Socket" />
        <Node depth={2} name="Pistol" components={["WeaponBehaviour"]} />
      </div>
    ),
  },
  {
    name: "MainMenu.uxml",
    dir: "Assets/UI",
    rawNote: "markup, no preview",
    nativeLabel: "Live UI canvas",
    raw: `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="project://database/Assets/UI/Menu.uss" />
  <ui:VisualElement name="root" class="menu-root">
    <ui:Label text="NEON DRIFT" class="menu-title" />
    <ui:Button text="Play" name="play" class="btn" />
    <ui:Button text="Garage" name="garage" class="btn" />
    <ui:Button text="Quit" name="quit" class="btn" />
  </ui:VisualElement>
</ui:UXML>`,
    render: () => (
      <div className="flex h-full items-center justify-center">
        {/* The stage is deliberately letterboxed — it is a game viewport, and
            the aspect ratio is the thing that says so. */}
        <div className="relative w-full max-w-[320px] rounded-md border border-border/50 bg-[hsl(220_30%_8%)] px-8 py-6 text-center">
          <p className="mb-4 font-display text-lg font-bold tracking-[0.18em] text-primary">
            NEON DRIFT
          </p>
          {["Play", "Garage", "Quit"].map((b, i) => (
            <div
              key={b}
              className={`mb-2 rounded border px-3 py-1.5 text-[12px] ${
                i === 0
                  ? "border-primary/60 bg-primary/15 text-primary"
                  : "border-border/60 text-muted-foreground"
              }`}
            >
              {b}
            </div>
          ))}
          <span className="absolute bottom-1.5 right-2 font-mono text-[9px] text-muted-foreground/40">
            1920 &times; 1080
          </span>
        </div>
      </div>
    ),
  },
  {
    name: "Gameplay.inputactions",
    dir: "Assets/Input",
    rawNote: "620 lines of JSON",
    nativeLabel: "Input action maps",
    raw: `{
  "name": "Gameplay",
  "maps": [
    {
      "name": "Player",
      "id": "9f2b1c4a-7d3e-4a11-b0c8-5e6f7a8b9c0d",
      "actions": [
        { "name": "Move", "type": "Value",
          "expectedControlType": "Vector2" },
        { "name": "Jump", "type": "Button" }
      ],`,
    render: () => (
      <div className="grid grid-cols-[104px_1fr] gap-4">
        <div className="border-r border-border/40 pr-3">
          <p className="mb-2 text-[11px] text-muted-foreground">Action maps</p>
          {["Player", "UI", "Vehicle"].map((m, i) => (
            <div
              key={m}
              className={`rounded px-2 py-1 text-[12px] ${
                i === 0 ? "bg-primary/15 text-primary" : "text-muted-foreground"
              }`}
            >
              {m}
            </div>
          ))}
        </div>
        <div>
          <p className="mb-2 text-[11px] text-muted-foreground">Bindings</p>
          {[
            ["Move", "WASD · Left Stick"],
            ["Jump", "Space · Button South"],
            ["Fire", "Mouse Left · RT"],
            ["Look", "Delta · Right Stick"],
          ].map(([a, b]) => (
            <div key={a} className="flex items-baseline gap-2 py-[5px] text-[12px]">
              <span className="w-14 shrink-0 text-foreground/90">{a}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">{b}</span>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    name: "PlayerController.cs",
    dir: "Assets/Scripts",
    rawNote: "plain C#, no Unity context",
    nativeLabel: "Unity-aware C#",
    raw: `public class PlayerController : MonoBehaviour
{
    [SerializeField] private float speed = 5f;
    private Rigidbody rb;

    void Awake() => rb = GetComponent<Rigidbody>();

    void Update()
    {
        var h = Input.GetAxis("Horizontal");
        rb.AddForce(Vector3.right * h * speed);
    }
}`,
    render: () => (
      <div className="font-mono text-[11.5px] leading-[1.7]">
        {[
          { g: "", t: "public class PlayerController : MonoBehaviour", c: "text-foreground/90" },
          { g: "", t: "{", c: "text-muted-foreground" },
          { g: "S", t: "    [SerializeField] private float speed = 5f;", c: "text-muted-foreground" },
          { g: "", t: "    private Rigidbody rb;", c: "text-muted-foreground" },
          { g: "", t: "", c: "" },
          { g: "▶", t: "    void Awake() => rb = GetComponent<Rigidbody>();", c: "text-foreground/90" },
          { g: "", t: "", c: "" },
          { g: "▶", t: "    void Update()", c: "text-foreground/90" },
          { g: "", t: "    {", c: "text-muted-foreground" },
          { g: "!", t: "        var h = Input.GetAxis(\"Horizontal\");", c: "text-muted-foreground" },
        ].map((l, i) => (
          <div key={i} className="flex gap-2">
            <span
              className={`w-3 shrink-0 text-right text-[10px] ${
                l.g === "!" ? "text-destructive" : "text-primary"
              }`}
              aria-hidden="true"
            >
              {l.g}
            </span>
            <span className={`truncate ${l.c}`}>{l.t || " "}</span>
          </div>
        ))}
        <div className="mt-2 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5">
          <span className="mt-px text-[10px] text-destructive">!</span>
          <span className="text-[11px] leading-snug text-muted-foreground">
            Legacy input in a project using the Input System package
          </span>
        </div>
      </div>
    ),
  },
];

/** Raw text renders as one dim block — it is scenery for the resolve, not
 *  something anyone is meant to read. */
function RawBlock({ text }: { text: string }) {
  return (
    <pre className="overflow-hidden whitespace-pre font-mono text-[11px] leading-[1.65] text-muted-foreground/45">
      {text}
    </pre>
  );
}

const CYCLE_MS = 4600;
const RAW_MS = 900;

const UnityNativePanel = () => {
  const [index, setIndex] = useState(0);
  const [resolved, setResolved] = useState(false);
  /** A click means the visitor is steering; stop moving under them. */
  const [pinned, setPinned] = useState(false);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // The resolve, per file. Reduced motion gets the answer with no theatre.
  useEffect(() => {
    if (reduced.current) {
      setResolved(true);
      return;
    }
    setResolved(false);
    const t = setTimeout(() => setResolved(true), RAW_MS);
    return () => clearTimeout(t);
  }, [index]);

  useEffect(() => {
    if (pinned) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % FILES.length), CYCLE_MS);
    return () => clearTimeout(t);
  }, [index, pinned]);

  const file = FILES[index];

  return (
    <div className="relative">
      <div className="absolute -inset-4 rounded-2xl bg-primary/5 blur-3xl" />

      <div className="relative overflow-hidden rounded-xl border border-border/50 ide-shadow">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-border/50 bg-secondary/80 px-4 py-3">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-destructive/70" />
            <span className="h-3 w-3 rounded-full bg-primary/50" />
            <span className="h-3 w-3 rounded-full bg-green-500/50" />
          </div>
          <span className="ml-2 truncate font-mono text-xs text-muted-foreground">
            {file.dir}/{file.name}
          </span>
          <img src="/icon.png" alt="" className="ml-auto h-4 w-4 rounded-sm" />
        </div>

        {/* File tabs — real Unity extensions, which is the whole argument */}
        <div
          className="flex gap-px overflow-x-auto border-b border-border/50 bg-background/60"
          role="tablist"
          aria-label="Unity file types"
        >
          {FILES.map((f, i) => (
            <button
              key={f.name}
              role="tab"
              aria-selected={i === index}
              onClick={() => {
                setIndex(i);
                setPinned(true);
              }}
              className={`whitespace-nowrap border-b-2 px-3 py-2 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                i === index
                  ? "border-primary bg-background text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.name.slice(f.name.indexOf("."))}
            </button>
          ))}
        </div>

        {/* Body — fixed height so switching files never shifts the page */}
        <div className="relative h-[268px] overflow-hidden bg-background/95 p-4">
          <div
            className={`absolute inset-0 p-4 transition-opacity duration-500 ${
              resolved ? "opacity-0" : "opacity-100"
            }`}
            aria-hidden={resolved}
          >
            <RawBlock text={file.raw} />
          </div>
          <div
            className={`absolute inset-0 overflow-hidden p-4 transition-opacity duration-500 ${
              resolved ? "opacity-100" : "opacity-0"
            }`}
            aria-hidden={!resolved}
          >
            {file.render()}
          </div>
        </div>

        {/* Caption — states the trade plainly, and is the only place the two
            halves are named. */}
        <div className="flex items-center justify-between gap-3 border-t border-border/50 bg-secondary/60 px-4 py-2.5 text-[11px]">
          <span className="truncate text-muted-foreground/70">
            Elsewhere: {file.rawNote}
          </span>
          <span
            className={`truncate font-medium transition-colors duration-500 ${
              resolved ? "text-primary" : "text-muted-foreground/40"
            }`}
          >
            {file.nativeLabel}
          </span>
        </div>
      </div>
    </div>
  );
};

export default UnityNativePanel;
