import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

const codeLines = [
  { text: "public class PlayerController : MonoBehaviour", color: "text-primary" },
  { text: "{", color: "text-foreground" },
  { text: "    [SerializeField] private float speed = 5f;", color: "text-muted-foreground" },
  { text: "    private Rigidbody rb;", color: "text-muted-foreground" },
  { text: "", color: "" },
  { text: "    void Update()", color: "text-foreground" },
  { text: "    {", color: "text-foreground" },
  { text: '        float h = Input.GetAxis("Horizontal");', color: "text-muted-foreground" },
];

const aiSuggestion = "        rb.AddForce(Vector3.right * h * speed);";

const HeroIDEMockup = () => {
  const [typedText, setTypedText] = useState("");
  const [showSuggestion, setShowSuggestion] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setShowSuggestion(true), 2000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!showSuggestion) return;
    let i = 0;
    const interval = setInterval(() => {
      setTypedText(aiSuggestion.slice(0, i + 1));
      i++;
      if (i >= aiSuggestion.length) clearInterval(interval);
    }, 40);
    return () => clearInterval(interval);
  }, [showSuggestion]);

  return (
    <div className="relative">
      {/* Glow behind IDE */}
      <div className="absolute -inset-4 rounded-2xl bg-primary/5 blur-3xl" />

      <div className="relative rounded-xl ide-shadow overflow-hidden border border-border/50">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-border/50 bg-secondary/80 px-4 py-3">
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-destructive/70" />
            <div className="h-3 w-3 rounded-full bg-primary/50" />
            <div className="h-3 w-3 rounded-full bg-green-500/50" />
          </div>
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            PlayerController.cs — ArcaneIDE
          </span>
          <div className="ml-auto flex items-center gap-1">
            <img src="/icon.png" alt="" className="h-4 w-4 rounded-sm" />
          </div>
        </div>

        {/* Code area */}
        <div className="bg-background/95 p-4 font-mono text-[13px] leading-6">
          {codeLines.map((line, i) => (
            <div key={i} className="flex">
              <span className="mr-4 inline-block w-6 text-right text-muted-foreground/40 select-none">
                {i + 1}
              </span>
              <span className={line.color}>{line.text}</span>
            </div>
          ))}

          {/* AI suggestion line */}
          <div className="flex">
            <span className="mr-4 inline-block w-6 text-right text-muted-foreground/40 select-none">
              9
            </span>
            {showSuggestion ? (
              <span className="text-primary/80">
                {typedText}
                <span className="inline-block h-4 w-[2px] bg-primary animate-typing-cursor ml-px" />
              </span>
            ) : (
              <span className="h-5" />
            )}
          </div>

          {/* AI label */}
          {showSuggestion && typedText.length > 10 && (
            <motion.div
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-2 ml-10 inline-flex items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1 text-xs text-primary"
            >
              <Sparkles className="h-3 w-3" />
              AI Suggestion — Tab to accept
            </motion.div>
          )}

          <div className="flex mt-1">
            <span className="mr-4 inline-block w-6 text-right text-muted-foreground/40 select-none">
              10
            </span>
            <span className="text-foreground">{"    }"}</span>
          </div>
          <div className="flex">
            <span className="mr-4 inline-block w-6 text-right text-muted-foreground/40 select-none">
              11
            </span>
            <span className="text-foreground">{"}"}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeroIDEMockup;
