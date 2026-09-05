import { useCallback, useRef, useState, type ReactElement } from "react";
import {
  AlertTriangle,
  BotMessageSquare,
  Boxes,
  CheckCircle,
  Gamepad2,
  GitBranch,
  Network,
  PanelsTopLeft,
  Pause,
  Play,
  Search,
  Settings,
  ShieldCheck,
  FlaskConical,
  Terminal,
  Square,
  XCircle,
} from "lucide-react";

/**
 * The hero product shot.
 *
 * The revision before this one put the hierarchy, the editor, the UXML source,
 * the preview canvas, the AI panel, the console and the status bar on screen
 * simultaneously, on the theory that density proves completeness. At the width
 * a page gives it, that put every label at 9px and the result read as noise.
 *
 * So the panels take turns. The control is the activity rail, because that is
 * exactly how the real app works: `ActivityBar.tsx` swaps the sidebar view when
 * you click an icon. The chrome that says "real desktop app" — the UNITYIDE
 * title bar, the unity deck with its live bridge status, the status bar — stays
 * put, and only the working area changes.
 *
 * The rail shows labels beside its icons, which the app itself puts in
 * tooltips. On a web page a column of unlabelled glyphs is a guessing game, and
 * the labels are the app's own strings rather than invented ones.
 *
 * Icons are the same lucide components `ActivityBar.tsx` and
 * `RightActivityBar.tsx` import.
 */

type View = {
  id: string;
  Icon: typeof Network;
  /** The label the app's own tooltip uses. */
  label: string;
  /** What the visitor is looking at, and why it is not available elsewhere. */
  caption: string;
  render: () => ReactElement;
};

/* ── Shared panel furniture ─────────────────────────────────────────────── */

function PanelTitle({ children, right }: { children: string; right?: ReactElement }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      <span className="text-mini text-muted-foreground">{children}</span>
      {right}
    </div>
  );
}

function Row({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: string;
  tone?: "plain" | "accent" | "pass";
}) {
  const t = tone === "accent" ? "text-primary" : tone === "pass" ? "text-pass" : "text-foreground/85";
  return (
    <div className="flex items-baseline gap-4 border-b border-border/40 py-2 last:border-0">
      <span className="w-[132px] shrink-0 truncate text-mini text-muted-foreground">{label}</span>
      <span className={`truncate font-mono text-mini ${t}`}>{value}</span>
    </div>
  );
}

/* ── The five views ─────────────────────────────────────────────────────── */

const HIERARCHY = [
  { depth: 0, name: "Player", chips: ["Transform", "Rigidbody"] },
  { depth: 1, name: "Model", chips: ["MeshRenderer"] },
  { depth: 1, name: "Camera Rig", chips: ["Transform"] },
  { depth: 2, name: "Main Camera", chips: ["Camera", "AudioListener"] },
  { depth: 1, name: "Weapon Socket", chips: ["Transform"] },
  { depth: 0, name: "Enemies", chips: [] },
  { depth: 1, name: "Drone", chips: ["NavMeshAgent", "EnemyAI"] },
  { depth: 0, name: "UI", chips: ["UIDocument"] },
];

const UX = {
  tag: "text-syn-keyword",
  attr: "text-syn-type",
  str: "text-syn-string",
  pun: "text-foreground/45",
} as const;

type Part = [string, keyof typeof UX];

const UXML: Part[][] = [
  [["<", "pun"], ["ui:UXML", "tag"], [" xmlns:ui", "attr"], ["=", "pun"], ['"UnityEngine.UIElements"', "str"], [">", "pun"]],
  [["  <", "pun"], ["Style", "tag"], [" src", "attr"], ["=", "pun"], ['"Menu.uss"', "str"], [" />", "pun"]],
  [["  <", "pun"], ["ui:VisualElement", "tag"], [" name", "attr"], ["=", "pun"], ['"root"', "str"], [">", "pun"]],
  [["    <", "pun"], ["ui:Label", "tag"], [" text", "attr"], ["=", "pun"], ['"NEON DRIFT"', "str"], [" />", "pun"]],
  [["    <", "pun"], ["ui:Button", "tag"], [" text", "attr"], ["=", "pun"], ['"Play"', "str"], [" name", "attr"], ["=", "pun"], ['"play"', "str"], [" />", "pun"]],
  [["    <", "pun"], ["ui:Button", "tag"], [" text", "attr"], ["=", "pun"], ['"Garage"', "str"], [" />", "pun"]],
  [["    <", "pun"], ["ui:Button", "tag"], [" text", "attr"], ["=", "pun"], ['"Quit"', "str"], [" />", "pun"]],
  [["  </", "pun"], ["ui:VisualElement", "tag"], [">", "pun"]],
  [["</", "pun"], ["ui:UXML", "tag"], [">", "pun"]],
];

