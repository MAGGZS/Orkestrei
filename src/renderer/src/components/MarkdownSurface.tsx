import React, { useState } from 'react';
import { Check, Copy, Square, CheckSquare } from 'lucide-react';

interface MarkdownSurfaceProps {
  text: string;
  foregroundColor?: string;
  readOnly?: boolean;
  onChangeText?: (nextText: string) => void;
}

function renderInline(line: string, keyPrefix: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(line.slice(lastIndex, match.index));
    }
    const raw = match[0];
    const k = `${keyPrefix}-${idx++}`;
    if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push(
        <strong key={k} className="font-bold">
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push(
        <em key={k} className="italic">
          {raw.slice(1, -1)}
        </em>
      );
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push(
        <code
          key={k}
          className="rounded bg-black/15 px-1 py-0.5 font-mono text-[11px]"
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else if (raw.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      if (linkMatch) {
        const [, label, href] = linkMatch;
        tokens.push(
          <button
            key={k}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void window.orkestrei.app.openExternal(href);
            }}
            className="underline decoration-current/50 underline-offset-2 hover:opacity-80"
          >
            {label}
          </button>
        );
      } else {
        tokens.push(raw);
      }
    }
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < line.length) {
    tokens.push(line.slice(lastIndex));
  }
  return tokens;
}

export const MarkdownSurface: React.FC<MarkdownSurfaceProps> = ({
  text,
  foregroundColor,
  readOnly = false,
  onChangeText,
}) => {
  const [copiedBlockKey, setCopiedBlockKey] = useState<string | null>(null);

  if (!text.trim()) {
    return (
      <div className="p-2.5 text-[12px] italic opacity-45" style={{ color: foregroundColor }}>
        Empty note…
      </div>
    );
  }

  const lines = text.split(/\r?\n/);

  const toggleTaskAtLine = (lineIdx: number) => {
    if (readOnly || !onChangeText) return;
    const nextLines = [...lines];
    const target = nextLines[lineIdx];
    if (/^(\s*[-*]\s+)\[ \]/.test(target)) {
      nextLines[lineIdx] = target.replace(/^(\s*[-*]\s+)\[ \]/, '$1[x]');
      onChangeText(nextLines.join('\n'));
    } else if (/^(\s*[-*]\s+)\[[xX]\]/.test(target)) {
      nextLines[lineIdx] = target.replace(/^(\s*[-*]\s+)\[[xX]\]/, '$1[ ]');
      onChangeText(nextLines.join('\n'));
    }
  };

  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const start = i;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      const codeText = codeLines.join('\n');
      const bKey = `code-${start}`;
      blocks.push(
        <div
          key={bKey}
          onPointerDown={(e) => e.stopPropagation()}
          className="group relative my-1.5 rounded-lg bg-black/20 p-2 font-mono text-[11px] leading-snug"
        >
          <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider opacity-60">
            <span>{lang || 'code'}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(codeText);
                setCopiedBlockKey(bKey);
                setTimeout(() => setCopiedBlockKey(null), 1400);
              }}
              className="flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-black/20"
            >
              {copiedBlockKey === bKey ? <Check className="size-2.5" /> : <Copy className="size-2.5" />}
              {copiedBlockKey === bKey ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words">{codeText}</pre>
        </div>
      );
      i += 1;
      continue;
    }

    // Headings
    const hMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hMatch) {
      const lvl = hMatch[1].length;
      const cls =
        lvl === 1
          ? 'mt-1.5 mb-1 text-[14px] font-bold tracking-tight'
          : lvl === 2
            ? 'mt-1.5 mb-0.5 text-[13px] font-bold'
            : 'mt-1 mb-0.5 text-[12px] font-semibold uppercase tracking-wide opacity-80';
      blocks.push(
        <div key={`h-${i}`} className={cls}>
          {renderInline(hMatch[2], `h-${i}`)}
        </div>
      );
      i += 1;
      continue;
    }

    // Interactive Task list
    const taskMatch = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (taskMatch) {
      const indent = taskMatch[1].length;
      const checked = taskMatch[2].toLowerCase() === 'x';
      const lineIdx = i;
      blocks.push(
        <div
          key={`task-${i}`}
          onPointerDown={(e) => e.stopPropagation()}
          className="my-0.5 flex items-start gap-1.5 text-[12px] leading-snug"
          style={{ paddingLeft: Math.min(24, indent * 6) }}
        >
          <button
            type="button"
            disabled={readOnly}
            onClick={() => toggleTaskAtLine(lineIdx)}
            className="mt-0.5 shrink-0 opacity-85 hover:opacity-100 disabled:cursor-default"
            title={checked ? 'Uncheck' : 'Check'}
          >
            {checked ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
          </button>
          <span className={checked ? 'line-through opacity-55' : ''}>
            {renderInline(taskMatch[3], `task-${i}`)}
          </span>
        </div>
      );
      i += 1;
      continue;
    }

    // Bullet / ordered list
    const ulMatch = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (ulMatch) {
      blocks.push(
        <div
          key={`ul-${i}`}
          className="my-0.5 flex items-start gap-1.5 text-[12px] leading-snug"
          style={{ paddingLeft: Math.min(24, ulMatch[1].length * 6) }}
        >
          <span className="mt-0.5 opacity-60">•</span>
          <span>{renderInline(ulMatch[2], `ul-${i}`)}</span>
        </div>
      );
      i += 1;
      continue;
    }

    const olMatch = /^(\s*)(\d+\.)\s+(.*)$/.exec(line);
    if (olMatch) {
      blocks.push(
        <div
          key={`ol-${i}`}
          className="my-0.5 flex items-start gap-1.5 text-[12px] leading-snug"
          style={{ paddingLeft: Math.min(24, olMatch[1].length * 6) }}
        >
          <span className="font-mono text-[11px] opacity-70">{olMatch[2]}</span>
          <span>{renderInline(olMatch[3], `ol-${i}`)}</span>
        </div>
      );
      i += 1;
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith('> ')) {
      blocks.push(
        <div
          key={`bq-${i}`}
          className="my-1 border-l-2 border-current/35 pl-2 text-[12px] italic opacity-85"
        >
          {renderInline(line.replace(/^\s*>\s?/, ''), `bq-${i}`)}
        </div>
      );
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      blocks.push(<hr key={`hr-${i}`} className="my-2 border-black/15" />);
      i += 1;
      continue;
    }

    // Empty line
    if (!line.trim()) {
      blocks.push(<div key={`sp-${i}`} className="h-2" />);
      i += 1;
      continue;
    }

    // Paragraph line
    blocks.push(
      <p key={`p-${i}`} className="my-0.5 text-[12px] leading-relaxed">
        {renderInline(line, `p-${i}`)}
      </p>
    );
    i += 1;
  }

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="flex-1 overflow-y-auto p-2.5 select-text"
      style={{ color: foregroundColor }}
    >
      {blocks}
    </div>
  );
};
