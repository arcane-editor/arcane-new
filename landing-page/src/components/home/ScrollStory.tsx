import { useEffect, useRef, useState } from 'react';
import {
  AGENTS,
  BARS,
  C,
  CHECKS,
  DRIFT,
  INPUTS,
  LOGS,
  SETUP,
  TOOLS,
  TREE,
  YAML,
  clamp,
  eo,
  seg,
} from './story-data';

/**
 * Chapters 01–05 and the horizontal band, driven by scroll position.
 *
 * Every panel below animates on scroll POSITION rather than on entry: the
 * reader drives it, scrubbing forwards and back, and nothing plays at them.
 * Each chapter is a tall section with a sticky 100vh stage inside it, so its
 * progress `p` — 0 when the stage locks, 1 when it releases — is the single
 * input every value in that chapter is derived from.
 *
 * Three conditions turn the whole mechanism off: a viewport too narrow to hold
 * two columns inside 100vh, a reduced-motion preference, and no JavaScript. In
 * all three the sections render at p = 1 — the finished state, which is the one
 * that carries the information. That is also what the server renders, so the
 * page is complete before hydration rather than blank until it.
 */

/** The one hairline used inline; the rest live in landing.css. */
const C_RULE = '#1f2329';

const CHAPTER_HEIGHTS = ['260vh', '300vh', '300vh', '280vh', '340vh', '420vh'];
const DONE: number[] = [1, 1, 1, 1, 1, 1];

/** The ambient wash behind the page picks up the colour of the chapter you are
 *  in. Written as custom properties on the page root rather than rendered here,
 *  so the fixed layers stay in the document that owns them. */
const TINTS = [
  'rgba(124,183,255,0.16)',
  'rgba(245,194,107,0.13)',
  'rgba(255,111,111,0.12)',
  'rgba(124,183,255,0.16)',
  'rgba(111,227,165,0.13)',
];