const VIEWS: View[] = [
  {
    id: "hierarchy",
    Icon: Network,
    label: "Unity Hierarchy",
    caption:
      "The scene as the running Editor has it open — not a YAML file you parsed and hoped about.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto shrink-0 font-mono text-micro text-muted-foreground/60">
              SampleScene
            </span>
          }
        >
          Hierarchy
        </PanelTitle>
        <div className="min-h-0 flex-1 overflow-hidden p-2">
          {HIERARCHY.map((node) => (
            <div
              key={node.name}
              className="flex items-center gap-2.5 rounded-chip py-[7px] pr-2 text-mini"
              style={{ paddingLeft: `${10 + node.depth * 18}px` }}
            >
              <span className="h-2 w-2 shrink-0 rounded-[2px] bg-primary/70" />
              <span className="shrink-0 text-foreground/90">{node.name}</span>
              <span className="flex min-w-0 gap-1.5">
                {node.chips.map((chip) => (
                  <span
                    key={chip}
                    className="hidden rounded-[3px] border border-border bg-raised px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline"
                  >
                    {chip}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: "scriptable-objects",
    Icon: Boxes,
    label: "Scriptable Objects",
    caption:
      "A .asset opens as the fields its class declares. Saving splices bytes rather than re-serializing the file.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto flex shrink-0 gap-4 text-mini">
              <span className="text-primary">Fields</span>
              <span className="text-muted-foreground/50">Instances</span>
              <span className="flex items-center gap-1.5 text-muted-foreground/50">
                Drift
                <span className="rounded-[3px] bg-warn/15 px-1.5 font-mono text-[10px] text-warn">3</span>
              </span>
            </span>
          }
        >
          PlayerStats.asset
        </PanelTitle>
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-2">
          <Row label="Max Health" value="100" />
          <Row label="Move Speed" value="5.5" />
          <Row label="Jump Force" value="12" />
          <Row label="Dash Cooldown" value="0.75" />
          <Row label="Damage Curve" value="AnimationCurve" />
          <Row label="Starting Weapon" value="Pistol.asset" tone="accent" />
          <p className="mt-3 border-t border-border/60 pt-3 text-mini text-muted-foreground">
            Referenced by 3 scenes and 2 prefabs.
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "unity-ui",
    Icon: PanelsTopLeft,
    label: "Unity UI",
    caption:
      "Markup renders on a canvas beside its source, and the agent can measure what it laid out.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto shrink-0 rounded-[3px] bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
              Design chat
            </span>
          }
        >
          MainMenu.uxml
        </PanelTitle>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
          <div className="hidden min-w-0 overflow-hidden border-r border-border px-4 py-3 lg:block">
            <pre className="whitespace-pre font-mono text-mini leading-[1.85]">
              {UXML.map((line, i) => (
                <div key={i} className="truncate">
                  {line.map(([text, tone], j) => (
                    <span key={j} className={UX[tone]}>
                      {text}
                    </span>
                  ))}
                </div>
              ))}
            </pre>
          </div>

          <div className="relative flex min-h-0 min-w-0 items-center justify-center bg-void px-4 py-5">
            <div
              className="absolute inset-0 opacity-40"
              style={{
                backgroundImage:
                  "linear-gradient(hsl(0 0% 100% / 0.03) 1px,transparent 1px),linear-gradient(90deg,hsl(0 0% 100% / 0.03) 1px,transparent 1px)",
                backgroundSize: "28px 28px",
              }}
            />
            {/* Teal belongs to the game being previewed, not to the IDE. */}
            <div className="relative w-full max-w-[240px] rounded-panel border border-[hsl(172_48%_66%_/_0.25)] bg-[hsl(200_30%_7%)] px-6 py-5 text-center">
              <p className="font-mono text-[14px] font-semibold tracking-[0.22em] text-[hsl(172_48%_66%)]">
                NEON DRIFT
              </p>
              <div className="mt-4 flex flex-col gap-2">
                <span className="rounded-chip border border-[hsl(172_48%_66%_/_0.5)] bg-[hsl(172_48%_66%_/_0.12)] py-2 text-mini text-[hsl(172_48%_76%)]">
                  Play
                </span>
                <span className="rounded-chip border border-white/10 py-2 text-mini text-foreground/50">Garage</span>
                <span className="rounded-chip border border-white/10 py-2 text-mini text-foreground/50">Quit</span>
              </div>
              <span className="absolute -bottom-6 right-0 font-mono text-[10px] text-muted-foreground/50">
                1920 × 1080
              </span>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "input",
    Icon: Gamepad2,
    label: "Input Actions",
    caption:
      "Two actions claim <Keyboard>/space. Unity reports nothing for this — Jump simply stops firing.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto shrink-0 rounded-[3px] bg-warn/15 px-2 py-0.5 font-mono text-[10px] text-warn">
              1 conflict
            </span>
          }
        >
          Gameplay.inputactions
        </PanelTitle>
        <div className="grid min-h-0 flex-1 grid-cols-[104px_1fr] sm:grid-cols-[132px_1fr]">
          <div className="border-r border-border p-2">
            <p className="px-2 py-1 text-micro text-muted-foreground/60">Maps</p>
            {["Player", "UI", "Vehicle"].map((m, i) => (
              <div
                key={m}
                className={`rounded-chip px-2 py-1.5 text-mini ${
                  i === 0 ? "bg-primary/10 text-primary" : "text-muted-foreground"
                }`}
              >
                {m}
              </div>
            ))}
          </div>
          <div className="min-w-0 overflow-hidden px-4 py-2">
            {[
              ["Move", "WASD / Left Stick", false],
              ["Jump", "<Keyboard>/space", true],
              ["Fire", "Mouse Left / Right Trigger", false],
              ["Look", "Delta / Right Stick", false],
            ].map(([action, binding, clash]) => (
              <div
                key={action as string}
                className={`flex items-baseline gap-4 rounded-chip border-b border-border/40 px-2 py-2 last:border-0 ${
                  clash ? "bg-fail/10" : ""
                }`}
              >
                <span
                  className={`w-[68px] shrink-0 truncate text-mini ${
                    clash ? "text-fail-text" : "text-foreground/85"
                  }`}
                >
                  {action as string}
                </span>
                <span className="truncate font-mono text-mini text-muted-foreground">
                  {binding as string}
                </span>
                {clash && (
                  <span className="ml-auto hidden shrink-0 font-mono text-[10px] text-fail-text sm:inline">
                    also UI / Submit
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "console",
    Icon: Terminal,
    label: "Unity Console",
    caption:
      "Unity's own console, streamed in as it happens. Every stack frame is a link to the line that threw it.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto flex shrink-0 gap-3 font-mono text-[10px]">
              <span className="text-muted-foreground/60">12 Log</span>
              <span className="text-warn">2 Warning</span>
              <span className="text-fail-text">1 Error</span>
            </span>
          }
        >
          Unity Console
        </PanelTitle>
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-2">
          <div className="border-b border-border/40 py-2">
            <p className="flex items-start gap-2.5">
              <span className="mt-px shrink-0 rounded-[3px] bg-fail/15 px-1.5 font-mono text-[9px] text-fail-text">
                ERROR
              </span>
              <span className="truncate font-mono text-mini text-foreground/85">
                NullReferenceException: Object reference not set to an instance of an object
              </span>
            </p>
            <p className="mt-1 pl-[58px] font-mono text-[10.5px] text-primary/80">
              EnemyAI.Update () at Assets/Scripts/EnemyAI.cs:42
            </p>
          </div>
          <div className="border-b border-border/40 py-2">
            <p className="flex items-start gap-2.5">
              <span className="mt-px shrink-0 rounded-[3px] bg-warn/15 px-1.5 font-mono text-[9px] text-warn">
                WARN
              </span>
              <span className="truncate font-mono text-mini text-muted-foreground">
                Camera.main called every frame — cache the reference
              </span>
            </p>
            <p className="mt-1 pl-[58px] font-mono text-[10.5px] text-primary/80">
              PlayerController.cs:31
            </p>
          </div>
          <p className="flex items-start gap-2.5 py-2">
            <span className="mt-px shrink-0 rounded-[3px] bg-raised px-1.5 font-mono text-[9px] text-muted-foreground">
              LOG
            </span>
            <span className="truncate font-mono text-mini text-muted-foreground">
              Compiled in 2.1s — 0 errors, 0 warnings
            </span>
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "problems",
    Icon: AlertTriangle,
    label: "Problems",
    caption:
      "Thirty-one analyzers written for this engine, not for C# in general. None of these is a compiler error.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
              4 warnings, 0 errors
            </span>
          }
        >
          Problems
        </PanelTitle>
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-2">
          {[
            ["UNITY0202", "Camera.main in Update — cache the reference", "PlayerController.cs:31"],
            ["UNITY0205", "Allocation inside Update", "EnemyAI.cs:58"],
            ["UNITY0405", "Legacy Input in a project on the Input System", "PlayerController.cs:24"],
            ["UNITY0501", 'Q<Button>("play-btn") resolves to no element', "MainMenu.cs:17"],
          ].map(([code, message, where]) => (
            <div
              key={code}
              className="flex items-baseline gap-3 border-b border-border/40 py-2.5 last:border-0"
            >
              <span className="shrink-0 font-mono text-[10.5px] text-warn">{code}</span>
              <span className="truncate text-mini text-foreground/85">{message}</span>
              <span className="ml-auto hidden shrink-0 font-mono text-[10.5px] text-muted-foreground/60 sm:inline">
                {where}
              </span>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: "tests",
    Icon: FlaskConical,
    label: "Unity Tests",
    caption:
      "Edit Mode and Play Mode runs start here and stream back one test at a time, with failures expanded in place.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto flex shrink-0 items-center gap-3 font-mono text-[10px]">
              <span className="text-muted-foreground/60">Edit Mode</span>
              <span className="text-pass">12 ✓</span>
              <span className="text-fail-text">1 ✗</span>
            </span>
          }
        >
          Test Runner
        </PanelTitle>
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-2 font-mono text-mini">
          <p className="py-1.5 text-foreground/85">PlayerStatsTests</p>
          {[
            ["MaxHealth_ClampsToZero", "4ms"],
            ["MoveSpeed_DefaultsToFive", "2ms"],
          ].map(([name, ms]) => (
            <p key={name} className="flex items-baseline gap-2.5 py-1 pl-4">
              <span className="text-pass">✓</span>
              <span className="truncate text-muted-foreground">{name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground/50">{ms}</span>
            </p>
          ))}
          <p className="mt-2 py-1.5 text-foreground/85">WeaponTests</p>
          <p className="flex items-baseline gap-2.5 py-1 pl-4">
            <span className="text-fail">✗</span>
            <span className="truncate text-fail-text">Fire_RaisesEvent</span>
            <span className="ml-auto text-[10px] text-muted-foreground/50">11ms</span>
          </p>
          <p className="ml-4 mt-1 rounded-chip border border-fail/25 bg-fail/10 px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
            Expected 1 invocation, but was 0
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "scm",
    Icon: GitBranch,
    label: "Source Control",
    caption:
      "A scene diff grouped by GameObject rather than by YAML line — which is the only way a rename reads as a rename.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
              working tree vs HEAD
            </span>
          }
        >
          Level_01.unity
        </PanelTitle>
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-2">
          {[
            ["added", "Checkpoint_03", "Transform, BoxCollider, CheckpointTrigger"],
            ["modified", "Player", "Transform.position  (0, 1, 0) → (0, 3, 0)"],
            ["renamed", "Drone", "→ Drone_Heavy"],
            ["modified", "EnemyAI", "patrolSpeed  2.5 → 4"],
            ["removed", "Barrel_07", ""],
          ].map(([kind, name, detail]) => {
            /* The four kinds and their colours are SceneDiffViewer's own:
               added → git-added, removed → git-deleted, modified → git-modified,
               renamed → accent. */
            const tone =
              kind === "added"
                ? "text-pass"
                : kind === "removed"
                  ? "text-fail"
                  : kind === "renamed"
                    ? "text-primary"
                    : "text-warn";
            return (
              <div
                key={name}
                className="flex items-baseline gap-3 border-b border-border/40 py-2.5 last:border-0"
              >
                <span className={`w-[62px] shrink-0 font-mono text-[10px] ${tone}`}>{kind}</span>
                <span className="shrink-0 text-mini text-foreground/85">{name}</span>
                <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                  {detail}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    ),
  },
  {
    id: "ai",
    Icon: BotMessageSquare,
    label: "AI Assistant",
    caption:
      "It recompiles in your running Editor, then reports what it checked. A skipped check never shows as a pass.",
    render: () => (
      <div className="flex h-full flex-col">
        <PanelTitle
          right={
            <span className="ml-auto shrink-0 rounded-[3px] bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
              agent
            </span>
          }
        >
          AI Assistant
        </PanelTitle>
        <div className="min-h-0 flex-1 space-y-3 overflow-hidden px-4 py-3">
          <p className="inline-block rounded-panel bg-raised px-3 py-2 text-mini text-foreground/90">
            build me a pause menu bound to Escape
          </p>

          <div className="space-y-1.5 font-mono text-mini text-muted-foreground">
            <p className="truncate"><span className="text-pass">✓</span> wrote PauseMenu.uxml</p>
            <p className="truncate">
              <span className="text-fail">✗</span> refused PauseMenu.uss — unknown property{" "}
              <span className="text-fail-text">box-shadow</span>
            </p>
            <p className="truncate"><span className="text-pass">✓</span> wrote PauseMenu.uss</p>
            <p className="truncate">
              <span className="text-pass">✓</span> bound &lt;Keyboard&gt;/escape
            </p>
            <p className="truncate"><span className="text-pass">✓</span> recompiled in Unity — 2.1s</p>
          </div>

          <div className="rounded-panel border border-border bg-void px-3 py-2.5">
            <p className="mb-2 flex items-center gap-2 text-mini font-medium text-foreground/90">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" strokeWidth={1.8} aria-hidden="true" />
              Verified
            </p>
            <div className="flex flex-wrap gap-1.5">
              {["compile", "analyzers", "GUIDs", "layout", "input", "3/3 tests"].map((chip) => (
                <span
                  key={chip}
                  className="rounded-[3px] bg-pass/10 px-1.5 py-0.5 font-mono text-[10px] text-pass"
                >
                  ✓ {chip}
                </span>
              ))}
              <span className="rounded-[3px] bg-raised px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                – console
              </span>
            </div>
          </div>
        </div>
      </div>
    ),
  },
];

export default function IdeShowcase() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const last = VIEWS.length - 1;
      let next: number | null = null;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (active + 1) % VIEWS.length;
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = active === 0 ? last : active - 1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = last;
      if (next === null) return;
      e.preventDefault();
      setActive(next);
      tabs.current[next]?.focus();
    },
    [active],
  );

  const view = VIEWS[active];

  return (
    <figure className="m-0">
      <div className="ide-shadow overflow-hidden rounded-plane border border-border bg-panel">
        {/* Title bar — the app name is the literal string in TitleBar.tsx, and
            the centre deck is its transport plus live bridge status. */}
        <div className="flex items-center gap-3 border-b border-border bg-void px-3 py-2">
          <div className="flex shrink-0 gap-1.5 pr-1">
            <span className="h-2.5 w-2.5 rounded-full bg-bright" />
            <span className="h-2.5 w-2.5 rounded-full bg-bright" />
            <span className="h-2.5 w-2.5 rounded-full bg-bright" />
          </div>
          <span className="shrink-0 font-mono text-micro tracking-[0.16em] text-foreground/70">
            UNITYIDE
          </span>

          <div className="mx-auto flex shrink-0 items-center gap-2 rounded-chip border border-border bg-raised px-2.5 py-1">
            <Play className="h-3 w-3 fill-current text-primary" strokeWidth={0} aria-hidden="true" />
            <Pause className="h-3 w-3 fill-current text-muted-foreground/50" strokeWidth={0} aria-hidden="true" />
            <Square className="h-[11px] w-[11px] fill-current text-muted-foreground/50" strokeWidth={0} aria-hidden="true" />
            <span className="mx-1 h-3 w-px bg-border" />
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pass opacity-70 motion-reduce:hidden" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-pass" />
            </span>
            <span className="whitespace-nowrap font-mono text-micro text-foreground/80">Connected</span>
          </div>

          <div className="hidden shrink-0 items-center gap-2 text-muted-foreground/50 sm:flex">
            <Search className="h-3.5 w-3.5" strokeWidth={1.6} aria-hidden="true" />
            <Settings className="h-3.5 w-3.5" strokeWidth={1.6} aria-hidden="true" />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[182px_1fr]">
          {/* The activity rail is the tab control, which is how the real app
              switches panels. Horizontal above md so it stays reachable on a
              phone without stealing half the width. */}
          <div
            role="tablist"
            aria-label="Unity panels"
            aria-orientation="vertical"
            onKeyDown={onKeyDown}
            className="flex overflow-x-auto border-b border-border bg-void p-1.5 md:flex-col md:overflow-visible md:border-b-0 md:border-r"
          >
            {VIEWS.map((v, i) => {
              const on = i === active;
              return (
                <button
                  key={v.id}
                  ref={(el) => { tabs.current[i] = el; }}
                  role="tab"
                  id={`ide-tab-${v.id}`}
                  aria-selected={on}
                  aria-controls="ide-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => setActive(i)}
                  className={`relative flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-chip px-3 py-2 text-left text-mini transition-colors ${
                    on
                      ? "bg-raised text-primary"
                      : "text-muted-foreground hover:bg-raised/60 hover:text-foreground"
                  }`}
                >
                  {on && (
                    <span className="absolute left-0 top-1/2 hidden h-5 w-[2px] -translate-y-1/2 rounded-full bg-primary md:block" />
                  )}
                  <v.Icon className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
                  {v.label}
                </button>
              );
            })}
          </div>

          {/* Fixed height so switching panels never shifts the page. */}
          <div
            id="ide-panel"
            role="tabpanel"
            aria-labelledby={`ide-tab-${view.id}`}
            className="h-[392px] min-w-0 sm:h-[404px]"
          >
            {view.render()}
          </div>
        </div>

        {/* Status bar — the items StatusBar.tsx actually renders. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border bg-void px-4 py-2 font-mono text-[10px] text-muted-foreground/70">
          <span className="flex items-center gap-1.5">
            <GitBranch className="h-2.5 w-2.5" strokeWidth={2} aria-hidden="true" />
            main
          </span>
          <span className="flex items-center gap-1.5">
            <CheckCircle className="h-2.5 w-2.5" strokeWidth={2} aria-hidden="true" />
            C#
          </span>
          <span className="hidden sm:inline">Unity 6000.3</span>
          <span className="hidden md:inline">60 FPS</span>
          <span className="hidden lg:inline">Assembly-CSharp</span>
          <span className="ml-auto flex items-center gap-1.5">
            <AlertTriangle className="h-2.5 w-2.5 text-warn" strokeWidth={2} aria-hidden="true" />1
          </span>
          <span className="flex items-center gap-1.5">
            <XCircle className="h-2.5 w-2.5" strokeWidth={2} aria-hidden="true" />0
          </span>
        </div>
      </div>

      {/* The caption is where the selling happens: it names what the panel above
          is doing that another editor cannot. It changes with the tab. */}
      <figcaption className="mx-auto mt-6 max-w-[62ch] text-center text-mini leading-relaxed text-muted-foreground">
        {view.caption}
      </figcaption>
    </figure>
  );
}
