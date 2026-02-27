/**
 * HAST -> MDAST -> MDX conversion pipeline for scraped HTML content.
 *
 * When content is obtained via the Playwright scraper (rather than from
 * GitBook Markdown source files), we receive rendered HTML.  This
 * module converts that HTML into Mintlify-compatible MDX by:
 *
 *   1. Parsing HTML into a HAST tree (rehype-parse).
 *   2. Identifying GitBook-specific DOM patterns (hint blocks, tab
 *      containers, embeds) and converting them to Mintlify JSX components.
 *   3. Converting HAST to MDAST (rehype-remark).
 *   4. Serializing MDAST to an MDX string (remark-stringify).
 */

import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkStringify from 'remark-stringify';
import type { Root as HastRoot, Element as HastElement, RootContent, Text as HastText } from 'hast';

/** Union of HAST node types we work with. */
type HastNode = HastRoot | HastElement | HastText | RootContent;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Convert a raw HTML string into a Mintlify-compatible MDX string.
 *
 * @param html - The (cleaned) HTML content to convert.
 * @returns An MDX string ready for frontmatter prepending and file write.
 */
export function convertHtmlToMdx(html: string): string {
  // Step 1: Parse HTML to HAST.
  const hastTree = unified()
    .use(rehypeParse, { fragment: true })
    .parse(html);

  // Step 2: Extract GitBook components and replace with MDX placeholders.
  const { tree: transformedTree, components } = extractComponents(hastTree as HastRoot);

  // Step 3: Convert HAST -> MDAST -> Markdown string.
  const mdast = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkStringify, {
      bullet: '-',
      emphasis: '*',
      strong: '*',
      fence: '`',
      fences: true,
      listItemIndent: 'one',
    })
    .processSync(serializeHastFragment(transformedTree));

  let mdx = String(mdast);

  // Step 4: Replace placeholders with actual MDX component markup.
  mdx = restorePlaceholders(mdx, components);

  // Strip common GitBook UI artifacts that survive HTML → MDX conversion.
  // HTML comments are invalid in MDX — convert or remove them.
  mdx = mdx.replace(/<!--[\s\S]*?-->/g, '');
  // Remove GitBook-style heading anchors: "## [](#slug)Title" → "## Title"
  // Mintlify auto-generates heading IDs from the text.
  mdx = mdx.replace(/^(#{1,6})\s*\[(?:[^\]]*)\]\(#[^)]*\)\s*/gm, '$1 ');
  // "Copy" standalone line from code block copy buttons.
  mdx = mdx.replace(/^Copy\n\n/gm, '');
  // "Last updated/modified ..." lines at the end.
  mdx = mdx.replace(/\n*Last (updated|modified)\b[^\n]*/gi, '');

  // Clean up excessive blank lines.
  mdx = mdx.replace(/\n{3,}/g, '\n\n').trim();

  return mdx;
}

// ── Component extraction ─────────────────────────────────────────────

/**
 * Mapping of GitBook hint CSS classes / data attributes to Mintlify
 * callout component names.
 */
const HINT_CLASS_MAP: Record<string, string> = {
  info: 'Info',
  warning: 'Warning',
  danger: 'Danger',
  success: 'Check',
  tip: 'Tip',
};

interface ExtractedComponent {
  id: string;
  mdx: string;
}

interface ExtractionResult {
  tree: HastRoot;
  components: ExtractedComponent[];
}

/**
 * Walk the HAST tree, identify GitBook-specific patterns, and replace
 * them with placeholder `<div>` nodes.  The actual MDX markup for each
 * component is stored in `components` and reinserted after the HAST ->
 * Markdown conversion.
 */
function extractComponents(tree: HastRoot): ExtractionResult {
  const components: ExtractedComponent[] = [];
  let counter = 0;

  function nextId(): string {
    return `__COMPONENT_${counter++}__`;
  }

  function walk(node: HastNode): HastNode {
    if (node.type !== 'element') return node;

    const el = node as HastElement;

    // --- Hint blocks -------------------------------------------------
    const hintComponent = matchHintBlock(el);
    if (hintComponent) {
      const id = nextId();
      const innerMdx = childrenToMdx(el);
      components.push({ id, mdx: `<${hintComponent}>\n${innerMdx}\n</${hintComponent}>` });
      return makePlaceholder(id);
    }

    // --- Tab containers ----------------------------------------------
    if (matchTabsContainer(el)) {
      const id = nextId();
      const tabsMdx = extractTabsMdx(el);
      components.push({ id, mdx: tabsMdx });
      return makePlaceholder(id);
    }

    // --- Embeds (iframes) --------------------------------------------
    if (el.tagName === 'iframe') {
      const src = getProperty(el, 'src');
      if (src) {
        const id = nextId();
        components.push({ id, mdx: `<Frame src="${escapeAttr(src)}" />` });
        return makePlaceholder(id);
      }
    }

    // --- Expandable / details / accordion ----------------------------
    if (el.tagName === 'details') {
      const id = nextId();
      const summaryEl = findChild(el, 'summary');
      const title = summaryEl ? textContent(summaryEl) : '';
      const bodyEls = (el.children ?? []).filter(
        (c) => c.type !== 'element' || (c as HastElement).tagName !== 'summary',
      );
      const bodyMdx = nodesToMdx(bodyEls);
      components.push({
        id,
        mdx: `<Accordion title="${escapeAttr(title)}">\n${bodyMdx}\n</Accordion>`,
      });
      return makePlaceholder(id);
    }

    // --- Recurse into children ---------------------------------------
    if (el.children) {
      el.children = el.children.map((child) => walk(child)) as any;
    }

    return el;
  }

  const walked = {
    ...tree,
    children: (tree.children ?? []).map((child) => walk(child)),
  } as HastRoot;

  return { tree: walked, components };
}

// ── Pattern matchers ─────────────────────────────────────────────────

/**
 * Check whether an element is a GitBook hint/callout block.
 * Returns the Mintlify component name, or `undefined` if not a match.
 */
function matchHintBlock(el: HastElement): string | undefined {
  const classes = getClasses(el);
  const dataHint = getProperty(el, 'data-hint') ?? getProperty(el, 'dataHint');

  // Match by data attribute.
  if (dataHint && HINT_CLASS_MAP[dataHint]) {
    return HINT_CLASS_MAP[dataHint];
  }

  // Match by class name patterns: "hint", "hint-info", "callout", etc.
  for (const cls of classes) {
    // "hint-info", "hint-warning", etc.
    const hintMatch = cls.match(/^hint-(\w+)$/);
    if (hintMatch && HINT_CLASS_MAP[hintMatch[1]]) {
      return HINT_CLASS_MAP[hintMatch[1]];
    }

    // "gb-hint-info", etc.
    const gbMatch = cls.match(/^gb-hint-(\w+)$/);
    if (gbMatch && HINT_CLASS_MAP[gbMatch[1]]) {
      return HINT_CLASS_MAP[gbMatch[1]];
    }
  }

  // Match by role="alert" or similar semantic hints.
  const role = getProperty(el, 'role');
  if (role === 'alert' && classes.some((c) => c.includes('hint') || c.includes('callout'))) {
    return 'Info';
  }

  return undefined;
}

/**
 * Check whether an element is a GitBook tabs container.
 */
function matchTabsContainer(el: HastElement): boolean {
  const classes = getClasses(el);
  const role = getProperty(el, 'role');

  return (
    classes.some((c) => c === 'tabs' || c.includes('gb-tabs') || c === 'tab-container') ||
    role === 'tablist' ||
    (el.tagName === 'div' && classes.some((c) => c.includes('tabs')))
  );
}

/**
 * Convert a tabs container element into Mintlify `<Tabs>` / `<Tab>` MDX.
 */
function extractTabsMdx(el: HastElement): string {
  const tabs: Array<{ title: string; content: string }> = [];

  // Strategy 1: Look for role="tabpanel" children.
  const panels = findAllByAttr(el, 'role', 'tabpanel');
  const tabButtons = findAllByAttr(el, 'role', 'tab');

  if (panels.length > 0) {
    for (let i = 0; i < panels.length; i++) {
      const title = tabButtons[i] ? textContent(tabButtons[i]) : `Tab ${i + 1}`;
      const content = childrenToMdx(panels[i]);
      tabs.push({ title, content });
    }
  }

  // Strategy 2: Look for child divs with data-tab-title or similar.
  if (tabs.length === 0) {
    const children = (el.children ?? []).filter(
      (c) => c.type === 'element',
    ) as HastElement[];

    for (const child of children) {
      const title =
        getProperty(child, 'data-tab-title') ??
        getProperty(child, 'data-title') ??
        getProperty(child, 'aria-label') ??
        '';
      if (title) {
        const content = childrenToMdx(child);
        tabs.push({ title, content });
      }
    }
  }

  if (tabs.length === 0) {
    // Fallback: render the whole thing as a single tab.
    const content = childrenToMdx(el);
    return content;
  }

  const tabStrings = tabs.map(
    (t) => `<Tab title="${escapeAttr(t.title)}">\n${t.content}\n</Tab>`,
  );

  return `<Tabs>\n${tabStrings.join('\n')}\n</Tabs>`;
}

// ── HAST utility helpers ─────────────────────────────────────────────

/**
 * Get the CSS class list from an element.
 */
function getClasses(el: HastElement): string[] {
  const raw = el.properties?.className;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw).split(/\s+/).filter(Boolean);
}

