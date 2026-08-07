import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { getStoredToken } from "@/lib/auth";

// Order mirrors the landing page itself: features → download → pricing → docs.
const links = [
  { label: "Features", href: "/features" },
  { label: "Download", href: "#download" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs/" },
];

const Navbar = () => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    // localStorage only after hydration — the island is pre-rendered at build time.
    setAuthed(!!getStoredToken());
  }, []);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 20);

      const sections = ["features", "download"];
      for (let i = sections.length - 1; i >= 0; i--) {
        const el = document.getElementById(sections[i]);
        if (el && el.getBoundingClientRect().top <= 120) {
          setActive(sections[i]);
          return;
        }
      }
      setActive("");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-border/50 bg-background/80 backdrop-blur-xl"
          : "bg-transparent"
      }`}
    >
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <a href="/" className="flex items-center gap-3">
          <img src="/icon.png" alt="Arcane IDE" className="h-9 w-9 rounded-lg" />
          <span className="font-display text-lg font-bold tracking-tight text-foreground">
            Arcane<span className="text-primary">IDE</span>
          </span>
          <span className="ml-1.5 rounded-md bg-primary/15 border border-primary/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
            Beta
          </span>
        </a>

        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => {
            const id = l.href.replace("#", "");
            const isActive = active === id;
            return (
              <a
                key={l.label}
                href={l.href}
                className={`group relative rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground hover:text-primary"
                }`}
              >
                {l.label}
                {/* Always rendered, so the bar can TRANSITION rather than pop
                    in — mounting it only when active gave no animation. Grows
                    from the centre (default transform-origin) on hover, and
                    stays put while the section is active. */}
                <span
                  className={`pointer-events-none absolute bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-primary glow-orange-sm transition-transform duration-200 ease-out ${
                    isActive ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
                  }`}
                />
              </a>
            );
          })}

          {/* Same hover treatment as the nav links above — it sits in the same
              row, so hovering it to a different colour reads as a bug. */}
          <a
            href={authed ? "/account" : "/auth"}
            className="group relative rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
          >
            {authed ? "Account" : "Sign in"}
            <span className="pointer-events-none absolute bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 scale-x-0 rounded-full bg-primary glow-orange-sm transition-transform duration-200 ease-out group-hover:scale-x-100" />
          </a>

          <Button variant="hero" size="sm" className="ml-4" asChild>
            <a href="#download">Download</a>
          </Button>
        </div>

        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen(!open)}>
          {open ? <X /> : <Menu />}
        </Button>
      </div>

      {open && (
        <div className="border-t border-border/50 bg-background/95 backdrop-blur-xl md:hidden">
          <div className="flex flex-col gap-2 p-4">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
              >
                {l.label}
              </a>
            ))}
            <a
              href={authed ? "/account" : "/auth"}
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            >
              {authed ? "Account" : "Sign in"}
            </a>
            <Button variant="hero" size="sm" className="mt-2" asChild>
              <a href="#download">Download</a>
            </Button>
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;
