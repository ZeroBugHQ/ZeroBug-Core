import { memo, useState, type ReactNode } from "react";
import { ChevronRight, ChevronDown, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface JsonNodeProps {
  keyName: string | null;
  value: unknown;
  depth: number;
  defaultExpanded?: boolean;
}

function JsonValue({ value }: { value: unknown }) {
  if (value === null) return <span className="text-destructive/70">null</span>;
  if (value === undefined) return <span className="text-destructive/70">undefined</span>;
  if (typeof value === "boolean")
    return <span className="text-warning">{value ? "true" : "false"}</span>;
  if (typeof value === "number")
    return <span className="text-blue-500 dark:text-blue-400">{value}</span>;
  if (typeof value === "string") {
    const display = value.length > 500 ? value.slice(0, 500) + "…" : value;
    return <span className="text-emerald-600 dark:text-emerald-400">"{display}"</span>;
  }
  return <span>{String(value)}</span>;
}

const JsonNode = memo(function JsonNode({
  keyName,
  value,
  depth,
  defaultExpanded = true,
}: JsonNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2 ? defaultExpanded : false);

  if (value === null || value === undefined || typeof value !== "object") {
    return (
      <div
        className="flex items-start gap-1 rounded px-1 py-[1px] hover:bg-accent/30"
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        {keyName && (
          <span className="shrink-0 font-mono text-xs text-foreground">
            {keyName}
            <span className="text-muted-foreground">: </span>
          </span>
        )}
        <JsonValue value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const isEmpty = entries.length === 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-1 rounded px-1 py-[1px] text-left hover:bg-accent/30",
        )}
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        {isEmpty ? (
          <span className="w-3.5" />
        ) : expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        {keyName && (
          <span className="font-mono text-xs text-foreground">
            {keyName}
            <span className="text-muted-foreground">: </span>
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {isArray ? `[${value.length} items]` : `{${entries.length} keys}`}
        </span>
      </button>
      {expanded && !isEmpty && (
        <div>
          {entries.map(([k, v]) => (
            <JsonNode key={k} keyName={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
});

export function JsonTreeView({ data, className }: { data: unknown; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1">
        <span className="text-[11px] font-medium text-muted-foreground">JSON</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            title="Copy JSON"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-xs leading-relaxed scrollbar-thin">
        {typeof data === "object" && data !== null ? (
          <JsonNode keyName={null} value={data} depth={0} />
        ) : (
          <JsonValue value={data} />
        )}
      </div>
    </div>
  );
}

export function formatJsonDisplay(text: string): string {
  if (!text) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function isJsonString(text: string): boolean {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function tryParseJson(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
