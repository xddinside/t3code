import { memo, useEffect, useRef, useState } from "react";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";

interface MermaidDiagramProps {
  code: string;
  className?: string;
}

const MERMAID_THEME_MAP = {
  light: "base",
  dark: "dark",
} as const;

function MermaidDiagram({ code, className }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { resolvedTheme } = useTheme();
  const renderAttemptRef = useRef(0);
  const initializedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let rafId: ReturnType<typeof setTimeout> | null = null;

    async function renderDiagram() {
      setIsLoading(true);
      setError(null);

      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;

        if (!initializedRef.current) {
          mermaid.initialize({
            startOnLoad: false,
            theme: MERMAID_THEME_MAP[resolvedTheme],
            securityLevel: "loose",
            fontFamily: "inherit",
            flowchart: {
              useMaxWidth: true,
              htmlLabels: true,
            },
            sequence: {
              useMaxWidth: true,
              wrap: true,
            },
          });
          initializedRef.current = true;
        }

        renderAttemptRef.current += 1;
        const attempt = renderAttemptRef.current;

        await new Promise((resolve) => {
          rafId = setTimeout(resolve, 0);
        });

        if (cancelled || attempt !== renderAttemptRef.current) return;

        const id = `mermaid-${attempt}-${Math.random().toString(36).slice(2, 9)}`;
        const result = await mermaid.render(id, code.trim());

        if (cancelled || attempt !== renderAttemptRef.current) return;

        setSvg(result.svg ?? "");
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;

        const message = err instanceof Error ? err.message : "Failed to render diagram";
        setError(message);
        setIsLoading(false);
      } finally {
        if (rafId !== null) {
          clearTimeout(rafId);
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code, resolvedTheme]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "overflow-x-auto rounded-lg border border-border bg-background px-4 py-4",
        isLoading && "min-h-[120px] flex items-center justify-center",
        error &&
          "min-h-[80px] flex flex-col items-center justify-center gap-2 border-destructive/50 bg-destructive/10",
        className,
      )}
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span className="text-xs">Rendering diagram...</span>
        </div>
      )}
      {error && (
        <>
          <span className="text-xs text-destructive font-medium">Diagram render error</span>
          <span className="text-xs text-muted-foreground max-w-md truncate">{error}</span>
        </>
      )}
      {!isLoading && !error && svg && <div dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  );
}

export default memo(MermaidDiagram);
