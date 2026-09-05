import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

/**
 * The Resolve — the page's one argument, and its one orchestrated moment.
 *
 * A generic editor opens `.asset`, `.prefab`, `.uxml` and `.inputactions` as
 * thousands of lines of serialized YAML/JSON. UnityIDE routes each one to a real
 * editor; that ladder is `EditorPanel.tsx` in the app, and this panel is the
 * ladder made visible.
 *
 * It is a SPLIT, not a cross-fade in a single box. Both halves are on screen at
 * once — left is what every other editor hands you, right is what this one does
 * with the same bytes — so the trade reads without anyone having to remember
 * what was there a second ago. The resolve animates on the right only.
 *
 * The page's colour rule lives here: unresolved is monochrome and dim, resolved
 * lights up. Nothing else on the site earns colour for decoration, which is what
 * keeps this the signature rather than a texture.
 */

/* ── Inspector grammar ─────────────────────────────────────────────────────
   A fixed label column beside a monospace value is how Unity's Inspector reads,
   and reusing it is most of why the resolved half looks like the engine. */

function Field({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: string;
  tone?: "plain" | "accent" | "pass";
}) {
  const valueTone =
    tone === "accent" ? "text-primary" : tone === "pass" ? "text-pass" : "text-foreground/90";
  return (
    <div className="flex items-baseline gap-3 border-b border-border/40 py-[7px] last:border-0">
      <span className="w-[104px] shrink-0 truncate text-micro text-muted-foreground">{label}</span>
      <span className={`truncate font-mono text-micro ${valueTone}`}>{value}</span>
    </div>
  );
}

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
      className="flex items-center gap-2 py-[5px] text-mini"
      style={{ paddingLeft: `${depth * 14}px` }}
    >
      <span className="h-2 w-2 shrink-0 rounded-chip bg-primary/70" />
      <span className="truncate text-foreground/90">{name}</span>
      {components?.map((c) => (
        <span
          key={c}
          className="hidden shrink-0 rounded-chip border border-border bg-raised px-1.5 py-px font-mono text-micro text-muted-foreground sm:inline"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

/** Syntax roles, mapped to the app's own six-hue Monaco palette. */
const TONE = {
  kw: "text-syn-keyword",
  ty: "text-syn-type",
  fn: "text-syn-func",
  st: "text-syn-string",
  nu: "text-syn-number",
  at: "text-primary-lit",
  pl: "text-foreground/80",
} as const;

type UnityFile = {
  /** A real filename, not a stand-in. */
  name: string;
  dir: string;
  /** What every other editor hands you. */
  raw: string;
  /** The honest size of the raw form, so the contrast is a fact and not a mood. */
  elsewhere: string;
  /** What the native editor is called, in the app's own words. */
  resolvedAs: string;
  /** The trade, stated in one line. This is the hook. */
  payoff: string;
  render: () => ReactElement;
};

const FILES: UnityFile[] = [
  {
    name: "Player.prefab",
    dir: "Assets/Prefabs",
    elsewhere: "1,847 lines of YAML",
    resolvedAs: "Prefab hierarchy",
    payoff: "1,847 lines of YAML. Or a Player.",
    raw: `--- !u!1 &6438273645192837465
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_Component:
  - component: {fileID: 6438273645192837466}
  - component: {fileID: 6438273645192837467}
  m_Layer: 0
  m_Name: Player
  m_TagString: Player
--- !u!4 &6438273645192837466
Transform:
  m_GameObject: {fileID: 6438273645192837465}
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_Children:
  - {fileID: 8812094471029384756}
  - {fileID: 1120384756019283746}`,
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
    name: "PlayerStats.asset",
    dir: "Assets/Data",
    elsewhere: "412 lines of YAML",
    resolvedAs: "ScriptableObject inspector",
    payoff: "412 lines of YAML. Or five fields you can edit.",
    raw: `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_GameObject: {fileID: 0}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: 8f3c1a2d9b7e4f60
  m_Name: PlayerStats
  m_EditorClassIdentifier:
  maxHealth: 100
  moveSpeed: 5.5
  jumpForce: 12
  startingWeapon: {fileID: 11400000, guid: 4a1c9e2f`,
    render: () => (
      <div>
        <div className="mb-2 flex items-center gap-2 text-micro text-muted-foreground">
          <span className="h-2 w-2 rounded-chip bg-primary" />
          <span className="font-mono">PlayerStats</span>
          <span className="text-faint">ScriptableObject</span>
        </div>
        <Field label="Max Health" value="100" />
        <Field label="Move Speed" value="5.5" />
        <Field label="Jump Force" value="12" />
        <Field label="Damage Curve" value="AnimationCurve" />
        <Field label="Starting Weapon" value="Pistol.asset" tone="accent" />
      </div>
    ),
  },
  {
    name: "MainMenu.uxml",
    dir: "Assets/UI",
    elsewhere: "markup, no preview",
    resolvedAs: "Live UI canvas",
    payoff: "Markup with no preview. Or the screen itself.",
    raw: `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="project://database/Assets/UI/Menu.uss" />
  <ui:VisualElement name="root" class="menu-root">
    <ui:Label text="NEON DRIFT" class="menu-title" />
    <ui:VisualElement class="menu-stack">
      <ui:Button text="Play" name="play" class="btn" />
      <ui:Button text="Garage" name="garage" class="btn" />
      <ui:Button text="Quit" name="quit" class="btn" />
    </ui:VisualElement>
  </ui:VisualElement>
</ui:UXML>`,
    render: () => (
      <div className="flex h-full items-center justify-center">
        {/* Letterboxed on purpose — the aspect ratio is what says "viewport". */}
        <div className="relative w-full max-w-[300px] rounded-panel border border-border bg-void px-7 py-5 text-center">
          <p className="mb-4 font-mono text-mini font-semibold tracking-[0.2em] text-primary">
            NEON DRIFT
          </p>
          {["Play", "Garage", "Quit"].map((b, i) => (
            <div
              key={b}
              className={`mb-1.5 rounded-chip border px-3 py-1.5 text-micro ${
                i === 0
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground"
              }`}
            >
              {b}
            </div>
          ))}
          <span className="absolute bottom-1.5 right-2 font-mono text-[9px] text-faint">
            1920 × 1080
          </span>
        </div>
      </div>
    ),
  },
  {
    name: "Gameplay.inputactions",
    dir: "Assets/Input",
    elsewhere: "620 lines of JSON",
    resolvedAs: "Action maps",
    payoff: "620 lines of JSON. Or your action maps.",
    raw: `{
  "name": "Gameplay",
  "maps": [
    {
      "name": "Player",
      "id": "9f2b1c4a-7d3e-4a11-b0c8-5e6f7a8b9c0d",
      "actions": [
        {
          "name": "Move",
          "type": "Value",
          "id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
          "expectedControlType": "Vector2"
        },
        {
          "name": "Jump",
          "type": "Button",
          "id": "2b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e"
        }
      ],`,
    render: () => (
      <div className="grid grid-cols-[92px_1fr] gap-3">
        <div className="border-r border-border/60 pr-2">
          <p className="mb-2 text-micro text-faint">Maps</p>
          {["Player", "UI", "Vehicle"].map((m, i) => (
            <div
              key={m}
              className={`rounded-chip px-2 py-1 text-mini ${
                i === 0 ? "bg-primary/10 text-primary" : "text-muted-foreground"
              }`}
            >
              {m}
            </div>
          ))}
        </div>
        <div>
          <p className="mb-2 text-micro text-faint">
            Bindings
          </p>
          {[
            ["Move", "WASD / Left Stick"],
            ["Jump", "Space / Button South"],
            ["Fire", "Mouse Left / Right Trigger"],
            ["Look", "Delta / Right Stick"],
          ].map(([action, binding]) => (
            <div key={action} className="flex items-baseline gap-2 py-[5px] text-mini">
              <span className="w-12 shrink-0 text-foreground/90">{action}</span>
              <span className="truncate font-mono text-micro text-muted-foreground">{binding}</span>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    name: "PlayerController.cs",
    dir: "Assets/Scripts",
    elsewhere: "plain C#, no Unity context",
    resolvedAs: "Unity-aware C#",
    payoff: "Plain C#. Or C# that knows the engine calls it.",
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
      <div className="font-mono text-micro leading-[1.75]">
        {[
          { gutter: "", parts: [["public class ", "kw"], ["PlayerController", "ty"], [" : ", "pl"], ["MonoBehaviour", "ty"]] },
          { gutter: "", parts: [["{", "pl"]] },
          { gutter: "S", parts: [["    [SerializeField] ", "at"], ["private float ", "kw"], ["speed = ", "pl"], ["5f", "nu"], [";", "pl"]] },
          { gutter: "", parts: [["    private ", "kw"], ["Rigidbody", "ty"], [" rb;", "pl"]] },
          { gutter: "", parts: [["", "pl"]] },
          { gutter: "▶", parts: [["    void ", "kw"], ["Awake", "fn"], ["() => rb = ", "pl"], ["GetComponent", "fn"], ["<", "pl"], ["Rigidbody", "ty"], [">();", "pl"]] },
          { gutter: "", parts: [["", "pl"]] },
          { gutter: "▶", parts: [["    void ", "kw"], ["Update", "fn"], ["()", "pl"]] },
          { gutter: "", parts: [["    {", "pl"]] },
          { gutter: "!", parts: [["        var h = ", "pl"], ["Input", "ty"], [".GetAxis(", "pl"], ['"Horizontal"', "st"], [");", "pl"]] },
        ].map((line, i) => (
          <div key={i} className="flex gap-2">
            <span
              className={`w-3 shrink-0 select-none text-right text-micro ${
                line.gutter === "!" ? "text-fail" : "text-primary-lit"
              }`}
              aria-hidden="true"
            >
              {line.gutter}
            </span>
            <span className="truncate">
              {line.parts.map(([text, tone], j) => (
                <span key={j} className={TONE[tone as keyof typeof TONE]}>
                  {text || " "}
                </span>
              ))}
            </span>
          </div>
        ))}
        <div className="mt-2 flex items-start gap-2 rounded-chip border border-fail/30 bg-fail/10 px-2 py-1.5">
          <span className="mt-px shrink-0 font-mono text-micro text-fail">!</span>
          <span className="text-micro leading-snug text-fail-text">
            UNITY0405 — legacy input in a project on the Input System
          </span>
        </div>
      </div>
    ),
  },
];

/** Raw text is scenery for the resolve, not something anyone is meant to read. */
function RawBlock({ text }: { text: string }) {
  return (
    <pre
      aria-hidden="true"
      style={{
        maskImage: "linear-gradient(to bottom, black 58%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 58%, transparent 100%)",
      }}
      className="overflow-hidden whitespace-pre font-mono text-micro leading-[1.7] text-faint"
    >
      {text}
    </pre>
  );
}

const RESOLVE_MS = 820;

export default function ResolvePanel() {
  const [index, setIndex] = useState(0);
  const [resolved, setResolved] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    // Reduced motion gets the answer with no theatre — the end state, not a
    // faster version of the transition.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setResolved(true);
      return;
    }
    setResolved(false);
    const t = setTimeout(() => setResolved(true), RESOLVE_MS);
    return () => clearTimeout(t);
  }, [index]);

  // A tablist owes arrow keys. Without them the only way through five tabs is
  // a mouse, which for a panel that IS the argument is a real exclusion.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const last = FILES.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % FILES.length;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    setIndex(next);
    tabRefs.current[next]?.focus();
  }, [index]);

  const file = FILES[index];

  return (
    <figure className="m-0">
      <div className="overflow-hidden rounded-plane border border-border bg-panel ide-shadow">
        {/* Title bar — the app's chrome sinks below its content, so this is the
            darkest strip on the panel rather than the lightest. */}
        <div className="flex items-center gap-2 border-b border-border bg-void px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-bright" />
          <span className="h-2.5 w-2.5 rounded-full bg-bright" />
          <span className="h-2.5 w-2.5 rounded-full bg-bright" />
          <span className="ml-2 truncate font-mono text-micro text-muted-foreground">
            {file.dir}/{file.name}
          </span>
        </div>

        {/* Real Unity extensions, which is the whole argument. */}
        <div
          role="tablist"
          aria-label="Unity file types"
          onKeyDown={onKeyDown}
          className="flex overflow-x-auto border-b border-border bg-sunk"
        >
          {FILES.map((f, i) => {
            const ext = f.name.slice(f.name.indexOf("."));
            const active = i === index;
            return (
              <button
                key={f.name}
                ref={(el) => { tabRefs.current[i] = el; }}
                role="tab"
                id={`resolve-tab-${i}`}
                aria-selected={active}
                aria-controls="resolve-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => setIndex(i)}
                className={`relative shrink-0 whitespace-nowrap px-3.5 py-2.5 font-mono text-micro transition-colors sm:px-5 ${
                  active
                    ? "bg-panel text-primary"
                    : "text-muted-foreground hover:bg-raised hover:text-foreground"
                }`}
              >
                {/* The app marks its active tab with a 2px accent top rule and
                    no fill difference. Same device here. */}
                {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
                {ext}
              </button>
            );
          })}
        </div>

        {/* Fixed height so switching files never shifts the page under a cursor. */}
        <div
          id="resolve-panel"
          role="tabpanel"
          aria-labelledby={`resolve-tab-${index}`}
          className="grid grid-cols-1 md:grid-cols-2"
        >
          {/* Left: what every other editor gives you. Deliberately unreadable. */}
          <div className="min-w-0 border-b border-border md:border-b-0 md:border-r">
            <p className="border-b border-border/60 px-4 py-2 text-micro text-muted-foreground">
              Every other editor
            </p>
            <div className="h-[104px] overflow-hidden px-4 py-3 md:h-[292px]">
              <RawBlock text={file.raw} />
            </div>
          </div>

          {/* Right: the same bytes, resolved. */}
          <div className="relative min-w-0">
            <p className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-micro text-muted-foreground">
              UnityIDE
              <span
                className={`ml-auto font-mono text-micro transition-colors duration-500 ${
                  resolved ? "text-primary" : "text-faint"
                }`}
              >
                {file.resolvedAs}
              </span>
            </p>
            <div className="relative h-[236px] overflow-hidden px-4 py-3 md:h-[292px]">
              <div
                className={`absolute inset-0 px-4 py-3 transition-opacity duration-500 ${
                  resolved ? "opacity-0" : "opacity-100"
                }`}
              >
                <RawBlock text={file.raw} />
              </div>
              <div
                className={`absolute inset-0 overflow-hidden px-4 py-3 transition-all duration-500 ${
                  resolved ? "opacity-100 blur-0" : "opacity-0 blur-[3px]"
                }`}
                aria-hidden={!resolved}
              >
                {file.render()}
              </div>
            </div>
          </div>
        </div>
      </div>

      <figcaption className="mt-5 text-center font-mono text-mini text-muted-foreground">
        {file.payoff}
      </figcaption>
    </figure>
  );
}
