import { useEffect, useRef, useState } from 'react';
import { C, HERO_CODE, TYPED_LINE, FIXED_LINE } from './story-data';

/**
 * The editor pane in the hero window.
 *
 * It plays one loop, and the loop is the argument the whole page then spends
 * six chapters on: you write the obvious line, an analyzer that knows Unity
 * flags it as a per-frame allocation, the quick fix rewrites it against the
 * field cached in Awake. Four stages, on a timer rather than on scroll, because
 * this one sits above the fold where there is no scroll to map to yet.
 *
 * Stage 0 types. Stage 1 raises UNITY0002. Stage 2 holds it long enough to
 * read. Stage 3 applies the fix. Then it starts over.
 */

type Stage = 0 | 1 | 2 | 3;

const LINE_START = HERO_CODE.length + 1;

export default function HeroEditor() {
  // Starts finished, not blank. The server renders this markup too, and a
  // hero that arrives empty and fills in is worse than one that arrives whole.
  const [typed, setTyped] = useState(TYPED_LINE.length);
  const [stage, setStage] = useState<Stage>(3);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let t = 0;
    let s: Stage = 0;
    setTyped(0);
    setStage(0);

    const tick = () => {
      let next = 45;
      if (s === 0) {
        if (t < TYPED_LINE.length) {
          t += 1;
          setTyped(t);
        } else {
          next = 700;
          s = 1;
          setStage(1);
        }
      } else if (s === 1) {
        next = 1800;
        s = 2;
        setStage(2);
      } else if (s === 2) {
        next = 3600;
        s = 3;
        setStage(3);
      } else {
        next = 600;
        s = 0;
        t = 0;
        setStage(0);
        setTyped(0);
      }
      timer.current = window.setTimeout(tick, next);
    };

    timer.current = window.setTimeout(tick, 1400);
    return () => window.clearTimeout(timer.current);
  }, []);

  const flagged = stage >= 1 && stage < 3;
  const fixed = stage >= 3;

  const body = fixed ? FIXED_LINE : TYPED_LINE.slice(0, typed);
  // A completion suggestion, shown only while there is still line left to
  // suggest — it disappears the moment the typing catches up with it.
  const ghost =
    stage === 0 && typed > 12 && typed < TYPED_LINE.length
      ? TYPED_LINE.slice(typed, typed + 14)
      : '';

  return (
    <div className="lp-editor">
      <div className="lp-editor-code">
        {HERO_CODE.map((ln, i) => (
          <Row key={i} n={i + 1} tag={ln.tag}>
            {ln.spans.map(([text, color], j) => (
              <span key={j} style={{ color }}>
                {text}
              </span>
            ))}
          </Row>
        ))}

        <Row
          n={LINE_START}
          tag=""
          bg={flagged ? 'rgba(245,194,107,0.05)' : fixed ? 'rgba(111,227,165,0.05)' : 'rgba(255,255,255,0.02)'}
        >
          <span style={{ color: C.dim }}>{'        '}</span>
          <span
            style={{
              color: fixed ? C.text : C.dim,
              textDecoration: flagged ? 'underline' : 'none',
              textDecorationColor: C.gold,
              textDecorationStyle: 'wavy',
            }}
          >
            {body}
          </span>
          <span style={{ color: C.ghost, fontStyle: 'italic' }}>{ghost}</span>
          {stage === 0 && (
            <span
              className="lp-caret"
              style={{
                display: 'inline-block',
                width: 2,
                height: 14,
                background: C.text,
                verticalAlign: -2,
              }}
            />
          )}
        </Row>
        <Row n={LINE_START + 1} tag="">
          <span style={{ color: C.dim }}>{'    }'}</span>
        </Row>
        <Row n={LINE_START + 2} tag="">
          <span style={{ color: C.dim }}>{'}'}</span>
        </Row>
      </div>

      <div className="lp-editor-problems">
        <div style={{ fontSize: 11, color: C.faint, display: 'flex', justifyContent: 'space-between' }}>
          <span>Problems</span>
          <span>31 Unity analyzers</span>
        </div>

        <div
          style={{
            padding: '10px 12px',
            borderRadius: 9,
            border: '1px solid #3a3320',
            background: 'rgba(245,194,107,0.06)',
            color: C.dim,
            lineHeight: 1.5,
            opacity: flagged ? 1 : 0,
            transform: `translateY(${flagged ? 0 : 6}px)`,
            transition: 'opacity 0.4s ease, transform 0.4s ease',
          }}
        >
          <span style={{ color: C.gold }}>UNITY0002</span> · PlayerController.cs:{LINE_START}
          <br />
          GetComponent called every frame — cache it in Awake.
        </div>

        <div
          style={{
            padding: '10px 12px',
            borderRadius: 9,
            border: '1px solid #1f3a2c',
            background: 'rgba(111,227,165,0.06)',
            color: C.dim,
            lineHeight: 1.5,
            opacity: fixed ? 1 : 0,
            transform: `translateY(${fixed ? 0 : 6}px)`,
            transition: 'opacity 0.4s ease, transform 0.4s ease',
          }}
        >
          <span style={{ color: C.green }}>✓ Quick fix applied</span> · using cached{' '}
          <span style={{ color: C.text }}>rb</span> from Awake
          <br />
          <span style={{ color: C.faint }}>0 findings · compiled in Unity 6000.3</span>
        </div>

        <div
          style={{
            marginTop: 'auto',
            paddingTop: 10,
            borderTop: '1px solid #1a1e24',
            color: C.faint,
            fontSize: 11,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>Assembly-CSharp</span>
          <span>C# · UTF-8</span>
        </div>
      </div>
    </div>
  );
}

function Row({
  n,
  tag,
  bg = 'transparent',
  children,
}: {
  n: number;
  tag: string;
  bg?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '34px 64px minmax(0, 1fr)',
        alignItems: 'center',
        background: bg,
      }}
    >
      <span style={{ textAlign: 'right', paddingRight: 10, color: '#3a4150', fontSize: 11 }}>{n}</span>
      {/* The gutter marks methods Unity calls for you. Blank on every other
          line, which is what makes the two that carry it worth reading. */}
      <span
        style={{
          fontSize: 9.5,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: C.blue,
          paddingLeft: 4,
        }}
      >
        {tag}
      </span>
      <span
        style={{
          whiteSpace: 'pre',
          color: C.dim,
          paddingRight: 16,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {children}
      </span>
    </div>
  );
}
