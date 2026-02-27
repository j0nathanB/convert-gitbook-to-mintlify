/**
 * Sanitize markdown content for MDX compatibility.
 *
 * MDX is stricter than regular Markdown: bare angle brackets, curly braces,
 * and HTML comments all need special treatment.  This module applies those
 * transforms while carefully avoiding modifications inside fenced code blocks
 * and inline code spans.
 */

/**
 * Sanitize `content` so it is valid MDX.
 *
 * 1. Escape `<` / `>` in prose (not inside code fences or inline code).
 * 2. Escape `{` / `}` in prose.
 * 3. Convert HTML comments `<!-- ... -->` to MDX comments `{/* ... *​/}`.
 */
export function sanitizeMdx(content: string): string {
  // Split into regions that are "safe to edit" (prose) and "hands off" (code).
  const segments = splitCodeSegments(content);

  const result = segments
    .map((seg) => {
      if (seg.isCode) {
        return seg.text;
      }
      let text = seg.text;

      // Convert HTML comments first (before angle-bracket escaping).
      text = convertHtmlComments(text);

      // Escape angle brackets that are NOT part of JSX-style tags we emit.
      text = escapeAngleBrackets(text);

      // Escape curly braces that are NOT part of our MDX comment syntax.
      text = escapeCurlyBraces(text);

      return text;
    })
    .join('');

  return result;
}

// ── Internals ────────────────────────────────────────────────────────

interface Segment {
  text: string;
  isCode: boolean;
}

/**
 * Split content into alternating prose / code segments.
 *
 * "Code" means either a fenced code block (``` ... ```) or an inline
 * code span (` ... `).  Everything else is "prose".
 */
function splitCodeSegments(content: string): Segment[] {
  const segments: Segment[] = [];

  // This regex matches fenced code blocks OR inline code spans.
  // Fenced blocks: lines starting with ``` (with optional language) through closing ```.
  // Inline code: backtick-delimited spans (handles multiple backticks like `` ... ``).
  const codeRe = /(?:^`{3,}[^\n]*\n[\s\S]*?^`{3,}\s*$)|(?:`+[^`]*`+)/gm;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeRe.exec(content)) !== null) {
    // Prose before this code region
    if (match.index > lastIndex) {
      segments.push({ text: content.slice(lastIndex, match.index), isCode: false });
    }
    segments.push({ text: match[0], isCode: true });
    lastIndex = codeRe.lastIndex;
  }

  // Trailing prose
  if (lastIndex < content.length) {
    segments.push({ text: content.slice(lastIndex), isCode: false });
  }

  return segments;
}

/**
 * Convert HTML comments to MDX comments.
 */
function convertHtmlComments(text: string): string {
  return text.replace(/<!--([\s\S]*?)-->/g, (_match, body: string) => {
    return `{/*${body}*/}`;
  });
}

/**
 * Escape `<` and `>` that look like comparison operators or prose, but
 * leave JSX-looking tags alone (tags that start with an uppercase letter
 * or are known Mintlify components, self-closing tags, closing tags, etc.).
 *
 * We keep `<Tag`, `</Tag`, `<Tag />`, and standard HTML tags intact.
 */
function escapeAngleBrackets(text: string): string {
  // We want to preserve any `<SomeTag ...>`, `</SomeTag>`, `<br />`, etc.
  // A simple heuristic: `<` immediately followed by a letter or `/` is a tag.
  // Everything else gets escaped.
  return text.replace(/<(?![a-zA-Z/!])/g, '&lt;').replace(/(?<![a-zA-Z"'/\-])>/g, '&gt;');
}

// Escape `{` and `}` in prose.  We leave MDX comment delimiters alone
// because those are MDX comments we may have just created.
function escapeCurlyBraces(text: string): string {
  // First, protect MDX comments by replacing them with placeholders.
  const comments: string[] = [];
  let protected_ = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => {
    comments.push(m);
    return `\x00MDXC${comments.length - 1}\x00`;
  });

  // Also protect JSX expressions that look intentional (e.g., inside component props).
  // We keep it simple: escape all remaining braces.
  protected_ = protected_.replace(/\{/g, '\\{').replace(/\}/g, '\\}');

  // Restore MDX comments.
  protected_ = protected_.replace(/\x00MDXC(\d+)\x00/g, (_m, idx: string) => {
    return comments[Number(idx)];
  });

  return protected_;
}
