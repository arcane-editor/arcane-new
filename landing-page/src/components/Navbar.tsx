import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { CreditCard, LogOut, Menu, Settings, X } from "lucide-react";
import AccountMenu, { AccountSummaryBlock, useAuthSummary } from "@/components/AccountMenu";

// Order mirrors the landing page itself: features → download → pricing → docs.
const links = [
  { label: "Features", href: "/features" },
  { label: "Download", href: "#download" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs/" },
];

const mobileItemClass =
  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary";

const Navbar = () => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const auth = useAuthSummary();

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
          ? "border-b border-border bg-void/90 backdrop-blur-md"
          : "bg-transparent"
      }`}
    >
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <a href="/" className="flex items-center gap-3">
          <img src="/icon.png" alt="" className="h-8 w-8" />
          <span className="font-display text-base font-semibold tracking-tight text-foreground">
            Unity<span className="text-primary">IDE</span>
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
                  className={`pointer-events-none absolute bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-primary transition-transform duration-200 ease-out ${
                    isActive ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
                  }`}
                />
              </a>
            );
          })}

          {/* Same hover treatment as the nav links above — it sits in the same
              row, so hovering it to a different colour reads as a bug. */}
          {auth.state === "signed-out" && (
            <a
              href="/auth"
              className="group relative rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
            >
              Log in
              <span className="pointer-events-none absolute bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 scale-x-0 rounded-full bg-primary transition-transform duration-200 ease-out group-hover:scale-x-100" />
            </a>
          )}

          {/* Download stays the only amber CTA in this row; Sign up sits a tier
              below it, Log in a tier below that. */}
          {auth.state === "signed-out" && (
            <Button variant="secondary" size="sm" className="ml-2" asChild>
              <a href="/auth?tab=signup">Sign up</a>
            </Button>
          )}

          <Button variant="hero" size="sm" className="ml-4" asChild>
            <a href="#download">Download</a>
          </Button>

          {/* Avatar is last, the one position every product puts it in.
              Fixed-size placeholder while auth is unknown so the row never
              shifts when hydration resolves. */}
          {auth.state === "unknown" && <div className="ml-2 h-9 w-9" aria-hidden="true" />}
          {auth.state === "signed-in" && <AccountMenu {...auth} />}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => {
            // Same lazy fetch the desktop popover does — plan/credits are only
            // needed once the sheet is actually on screen.
            if (!open && auth.state === "signed-in") auth.loadMe();
            setOpen(!open);
          }}
        >
          {open ? <X /> : <Menu />}
        </Button>
      </div>

      {open && (
        <div className="border-t border-border bg-void/95 backdrop-blur-md md:hidden">
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
            <Button variant="hero" size="sm" className="mt-2" asChild>
              <a href="#download">Download</a>
            </Button>

            {/* A popover inside a sheet is a trap on touch, so the same content
                renders as flat rows here instead. */}
            {auth.state === "signed-out" && (
              <div className="mt-2 flex flex-col gap-2 border-t border-border/50 pt-3">
                <a
                  href="/auth"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                >
                  Log in
                </a>
                <Button variant="secondary" size="sm" asChild>
                  <a href="/auth?tab=signup">Sign up</a>
                </Button>
              </div>
            )}

            {auth.state === "signed-in" && (
              <div className="mt-2 border-t border-border/50 pt-2">
                <AccountSummaryBlock email={auth.email} me={auth.me} meFailed={auth.meFailed} tiers={auth.tiers} />
                <a
                  href="/account"
                  onClick={() => setOpen(false)}
                  className={mobileItemClass}
                >
                  <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Account settings
                </a>
                <a
                  href="/account#billing"
                  onClick={() => setOpen(false)}
                  className={mobileItemClass}
                >
                  <CreditCard className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Plans &amp; billing
                </a>
                <button
                  type="button"
                  onClick={auth.signOut}
                  className={`${mobileItemClass} w-full hover:bg-destructive/10 hover:text-destructive`}
                >
                  <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;