/**
 * Get a string property from an element (supports both camelCase and
 * kebab-case lookups).
 */
function getProperty(el: HastElement, name: string): string | undefined {
  const props = el.properties ?? {};

  // Try exact name.
  if (name in props) return String(props[name]);

  // Try camelCase version.
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camel in props) return String(props[camel]);

  return undefined;
}

/**
 * Find the first direct child element with a given tag name.
 */
function findChild(el: HastElement, tagName: string): HastElement | undefined {
  return (el.children ?? []).find(
    (c) => c.type === 'element' && (c as HastElement).tagName === tagName,
  ) as HastElement | undefined;
}

/**
 * Recursively find all descendant elements with a given attribute value.
 */
function findAllByAttr(
  root: HastElement,
  attr: string,
  value: string,
): HastElement[] {
  const results: HastElement[] = [];

  function walk(node: HastNode): void {
    if (node.type !== 'element') return;
    const el = node as HastElement;
    if (getProperty(el, attr) === value) {
      results.push(el);
    }
    for (const child of el.children ?? []) {
      walk(child);
    }
  }

  walk(root);
  return results;
}

/**
 * Extract plain text from an element, recursively.
 */
function textContent(node: HastNode): string {
  if (node.type === 'text') return (node as any).value ?? '';
  if (node.type === 'element') {
    return ((node as HastElement).children ?? []).map(textContent).join('');
  }
  return '';
}

