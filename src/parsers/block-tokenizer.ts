import type { BlockToken } from '../types.js';

// ─── Known GitBook Block Types ───

const CURRENT_BLOCK_TYPES = new Set([
  'hint',
  'tabs',
  'tab',
  'stepper',
  'step',
  'details',
  'embed',
  'content-ref',
  'code',
  'file',
  'swagger',
  'swagger-description',
  'swagger-parameter',
  'swagger-response',
]);

const LEGACY_BLOCK_TYPES = new Set([
  'api-method',
  'api-method-summary',
  'api-method-description',
  'api-method-spec',
  'api-method-request',
  'api-method-response',
  'api-method-headers',
  'api-method-path-parameters',
  'api-method-query-parameters',
  'api-method-body-parameters',
  'api-method-parameter',
  'api-method-response-example',
  'code-tabs',
  'code-tabs-item',
]);

const ALL_BLOCK_TYPES = new Set([...CURRENT_BLOCK_TYPES, ...LEGACY_BLOCK_TYPES]);

// ─── State Machine ───

const enum State {
  /** Scanning plain text outside any block marker. */
  Text,
  /** We just saw `{` -- waiting to see if the next char is `%`. */
  MaybeOpen,
  /** Inside `{% ... %}` -- accumulating the tag body. */
  InsideTag,
  /** Inside tag body, we saw `%` -- waiting for `}` to close. */
  MaybeClose,
}

interface OpenFrame {
  type: string;
  attributes: Record<string, string>;
  /** Position (in `input`) where the opening `{%` started. */
  openStart: number;
  /** Position right after the closing `%}` of the opening tag. */
  contentStart: number;
  /** Line number (1-based) of the opening tag. */
  startLine: number;
  /** Nested children collected so far. */
  children: BlockToken[];
  /**
   * Cursor tracking the start of the next content segment.
   * After the opening tag, this is set to contentStart.
   * After a child block closes, this advances past the child's closing tag.
   */
  contentCursor: number;
  /** Accumulated content segments (text between/around child blocks). */
  contentParts: string[];
}

/**
 * Parse a `{% type attr="val" %}` opening/self-closing tag body.
 * Returns the block type and a dictionary of attributes.
 */
function parseTagBody(body: string): {
  type: string;
  attributes: Record<string, string>;
  isEnd: boolean;
} {
  const trimmed = body.trim();

  // Check for closing tag: `endtype`
  if (trimmed.startsWith('end')) {
    return { type: trimmed, attributes: {}, isEnd: true };
  }

  // Extract type (first token)
  const spaceIdx = trimmed.search(/\s/);
  const type = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);

  // Parse attributes: key="value" or key='value'
  const attributes: Record<string, string> = {};
  const attrRegex = /(\w[\w-]*)=["']([^"']*)["']/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rest)) !== null) {
    attributes[match[1]] = match[2];
  }

  return { type, attributes, isEnd: false };
}

/**
 * Compute the 1-based line number for a given character offset.
 */
function lineAt(offset: number, lineStarts: number[]): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1; // 1-based
}

/**
 * Build an array of character offsets where each line starts.
 */
function buildLineStarts(input: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Find the matching open frame for a closing `endXxx` tag.
 * Searches from the top of the stack downward.
 */
function findMatchingFrame(
  stack: OpenFrame[],
  endType: string,
): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].type === endType) {
      return i;
    }
  }
  return -1;
}

/**
 * Tokenize GitBook `{% %}` blocks from a markdown string using a character-
 * level state machine.
 *
 * The tokenizer scans character-by-character, tracking `{%` open markers and
 * `%}` close markers. It maintains a stack of open frames for nesting and
 * collects inner content by tracking a cursor that advances past child blocks.
 *
 * @param input   The full markdown source text.
 * @param strict  When true, throw on unrecognized `{% %}` block types.
 * @returns An object with the original `output` string (unchanged) and the
 *          list of top-level `tokens` found.
 */
export function tokenize(
  input: string,
  strict = false,
): { output: string; tokens: BlockToken[] } {
  const lineStarts = buildLineStarts(input);
  const tokens: BlockToken[] = [];
  const stack: OpenFrame[] = [];

  let state: State = State.Text;
  let markerStart = 0;
  let tagBody = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    switch (state) {
      case State.Text:
        if (ch === '{') {
          markerStart = i;
          state = State.MaybeOpen;
        }
        break;

      case State.MaybeOpen:
        if (ch === '%') {
          tagBody = '';
          state = State.InsideTag;
        } else {
          state = State.Text;
          if (ch === '{') {
            markerStart = i;
            state = State.MaybeOpen;
          }
        }
        break;

      case State.InsideTag:
        if (ch === '%') {
          state = State.MaybeClose;
        } else {
          tagBody += ch;
        }
        break;

      case State.MaybeClose:
        if (ch === '}') {
          // Complete tag found: `{% tagBody %}`
          const parsed = parseTagBody(tagBody);
          const tagEnd = i + 1; // position right after `%}`

          if (parsed.isEnd) {
            // ── Closing tag ──
            const endType = parsed.type.slice(3); // strip leading `end`
            const frameIdx = findMatchingFrame(stack, endType);

            if (frameIdx >= 0) {
              const frame = stack[frameIdx];

              // Capture any content between the last cursor and this closing tag
              if (frame.contentCursor < markerStart) {
                frame.contentParts.push(input.slice(frame.contentCursor, markerStart));
              }

              const endLine = lineAt(i, lineStarts);
              const raw = input.slice(frame.openStart, tagEnd);
              const content = frame.contentParts.join('');

              const token: BlockToken = {
                type: frame.type,
                attributes: frame.attributes,
                content,
                children: frame.children,
                raw,
                startLine: frame.startLine,
                endLine,
              };

              // Remove this frame and everything above it from the stack
              stack.length = frameIdx;

              if (stack.length > 0) {
                // Add as child of the parent frame
                const parent = stack[stack.length - 1];
                parent.children.push(token);
                // Capture parent content from its cursor to the start of this
                // child block, then advance cursor past this closing tag
                if (parent.contentCursor < frame.openStart) {
                  parent.contentParts.push(
                    input.slice(parent.contentCursor, frame.openStart),
                  );
                }
                parent.contentCursor = tagEnd;
              } else {
                tokens.push(token);
              }
            }
            // Stray closing tag with no matching opener: silently ignore
          } else {
            // ── Opening tag ──
            const blockType = parsed.type;

            if (strict && !ALL_BLOCK_TYPES.has(blockType)) {
              throw new Error(
                `Unrecognized GitBook block type: "${blockType}" at line ${lineAt(markerStart, lineStarts)}`,
              );
            }

            if (ALL_BLOCK_TYPES.has(blockType)) {
              stack.push({
                type: blockType,
                attributes: parsed.attributes,
                openStart: markerStart,
                contentStart: tagEnd,
                startLine: lineAt(markerStart, lineStarts),
                children: [],
                contentCursor: tagEnd,
                contentParts: [],
              });
            }
            // Unknown block type in non-strict mode: treated as plain text
          }

          state = State.Text;
        } else {
          // `%` was not followed by `}` -- put it back and continue scanning
          tagBody += '%' + ch;
          state = State.InsideTag;
        }
        break;
    }
  }

  return { output: input, tokens };
}