export default function ScrollStory() {
  const [p, setP] = useState<number[]>(DONE);
  const [driven, setDriven] = useState(false);
  const refs = useRef<Array<HTMLElement | null>>([null, null, null, null, null, null]);
  const raf = useRef(0);

  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1024px)');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');

    const measure = () => {
      const vh = window.innerHeight;
      setP(
        refs.current.map((el) => {
          if (!el) return 1;
          const b = el.getBoundingClientRect();
          return clamp(-b.top / Math.max(1, b.height - vh), 0, 1);
        })
      );
    };

    const onScroll = () => {
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        measure();
      });
    };

    const sync = () => {
      const on = wide.matches && !still.matches;
      setDriven(on);
      if (on) measure();
      else setP(DONE);
    };

    sync();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', sync);
    wide.addEventListener('change', sync);
    still.addEventListener('change', sync);
    return () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', sync);
      wide.removeEventListener('change', sync);
      still.removeEventListener('change', sync);
    };
  }, []);

  const [p1, p2, p3, p4, p5, p6] = driven ? p : DONE;

  // Ambient tint follows whichever chapter is mid-flight; it brightens through
  // the chapter and settles again at the seam between two.
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.lp');
    if (!root) return;
    const active = driven ? p.findIndex((v) => v > 0 && v < 1) : -1;
    const pulse = active < 0 ? 0.5 : Math.sin(p[active] * Math.PI);
    root.style.setProperty('--lp-glow-a', String(active < 0 ? 0.6 : 0.35 + pulse * 0.65));
    root.style.setProperty('--lp-glow-b', String(active < 0 ? 0.35 : 0.2 + pulse * 0.5));
    root.style.setProperty('--lp-tint-a', TINTS[active < 0 ? 0 : active]);
    root.style.setProperty('--lp-tint-b', TINTS[active < 0 ? 4 : active]);
  }, [p, driven]);

  const chapter = (i: number) => ({
    ref: (el: HTMLElement | null) => {
      refs.current[i] = el;
    },
    'data-driven': String(driven),
    style: driven ? { height: CHAPTER_HEIGHTS[i] } : undefined,
  });

  /* ── 01 · Setup ───────────────────────────────────────────────────────── */
  const steps = SETUP.map(([title, sub], i) => {
    const o = eo(seg(p1, 0.1 + i * 0.16, 0.22 + i * 0.16));
    const done = seg(p1, 0.2 + i * 0.16, 0.26 + i * 0.16) > 0.5;
    return { title, sub, o, tx: (1 - o) * -10, done };
  });
  const setupLine = eo(seg(p1, 0.1, 0.6)) * 100;

  /* ── 02 · UI Toolkit ──────────────────────────────────────────────────── */
  const held = seg(p2, 0.12, 0.25) > 0.5;
  const squiggled = seg(p2, 0.3, 0.42) > 0.5;
  const tip = eo(seg(p2, 0.45, 0.6));

  /* ── 03 · ScriptableObjects ───────────────────────────────────────────── */
  const renamed = seg(p3, 0.1, 0.22);
  const reset = seg(p3, 0.35, 0.7);

  /* ── 04 · Hierarchy ───────────────────────────────────────────────────── */
  const resolved = eo(seg(p4, 0.12, 0.7));
  const yamlCount = Math.round(1847 - 1846 * resolved);
  const fade = seg(p4, 0.15, 0.6);
  const connected = fade > 0.6;

  /* ── 05 · AI copilot ──────────────────────────────────────────────────── */

  /* ── Horizontal band ──────────────────────────────────────────────────── */
  const hPos = seg(p6, 0.16, 0.3) + seg(p6, 0.44, 0.58) + seg(p6, 0.72, 0.86);
  const hIdx = Math.round(hPos);
  const rA = p6 > 0 ? 1 : 0;
  const rB = seg(p6, 0.22, 0.34);
  const rC = seg(p6, 0.5, 0.62);
  const rD = seg(p6, 0.78, 0.9);
  // Slides off-centre dim rather than vanish, so the band reads as one strip
  // being panned across instead of four things appearing.
  const near = (d: number) => (driven ? clamp(0.35 + 0.65 * (1 - Math.abs(hPos - d)), 0, 1) : 1);

  return (
    <>
      {/* ── 01 · Setup ─────────────────────────────────────────────────── */}
      <section className="lp-chapter" aria-labelledby="ch-setup" {...chapter(0)}>
        <div className="lp-stage">
          <div className="lp-pair">
            <div>
              <p className="lp-eyebrow" style={{ marginBottom: 16 }}>01 · Setup</p>
              <h2 className="lp-h2" id="ch-setup">A Unity IDE that just works. No days of setup.</h2>
              <p className="lp-lede">
                We spent too many afternoons wiring extensions, language servers and debuggers
                together before writing a line of game code. UnityIDE ships with all of it.
                Download, add one package to your project, and it finds the running Editor on its
                own.
              </p>
            </div>

            <div className="lp-panel">
              <div className="lp-panel-head">Getting started</div>
              <div style={{ padding: '22px 22px 8px', position: 'relative' }}>
                {/* Track and fill share one box, so the green can never run
                    past the grey — a percentage of the padded panel did. */}
                <div style={{ position: 'absolute', left: 33, top: 30, bottom: 30, width: 1, background: C_RULE }}>
                  <div style={{ width: 1, background: C.green, height: `${setupLine}%` }} />
                </div>
                {steps.map((s, i) => (
                  <div
                    key={s.title}
                    style={{
                      position: 'relative',
                      display: 'grid',
                      gridTemplateColumns: '24px minmax(0, 1fr)',
                      gap: 14,
                      padding: '12px 0 22px',
                      opacity: s.o,
                      transform: `translateX(${s.tx}px)`,
                    }}
                  >
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: '50%',
                        border: `1px solid ${s.done ? C.green : '#2a2f37'}`,
                        background: s.done ? C.green : '#151821',
                        display: 'grid',
                        placeItems: 'center',
                        fontSize: 12,
                        color: '#0a0b0d',
                        fontWeight: 700,
                      }}
                    >
                      {s.done ? '✓' : i + 1}
                    </span>
                    <div>
                      <div style={{ fontSize: 15.5, fontWeight: 500, color: C.text }}>{s.title}</div>
                      <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 12, color: C.mute }}>
                        {s.sub}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ height: 14 }} />
            </div>
          </div>
          <p className="lp-aside" style={{ opacity: seg(p1, 0.78, 0.92) }}>
            C# language server, Unity analyzers, debugger, terminal and git — already in the box.
            Works from Unity 2021.3 through Unity 6.
          </p>
        </div>
      </section>

      {/* ── 02 · UI Toolkit ────────────────────────────────────────────── */}
      <section className="lp-chapter" aria-labelledby="ch-uxml" {...chapter(1)}>
        <div className="lp-stage">
          <div className="lp-pair">
            <div>
              <p className="lp-eyebrow" style={{ marginBottom: 16 }}>02 · UI Toolkit</p>
              <h2 className="lp-h2" id="ch-uxml">It compiled clean. The Play button did nothing.</h2>
              <p className="lp-lede">
                A UI Toolkit query is just a string. Get the name wrong and C# is perfectly happy to
                hand you null at runtime. UnityIDE renders the UXML on a live canvas beside the code
                — and knows what the element is actually called.
              </p>
            </div>

            <div style={{ display: 'grid', gap: 14 }}>
              <div className="lp-panel">
                <div className="lp-panel-head">MainMenu.uxml · live canvas</div>
                <div
                  style={{
                    padding: '26px 22px',
                    background: 'radial-gradient(ellipse at 30% 0%, #1a1f2e, #0d0f14 70%)',
                    display: 'grid',
                    justifyItems: 'center',
                    gap: 10,
                  }}
                >
                  <div style={{ fontSize: 22, letterSpacing: '0.22em', fontWeight: 700, color: C.text, marginBottom: 6 }}>
                    NEON DRIFT
                  </div>
                  <div
                    style={{
                      position: 'relative',
                      width: 160,
                      textAlign: 'center',
                      padding: 8,
                      borderRadius: 6,
                      border: `1px solid ${tip > 0.5 ? C.green : '#262b33'}`,
                      background: '#151821',
                      fontSize: 14,
                      color: C.text,
                      transition: 'border-color 0.3s ease',
                    }}
                  >
                    Play
                    <span
                      style={{
                        position: 'absolute',
                        right: -8,
                        top: '50%',
                        transform: 'translate(100%, -50%)',
                        fontFamily: 'var(--mono)',
                        fontSize: 11,
                        color: C.green,
                        whiteSpace: 'nowrap',
                        opacity: seg(p2, 0.55, 0.68),
                      }}
                    >
                      name="play"
                    </span>
                  </div>
                  {['Garage', 'Quit'].map((label) => (
                    <div
                      key={label}
                      style={{
                        width: 160,
                        textAlign: 'center',
                        padding: 8,
                        borderRadius: 6,
                        border: '1px solid #262b33',
                        background: '#151821',
                        fontSize: 14,
                        color: C.dim,
                      }}
                    >
                      {label}
                    </div>
                  ))}
                </div>
              </div>

              <div
                className="lp-panel"
                style={{ padding: '16px 18px', fontFamily: 'var(--mono)', fontSize: 14, lineHeight: 1.6 }}
              >
                <div style={{ fontSize: 12, color: C.mute, marginBottom: 6 }}>MainMenu.cs</div>
                <div>
                  <span style={{ color: C.text }}>root</span>.<span style={{ color: C.blue }}>Q</span>&lt;
                  <span style={{ color: C.violet }}>Button</span>&gt;(
                  <span
                    style={{
                      color: C.gold,
                      textDecoration: squiggled ? 'underline' : 'none',
                      textDecorationColor: C.red,
                      textDecorationStyle: 'wavy',
                      background: held ? 'rgba(245,194,107,0.12)' : 'transparent',
                      borderRadius: 3,
                      padding: '0 2px',
                    }}
                  >
                    "play-btn"
                  </span>
                  )
                </div>
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: '#151821',
                    border: '1px solid #2a2f37',
                    fontSize: 12.5,
                    color: C.dim,
                    opacity: tip,
                    transform: `translateY(${(1 - tip) * 8}px)`,
                  }}
                >
                  <span style={{ color: C.red }}>UNITY0501</span> No element named{' '}
                  <span style={{ color: C.text }}>play-btn</span>. The element in this document is
                  named <span style={{ color: C.green }}>play</span>.
                </div>
              </div>
            </div>
          </div>
          <p className="lp-aside" style={{ opacity: seg(p2, 0.75, 0.9) }}>
            Everywhere else: compiles clean, returns null at runtime. Invalid UXML is refused here,
            not warned about.
          </p>
        </div>
      </section>

      {/* ── 03 · ScriptableObjects ─────────────────────────────────────── */}
      <section className="lp-chapter" aria-labelledby="ch-so" {...chapter(2)}>
        <div className="lp-stage">
          <div className="lp-pair">
            <div>
              <p className="lp-eyebrow" style={{ marginBottom: 16 }}>03 · ScriptableObjects</p>
              <h2 className="lp-h2" id="ch-so">
                We renamed one field. Three weapons quietly did zero damage.
              </h2>
              <p className="lp-lede">
                A ScriptableObject joins an asset to code through a string. Rename the field and
                every saved instance resets — no compiler error, nothing in the console. UnityIDE
                holds your assets and your code index at the same time, so it sees the drift and
                edits the real typed fields in place.
              </p>
            </div>

            <div style={{ display: 'grid', gap: 14 }}>
              <div
                className="lp-panel"
                style={{ padding: '16px 18px', fontFamily: 'var(--mono)', fontSize: 14, lineHeight: 1.6 }}
              >
                <div style={{ fontSize: 12, color: C.mute, marginBottom: 6 }}>Weapon.cs</div>
                <div>
                  <span style={{ color: C.violet }}>public</span>{' '}
                  <span style={{ color: C.blue }}>int</span>{' '}
                  <span
                    style={{
                      textDecoration: renamed > 0.3 ? 'line-through' : 'none',
                      textDecorationColor: C.red,
                      color: renamed > 0.3 ? C.mute : C.text,
                    }}
                  >
                    damage
                  </span>
                  <span style={{ color: C.text, opacity: seg(renamed, 0.5, 1) }}> baseDamage</span>{' '}
                  <span style={{ color: C.mute }}>=</span> <span style={{ color: C.gold }}>45</span>;
                  {renamed < 1 && (
                    <span
                      className="lp-caret"
                      style={{
                        display: 'inline-block',
                        width: 2,
                        height: 15,
                        background: C.text,
                        verticalAlign: -2,
                        marginLeft: 2,
                      }}
                    />
                  )}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
                <div className="lp-panel" style={{ padding: '16px 18px' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: C.mute, marginBottom: 12 }}>
                    Every other editor
                  </div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {DRIFT.map(([name, val], i) => {
                      const zero = seg(reset, i * 0.3, i * 0.3 + 0.3) > 0.5;
                      return (
                        <div
                          key={name}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            fontSize: 14,
                            fontFamily: 'var(--mono)',
                          }}
                        >
                          <span style={{ color: C.text }}>{name}</span>
                          <span style={{ color: zero ? C.red : C.text, fontVariantNumeric: 'tabular-nums' }}>
                            {zero ? '0' : val}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 14, fontSize: 12.5, color: C.red, opacity: seg(p3, 0.7, 0.8) }}>
                    Reset to 0. No error anywhere.
                  </div>
                </div>

                <div className="lp-panel" style={{ padding: '16px 18px' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      color: C.mute,
                      marginBottom: 12,
                    }}
                  >
                    <span>UnityIDE</span>
                    <span style={{ color: C.gold, opacity: seg(p3, 0.38, 0.48) }}>Drift · 3</span>
                  </div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {DRIFT.map(([name, val], i) => (
                      <div
                        key={name}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          fontSize: 14,
                          fontFamily: 'var(--mono)',
                        }}
                      >
                        <span style={{ color: C.text }}>{name}</span>
                        <span style={{ color: C.mute }}>
                          {val} →{' '}
                          <span style={{ color: C.green, opacity: seg(p3, 0.45 + i * 0.08, 0.55 + i * 0.08) }}>
                            {val} kept
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 14, fontSize: 12.5, color: C.green, opacity: seg(p3, 0.75, 0.85) }}>
                    Detected and reconciled against the class.
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p className="lp-aside" style={{ opacity: seg(p3, 0.82, 0.95) }}>
            The Inspector for a .asset file, inside your editor. Bytes are spliced, never
            re-serialized.
          </p>
        </div>
      </section>

      {/* ── 04 · Hierarchy ─────────────────────────────────────────────── */}
      <section className="lp-chapter" aria-labelledby="ch-hier" {...chapter(3)}>
        <div className="lp-stage">
          <div className="lp-pair">
            <div>
              <p className="lp-eyebrow" style={{ marginBottom: 16 }}>04 · Unity Hierarchy</p>
              <h2 className="lp-h2" id="ch-hier">The scene, as the running Editor has it open.</h2>
              <p className="lp-lede">
                We opened Player.prefab to find one missing reference and got 1,847 lines of YAML.
                UnityIDE shows the hierarchy the Editor is actually running — GameObjects,
                components, live state — not a file you parsed and hoped about.
              </p>
              {/* The number is the argument: it counts down from the YAML to the
                  one object you were looking for. */}
              <div style={{ marginTop: 32, fontFamily: 'var(--mono)' }}>
                <div
                  style={{
                    fontSize: 'clamp(40px, 5vw, 64px)',
                    fontWeight: 500,
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                    color: C.text,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {yamlCount === 1 ? '1' : yamlCount.toLocaleString('en-US')}
                </div>
                <div style={{ marginTop: 8, fontSize: 13, color: C.mute }}>
                  {yamlCount === 1 ? 'Player' : 'lines of YAML'}
                </div>
              </div>
            </div>

            <div className="lp-panel" style={{ position: 'relative', minHeight: 440 }}>
              <div className="lp-panel-head" style={{ justifyContent: 'flex-start', gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: connected ? C.green : '#2a2f37',
                    transition: 'background-color 0.3s ease',
                  }}
                />
                {connected ? 'Unity Hierarchy · SampleScene · connected' : 'Assets/Prefabs/Player.prefab'}
              </div>
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: '38px 0 0',
                  padding: '14px 16px',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: C.faint,
                  whiteSpace: 'pre',
                  opacity: 1 - fade * 0.92,
                  filter: `blur(${fade * 3}px)`,
                  transform: `translateY(${fade * 40}px)`,
                }}
              >
                {YAML.map((ln, i) => (
                  <div key={i}>{ln}</div>
                ))}
              </div>
              <div
                style={{
                  position: 'absolute',
                  inset: '38px 0 0',
                  padding: '22px 20px',
                  display: 'grid',
                  alignContent: 'start',
                  gap: 6,
                }}
              >
                {TREE.map((n, i) => {
                  const o = eo(seg(p4, 0.3 + i * 0.06, 0.42 + i * 0.06));
                  return (
                    <div
                      key={n.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: '#151821',
                        border: `1px solid ${C_RULE}`,
                        marginLeft: n.indent,
                        opacity: o,
                        transform: `translateY(${(1 - o) * 14}px)`,
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: 2, background: C.blue, flex: 'none' }} />
                      <span style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{n.name}</span>
                      <span
                        style={{
                          marginLeft: 'auto',
                          display: 'flex',
                          gap: 6,
                          flexWrap: 'wrap',
                          justifyContent: 'flex-end',
                        }}
                      >
                        {n.comps.map((c) => (
                          <span
                            key={c}
                            style={{
                              fontFamily: 'var(--mono)',
                              fontSize: 11,
                              color: C.mute,
                              border: '1px solid #262b33',
                              borderRadius: 4,
                              padding: '1px 6px',
                            }}
                          >
                            {c}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <p className="lp-aside" style={{ opacity: seg(p4, 0.75, 0.9) }}>
            Prefabs and scenes open as structure too; diffs read as GameObjects and components. Raw
            YAML stays one click away, behind a warning.
          </p>
        </div>
      </section>

      {/* ── 05 · AI copilot ────────────────────────────────────────────── */}
      <section className="lp-chapter" aria-labelledby="ch-ai" {...chapter(4)}>
        <div className="lp-stage">
          <div className="lp-pair">
            <div>
              <p className="lp-eyebrow" style={{ marginBottom: 16 }}>05 · AI copilot</p>
              <h2 className="lp-h2" id="ch-ai">An agent with Unity in its hands — that proves its work.</h2>
              <p className="lp-lede">
                Twenty-five Unity tools: it reads the scene, sets properties with Unity's own Undo
                stack intact, runs your tests. Then it recompiles in your running Editor — waking it
                through the OS if it's in the background — and re-checks every file it touched.
              </p>
              <p
                className="lp-lede"
                style={{ marginTop: 16, fontSize: 15, color: C.mute, opacity: seg(p5, 0.75, 0.88) }}
              >
                It doesn't tell you it worked. It shows you what it checked — and a skipped check is
                never a passing one.
              </p>
            </div>

            <div className="lp-panel">
              <div
                style={{
                  padding: '14px 16px',
                  borderBottom: `1px solid ${C_RULE}`,
                  display: 'grid',
                  gap: 8,
                  fontFamily: 'var(--mono)',
                  fontSize: 12.5,
                }}
              >
                <div
                  style={{
                    padding: '9px 12px',
                    borderRadius: 9,
                    background: '#151821',
                    border: `1px solid ${C_RULE}`,
                    color: C.text,
                    fontFamily: 'var(--sans)',
                    fontSize: 14,
                  }}
                >
                  Make the enemy drop loot on death
                </div>
                {TOOLS.map((name, i) => {
                  const o = eo(seg(p5, 0.08 + i * 0.07, 0.16 + i * 0.07));
                  return (
                    <div
                      key={name}
                      style={{ display: 'flex', gap: 8, color: C.mute, opacity: o, transform: `translateX(${(1 - o) * -10}px)` }}
                    >
                      <span style={{ color: C.green }}>✓</span>
                      {name}
                    </div>
                  );
                })}
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '12px 16px',
                  borderBottom: `1px solid ${C_RULE}`,
                  fontFamily: 'var(--mono)',
                  fontSize: 12.5,
                  opacity: seg(p5, 0.3, 0.38),
                }}
              >
                <span style={{ color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.green }} />
                  Verified · EnemyAI.cs <span style={{ color: C.green }}>+2</span>
                </span>
                <span style={{ color: C.mute }}>Unity 6000.3</span>
              </div>

              <div style={{ display: 'grid' }}>
                {CHECKS.map(([name, detail, status, color], i) => {
                  const o = eo(seg(p5, 0.36 + i * 0.07, 0.44 + i * 0.07));
                  return (
                    <div
                      key={name}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '140px minmax(0, 1fr) auto',
                        gap: 14,
                        alignItems: 'center',
                        padding: '10px 16px',
                        borderBottom: '1px solid #16191e',
                        fontFamily: 'var(--mono)',
                        fontSize: 13,
                        opacity: o,
                        transform: `translateX(${(1 - o) * -12}px)`,
                      }}
                    >
                      <span style={{ color: C.mute }}>{name}</span>
                      <span style={{ color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {detail}
                      </span>
                      <span style={{ color, fontSize: 12 }}>{status}</span>
                    </div>
                  );
                })}
              </div>

              <div
                style={{
                  padding: '12px 16px',
                  fontSize: 12.5,
                  color: C.faint,
                  fontFamily: 'var(--mono)',
                  opacity: seg(p5, 0.86, 0.94),
                }}
              >
                Reviewable diffs · checkpoint saved · a console error is never "fixed", only not seen
                again.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Horizontal band ────────────────────────────────────────────── */}
      <section className="lp-band" aria-label="Also wired to the Editor" {...chapter(5)}>
        <div className="lp-band-stage">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              padding: '0 var(--gut) 16px',
              maxWidth: 'var(--measure)',
              margin: '0 auto',
              width: '100%',
            }}
          >
            <p className="lp-eyebrow">Also wired to the Editor</p>
            <div className="lp-band-dots" style={{ display: 'flex', gap: 6, alignItems: 'center' }} aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  style={{
                    height: 2,
                    width: i === hIdx ? 28 : 10,
                    borderRadius: 2,
                    background: i === hIdx ? C.text : '#2a2f37',
                    transition: 'all 0.4s ease',
                  }}
                />
              ))}
            </div>
          </div>

          <div className="lp-band-viewport" style={{ overflow: 'hidden', minHeight: 0 }}>
            <div
              className="lp-band-rail"
              style={{ height: '100%', transform: `translateX(${-hPos * 100}%)`, transition: 'transform 0.15s linear' }}
            >
              {/* Console */}
              <div className="lp-band-slide" style={{ opacity: near(0) }}>
                <div className="lp-band-pair">
                  <div className="lp-panel" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                    <div className="lp-panel-head">
                      <span>Unity Console</span>
                      <span>live</span>
                    </div>
                    <div style={{ display: 'grid' }}>
                      {LOGS.map(([level, color, msg, src], i) => {
                        const o = eo(seg(rA, 0.3 + i * 0.12, 0.5 + i * 0.12));
                        return (
                          <div
                            key={src}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '52px minmax(0, 1fr)',
                              gap: 12,
                              padding: '9px 14px',
                              borderBottom: '1px solid #16191e',
                              opacity: o,
                              transform: `translateX(${(1 - o) * -8}px)`,
                            }}
                          >
                            <span style={{ color }}>{level}</span>
                            <span style={{ color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {msg}
                              <span
                                style={{
                                  color: C.blue,
                                  textDecoration: 'underline',
                                  textDecorationColor: '#2a3a52',
                                  marginLeft: 6,
                                }}
                              >
                                {src}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 10,
                        padding: '12px 14px',
                        background: 'rgba(124,183,255,0.05)',
                        opacity: eo(seg(rA, 0.85, 1)),
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 999,
                          border: '1px solid #2a3a52',
                          color: C.blue,
                          fontSize: 11.5,
                        }}
                      >
                        ✦ Ask AI about this error
                      </span>
                      <span style={{ color: C.faint, fontSize: 11.5 }}>stack trace + EnemyAI.cs:34 attached</span>
                    </div>
                  </div>
                  <div>
                    <p className="lp-eyebrow" style={{ marginBottom: 16 }}>Unity Console</p>
                    <h2 className="lp-h3">Logs stream in live. Every stack frame is a link.</h2>
                    <p className="lp-lede" style={{ fontSize: 16.5, maxWidth: '44ch', marginTop: 18 }}>
                      Console output from the running Editor, with click-to-source on every trace.
                      The agent reads the same console — so after a turn it checks for errors it
                      introduced and makes one bounded repair pass.
                    </p>
                  </div>
                </div>
              </div>

              {/* Input System */}
              <div className="lp-band-slide" style={{ opacity: near(1) }}>
                <div className="lp-band-pair">
                  <div>
                    <p className="lp-eyebrow" style={{ marginBottom: 16 }}>Input System</p>
                    <h2 className="lp-h3">Your real action names. Not JSON, not guesses.</h2>
                    <p className="lp-lede" style={{ fontSize: 16.5, maxWidth: '44ch', marginTop: 18 }}>
                      Action maps, bindings and control schemes open as a table you can read. The
                      agent reads .inputactions directly, so generated handlers use the actions your
                      project actually defines — and a binding conflict Unity reports nothing about
                      gets flagged.
                    </p>
                  </div>
                  <div className="lp-panel" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                    <div className="lp-panel-head">
                      <span>Gameplay.inputactions</span>
                      <span style={{ color: C.gold, opacity: eo(seg(rB, 0.9, 1)) }}>Conflict · 1</span>
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '70px minmax(0, 1fr) minmax(0, 1.2fr)',
                        gap: 12,
                        padding: '8px 14px',
                        borderBottom: '1px solid #16191e',
                        color: C.faint,
                        fontSize: 11,
                      }}
                    >
                      <span>Map</span>
                      <span>Action</span>
                      <span>Binding</span>
                    </div>
                    {INPUTS.map(([map, action, binding, conflict], i) => {
                      const o = eo(seg(rB, 0.3 + i * 0.12, 0.5 + i * 0.12));
                      const flag = conflict && rB > 0.9;
                      return (
                        <div
                          key={`${map}-${action}`}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '70px minmax(0, 1fr) minmax(0, 1.2fr)',
                            gap: 12,
                            padding: '10px 14px',
                            borderBottom: '1px solid #16191e',
                            background: flag ? 'rgba(245,194,107,0.06)' : 'transparent',
                            opacity: o,
                            transform: `translateX(${(1 - o) * -8}px)`,
                          }}
                        >
                          <span style={{ color: C.mute }}>{map}</span>
                          <span style={{ color: C.text }}>{action}</span>
                          <span
                            style={{
                              color: flag ? C.gold : C.mute,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {binding}
                          </span>
                        </div>
                      );
                    })}
                    <div style={{ padding: '12px 14px', color: C.dim, fontSize: 12, opacity: eo(seg(rB, 0.9, 1)) }}>
                      <span style={{ color: C.gold }}>Jump</span> loses — it never fires while the UI
                      map is enabled. Unity reports nothing for this.
                    </div>
                  </div>
                </div>
              </div>

              {/* Profiler */}
              <div className="lp-band-slide" style={{ opacity: near(2) }}>
                <div className="lp-band-pair">
                  <div className="lp-panel" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                    <div className="lp-panel-head">
                      <span>Unity Profiler</span>
                      <span>Play Mode · frame 1,204</span>
                    </div>
                    <div style={{ padding: '18px 14px 8px', display: 'flex', alignItems: 'flex-end', gap: 3, height: 120 }}>
                      {BARS.map((b, i) => (
                        <span
                          key={i}
                          style={{
                            flex: 1,
                            borderRadius: '2px 2px 0 0',
                            background: b.color,
                            height: `${b.h}%`,
                            transformOrigin: 'bottom',
                            transform: `scaleY(${eo(seg(rC, 0.2 + i * 0.02, 0.45 + i * 0.02))})`,
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ borderTop: `1px solid ${C_RULE}` }}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) 64px 64px',
                          gap: 12,
                          padding: '8px 14px',
                          color: C.faint,
                          fontSize: 11,
                          borderBottom: '1px solid #16191e',
                        }}
                      >
                        <span>Sample</span>
                        <span style={{ textAlign: 'right' }}>ms</span>
                        <span style={{ textAlign: 'right' }}>GC alloc</span>
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) 64px 64px',
                          gap: 12,
                          padding: '9px 14px',
                          borderBottom: '1px solid #16191e',
                          background: 'rgba(255,111,111,0.06)',
                        }}
                      >
                        <span style={{ color: C.text }}>EnemyAI.Update</span>
                        <span style={{ textAlign: 'right', color: C.red }}>4.8</span>
                        <span style={{ textAlign: 'right', color: C.red }}>1.2 KB</span>
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) 64px 64px',
                          gap: 12,
                          padding: '9px 14px',
                          borderBottom: '1px solid #16191e',
                        }}
                      >
                        <span style={{ color: C.dim }}>PlayerController.FixedUpdate</span>
                        <span style={{ textAlign: 'right', color: C.mute }}>0.6</span>
                        <span style={{ textAlign: 'right', color: C.mute }}>0 B</span>
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 10,
                        padding: '12px 14px',
                        background: 'rgba(124,183,255,0.05)',
                        opacity: eo(seg(rC, 0.85, 1)),
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 999,
                          border: '1px solid #2a3a52',
                          color: C.blue,
                          fontSize: 11.5,
                        }}
                      >
                        ✦ Analyzer
                      </span>
                      <span style={{ color: C.dim, fontSize: 11.5 }}>
                        GetComponent called every frame in EnemyAI.Update — cache it
                      </span>
                    </div>
                  </div>
                  <div>
                    <p className="lp-eyebrow" style={{ marginBottom: 16 }}>Profiler</p>
                    <h2 className="lp-h3">See the frame. Then see the line that spent it.</h2>
                    <p className="lp-lede" style={{ fontSize: 16.5, maxWidth: '44ch', marginTop: 18 }}>
                      Profiler samples from the running Editor, next to the code that produced them.
                      The Unity analyzers already know the usual suspects — allocations inside
                      Update, GetComponent in hot paths, Camera.main lookups — and point at them in
                      the gutter.
                    </p>
                  </div>
                </div>
              </div>

              {/* Bring your own agent */}
              <div className="lp-band-slide" style={{ opacity: driven ? clamp(0.35 + 0.65 * clamp(hPos - 2, 0, 1), 0, 1) : 1 }}>
                <div className="lp-band-pair">
                  <div>
                    <p className="lp-eyebrow" style={{ marginBottom: 16 }}>Bring your own agent</p>
                    <h2 className="lp-h3">Connect the coding subscription you already pay for.</h2>
                    <p className="lp-lede" style={{ fontSize: 16.5, maxWidth: '44ch', marginTop: 18 }}>
                      External agents plug in over ACP and get the same 25 Unity tools, the same
                      running-Editor verification, and the same reviewable diffs. Your subscription,
                      our Unity context.
                    </p>
                  </div>
                  <div className="lp-panel" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                    <div className="lp-panel-head">
                      <span>Agents</span>
                      <span>ACP</span>
                    </div>
                    <div style={{ display: 'grid' }}>
                      {AGENTS.map((a, i) => {
                        const o = eo(seg(rD, 0.3 + i * 0.18, 0.55 + i * 0.18));
                        return (
                          <div
                            key={a.name}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '32px minmax(0, 1fr) auto',
                              gap: 14,
                              alignItems: 'center',
                              padding: 14,
                              borderBottom: '1px solid #16191e',
                              opacity: o,
                              transform: `translateX(${(1 - o) * -8}px)`,
                            }}
                          >
                            <span
                              style={{
                                width: 32,
                                height: 32,
                                borderRadius: 8,
                                background: '#151821',
                                border: '1px solid #262b33',
                                display: 'grid',
                                placeItems: 'center',
                                fontSize: 13,
                                fontWeight: 500,
                                color: a.color,
                              }}
                            >
                              {a.glyph}
                            </span>
                            <span style={{ display: 'grid', gap: 2 }}>
                              <span style={{ fontFamily: 'var(--sans)', fontSize: 15, color: C.text }}>{a.name}</span>
                              <span style={{ fontSize: 11.5, color: C.faint }}>{a.sub}</span>
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                padding: '3px 9px',
                                borderRadius: 999,
                                border: `1px solid ${a.badgeBorder}`,
                                color: a.badgeColor,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {a.badge}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ padding: '12px 14px', color: C.faint, fontSize: 11.5 }}>
                      Built-in models stay available on every plan.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