/**
 * Create a placeholder `<p>` element with a unique marker text.
 */
function makePlaceholder(id: string): HastElement {
  return {
    type: 'element',
    tagName: 'p',
    properties: {},
    children: [{ type: 'text', value: id }],
  };
}

// ── MDX conversion helpers ───────────────────────────────────────────

/**
 * Convert an element's children to MDX by running them through the
 * unified pipeline.
 */
function childrenToMdx(el: HastElement): string {
  return nodesToMdx(el.children ?? []);
}

/**
 * Convert an array of HAST nodes to an MDX string.
 */
function nodesToMdx(nodes: HastNode[]): string {
  const fragment: HastRoot = {
    type: 'root',
    children: nodes as any,
  };

  const html = serializeHastFragment(fragment);

  const result = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkStringify, {
      bullet: '-',
      emphasis: '*',
      strong: '*',
      fence: '`',
      fences: true,
      listItemIndent: 'one',
    })
    .processSync(html);

  return String(result).trim();
}

// ── Placeholder restoration ──────────────────────────────────────────

/**
 * Replace `__COMPONENT_N__` placeholders in the Markdown output with
 * the actual MDX component strings.
 */
function restorePlaceholders(
  mdx: string,
  components: ExtractedComponent[],
): string {
  let result = mdx;
  for (const { id, mdx: componentMdx } of components) {
    // The placeholder may have been wrapped in paragraph markup or
    // escaped.  Handle common patterns.
    result = result.replace(
      new RegExp(`(?:\\\\)?${escapeRegex(id)}`, 'g'),
      componentMdx,
    );
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Minimal HAST serialization ───────────────────────────────────────

/**
 * Serialize a HAST fragment to an HTML string so it can be re-parsed
 * by the unified pipeline.
 */
function serializeHastFragment(tree: HastRoot): string {
  return tree.children.map(serializeNode).join('');
}

function serializeNode(node: HastNode): string {
  switch (node.type) {
    case 'root':
      return (node as HastRoot).children.map(serializeNode).join('');

    case 'element': {
      const el = node as HastElement;
      const tag = el.tagName;
      const attrs = serializeAttributes(el.properties ?? {});
      const attrStr = attrs ? ` ${attrs}` : '';

      if (VOID_ELEMENTS.has(tag)) {
        return `<${tag}${attrStr}>`;
      }

      const inner = (el.children ?? []).map(serializeNode).join('');
      return `<${tag}${attrStr}>${inner}</${tag}>`;
    }

    case 'text':
      return (node as any).value ?? '';

    case 'comment':
      return `<!--${(node as any).value ?? ''}-->`;

    case 'doctype':
      return '<!DOCTYPE html>';

    default:
      return '';
  }
}

function serializeAttributes(properties: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value === false || value === null || value === undefined) continue;

    const attrName = hastPropToAttr(key);

    if (value === true) {
      parts.push(attrName);
    } else if (Array.isArray(value)) {
      parts.push(`${attrName}="${escapeAttr(value.join(' '))}"`);
    } else {
      parts.push(`${attrName}="${escapeAttr(String(value))}"`);
    }
  }
  return parts.join(' ');
}

function hastPropToAttr(prop: string): string {
  const special: Record<string, string> = {
    className: 'class',
    htmlFor: 'for',
    httpEquiv: 'http-equiv',
    acceptCharset: 'accept-charset',
  };
  if (special[prop]) return special[prop];

  if (prop.startsWith('data') || prop.startsWith('aria')) {
    return prop.replace(/([A-Z])/g, '-$1').toLowerCase();
  }

  return prop.toLowerCase();
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
