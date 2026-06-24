import { motion } from "framer-motion";

const stats = [
  { value: "30+", label: "AI Tools Built-In" },
  { value: "10+", label: "Unity Parsers" },
  { value: "3", label: "Operating Modes" },
  { value: "2", label: "Platforms Supported" },
];

const StatsBar = () => {
  return (
    <section className="relative py-10 sm:py-16 border-y border-border/30">
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/[0.03] to-transparent" />
      <div className="container relative z-10 mx-auto px-4">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="text-center"
            >
              <span className="font-display text-3xl font-bold text-gradient-orange sm:text-4xl md:text-5xl">
                {s.value}
              </span>
              <p className="mt-2 text-sm text-muted-foreground">{s.label}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default StatsBar;
