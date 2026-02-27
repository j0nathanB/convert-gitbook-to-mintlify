/**
 * API Document → Mintlify MDX converter.
 *
 * When the GitBook Content API is available, it returns rich structured
 * blocks (tabs, hints, embeds, code, cards, etc.) that the HTML scraper
 * cannot reliably detect.  This module converts those API document nodes
 * directly into Mintlify-compatible MDX strings — the primary rendering
 * path when API access is available.
 */

import type { GitBookDocumentNode, GitBookDocumentLeaf } from '../types.js';

// ── Public API ───────────────────────────────────────────────────────

export interface ColumnsBlockInfo {
  columnCount: number;
  contentSummary: string[];  // e.g. ["heading + paragraph + buttons", "code block"]
}

/**
 * Convert a GitBook API document (array of block nodes) into a
 * Mintlify-compatible MDX string.
 *
 * @param nodes - The `document.nodes` array from the page content API.
 * @param pageIdToPath - Map from GitBook page ID → output path (for
 *   resolving `content-ref` and `button` links to other pages).
 * @param opts - Optional maps for resolving file IDs and space IDs.
 * @returns Object with `mdx` body string and `columnsBlocks` info.
 */
export function apiDocumentToMdx(
  nodes: GitBookDocumentNode[],
  pageIdToPath: Map<string, string>,
  opts?: {
    fileIdToUrl?: Map<string, string>;
    spaceIdToPath?: Map<string, string>;
    columnsMode?: 'stacked' | 'cards' | 'skip';
  },
): { mdx: string; columnsBlocks: ColumnsBlockInfo[] } {
  const ctx: RenderContext = {
    pageIdToPath,
    fileIdToUrl: opts?.fileIdToUrl ?? new Map(),
    spaceIdToPath: opts?.spaceIdToPath ?? new Map(),
    columnsBlocks: [],
    columnsMode: opts?.columnsMode ?? 'stacked',
  };
  const lines = nodes.map((n) => renderNode(n, ctx)).filter(Boolean);
  const mdx = lines.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { mdx, columnsBlocks: ctx.columnsBlocks };
}

// ── Render context ───────────────────────────────────────────────────

interface RenderContext {
  pageIdToPath: Map<string, string>;
  fileIdToUrl: Map<string, string>;
  spaceIdToPath: Map<string, string>;
  columnsBlocks: ColumnsBlockInfo[];
  columnsMode: 'stacked' | 'cards' | 'skip';
}

// ── Node renderer ────────────────────────────────────────────────────

function renderNode(node: GitBookDocumentNode, ctx: RenderContext): string {
  switch (node.type) {
    case 'heading-1':
      return `# ${renderInlineChildren(node, ctx)}`;
    case 'heading-2':
      return `## ${renderInlineChildren(node, ctx)}`;
    case 'heading-3':
      return `### ${renderInlineChildren(node, ctx)}`;

    case 'paragraph':
      return renderInlineChildren(node, ctx);

    case 'hint':
      return renderHint(node, ctx);

    case 'tabs':
      return renderTabs(node, ctx);

    case 'expandable':
      return renderExpandable(node, ctx);

    case 'embed':
      return renderEmbed(node);

    case 'code':
      return renderCodeBlock(node);

    case 'blockquote':
      return renderBlockquote(node, ctx);

    case 'columns':
      return renderColumns(node, ctx);

    case 'column':
      return renderChildren(node, ctx);

    case 'table':
      return renderTable(node, ctx);

    case 'button':
      return renderButton(node, ctx);

    case 'content-ref':
      return renderContentRef(node, ctx);

    case 'images':
    case 'image':
      return renderImage(node);

    case 'list-ordered':
      return renderOrderedList(node, ctx);

    case 'list-unordered':
      return renderUnorderedList(node, ctx);

    case 'list-item':
      return renderChildren(node, ctx);

    case 'divider':
      return '---';

    case 'link':
      return renderLink(node, ctx);

    // Changelog updates
    case 'updates':
      return renderUpdates(node, ctx);

    case 'update':
      return renderUpdate(node, ctx);

    // Swagger / OpenAPI embed
    case 'swagger':
      return renderSwagger(node);

    // File attachments
    case 'file':
      return renderFile(node);

    default:
      // Unknown block — render children if any, otherwise empty.
      if (node.nodes && node.nodes.length > 0) {
        return renderChildren(node, ctx);
      }
      return '';
  }
}

// ── Block renderers ──────────────────────────────────────────────────

function renderHint(node: GitBookDocumentNode, ctx: RenderContext): string {
  const style = node.data?.style ?? 'info';
  const componentMap: Record<string, string> = {
    info: 'Info',
    warning: 'Warning',
    danger: 'Danger',
    success: 'Check',
    tip: 'Tip',
  };
  const comp = componentMap[style] ?? 'Info';
  const inner = renderChildren(node, ctx);
  return `<${comp}>\n${inner}\n</${comp}>`;
}

function renderTabs(node: GitBookDocumentNode, ctx: RenderContext): string {
  const items = (node.nodes ?? []).filter((n) => n.type === 'tabs-item');
  if (items.length === 0) return renderChildren(node, ctx);

  const tabStrings = items.map((item) => {
    const title = escapeAttr(item.data?.title ?? 'Tab');
    const content = renderChildren(item, ctx);
    return `<Tab title="${title}">\n${content}\n</Tab>`;
  });

  return `<Tabs>\n${tabStrings.join('\n')}\n</Tabs>`;
}

function renderExpandable(node: GitBookDocumentNode, ctx: RenderContext): string {
  // Expandable blocks store title and body in fragments, not in data/nodes.
  const titleFragment = (node.fragments ?? []).find(
    (f) => f.type === 'expandable-title',
  );
  const bodyFragment = (node.fragments ?? []).find(
    (f) => f.type === 'expandable-body',
  );

  const title = titleFragment
    ? escapeAttr(extractPlainText(titleFragment))
    : escapeAttr(node.data?.title ?? '');

  const inner = bodyFragment
    ? renderChildren(bodyFragment, ctx)
    : renderChildren(node, ctx);

  return `<Accordion title="${title}">\n${inner}\n</Accordion>`;
}

function renderEmbed(node: GitBookDocumentNode): string {
  const url = node.data?.url;
  if (!url) return '';

  // YouTube: convert watch URLs to embed format and use an iframe.
  const ytMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/,
  );
  if (ytMatch) {
    const videoId = ytMatch[1];
    return `<iframe className="w-full aspect-video rounded-xl" src="https://www.youtube.com/embed/${videoId}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen></iframe>`;
  }

  // Generic embed — use an iframe so content actually renders.
  return `<iframe className="w-full aspect-video rounded-xl" src="${escapeAttr(url)}" allowFullScreen></iframe>`;
}

function renderCodeBlock(node: GitBookDocumentNode): string {
  const syntax = node.data?.syntax ?? '';
  const title = node.data?.title;
  // Code blocks store their text content in leaves of child nodes.
  const code = extractPlainText(node);

  let fence = '```' + syntax;
  if (title) {
    fence += ` ${title}`;
  }

  return `${fence}\n${code}\n\`\`\``;
}

function renderBlockquote(node: GitBookDocumentNode, ctx: RenderContext): string {
  const inner = renderChildren(node, ctx);
  return inner
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function renderColumns(node: GitBookDocumentNode, ctx: RenderContext): string {
  const columns = (node.nodes ?? []).filter((n) => n.type === 'column');

  // Build content summary for each column.
  const contentSummary = columns.map((col) => summarizeColumnContent(col));
  ctx.columnsBlocks.push({
    columnCount: columns.length,
    contentSummary,
  });

  switch (ctx.columnsMode) {
    case 'skip':
      return '';

    case 'cards': {
      const cards = columns
        .map((col) => {
          const inner = renderChildren(col, ctx);
          if (!inner) return '';
          return `<Card>\n${inner}\n</Card>`;
        })
        .filter(Boolean);
      if (cards.length === 0) return '';
      return `<CardGroup cols={${columns.length}}>\n${cards.join('\n')}\n</CardGroup>`;
    }

    case 'stacked':
    default:
      // Render columns sequentially (original behavior).
      return columns
        .map((col) => renderNode(col, ctx))
        .filter(Boolean)
        .join('\n\n');
  }
}

/**
 * Summarize the top-level child node types in a column for the QA report.
 */
function summarizeColumnContent(col: GitBookDocumentNode): string {
  const labels = (col.nodes ?? []).map((child) => {
    switch (child.type) {
      case 'heading-1':
      case 'heading-2':
      case 'heading-3':
        return 'heading';
      case 'paragraph':
        return 'paragraph';
      case 'code':
        return 'code block';
      case 'images':
      case 'image':
        return 'image';
      case 'hint':
        return 'hint';
      case 'tabs':
        return 'tabs';
      case 'table':
        return 'table';
      case 'list-ordered':
      case 'list-unordered':
        return 'list';
      case 'blockquote':
        return 'blockquote';
      case 'button':
        return 'button';
      case 'content-ref':
        return 'content-ref';
      case 'embed':
        return 'embed';
      case 'expandable':
        return 'expandable';
      case 'divider':
        return 'divider';
      case 'swagger':
        return 'API reference';
      case 'file':
        return 'file';
      default:
        return child.type ?? 'unknown';
    }
  });
  return labels.join(' + ') || 'empty';
}

function renderUpdates(node: GitBookDocumentNode, ctx: RenderContext): string {
  const updates = (node.nodes ?? []).filter((n) => n.type === 'update');
  return updates.map((u) => renderUpdate(u, ctx)).filter(Boolean).join('\n\n');
}

function renderUpdate(node: GitBookDocumentNode, ctx: RenderContext): string {
  const date = node.data?.date ?? '';
  const inner = renderChildren(node, ctx);
  if (!inner) return '';
  return `<Update label="${escapeAttr(date)}">\n${inner}\n</Update>`;
}

function renderTable(node: GitBookDocumentNode, ctx: RenderContext): string {
  const viewType = node.data?.view?.type;

  if (viewType === 'cards') {
    return renderCardTable(node, ctx);
  }

  return renderMarkdownTable(node, ctx);
}

function renderCardTable(node: GitBookDocumentNode, ctx: RenderContext): string {
  const definitionMap = node.data?.definition ?? {};
  const recordsMap = node.data?.records ?? {};
  const view = node.data?.view ?? {};

  // Build a fragment lookup from the table node's fragments array.
  // Fragments are referenced by their `key` property from record text values.
  // However, keys may be regenerated between API calls, so we also build
  // a positional index as fallback.
  const fragmentByKey = new Map<string, any>();
  const fragmentList: any[] = [];
  if (Array.isArray(node.fragments)) {
    for (const frag of node.fragments as any[]) {
      fragmentList.push(frag);
      if (frag.key) fragmentByKey.set(frag.key, frag);
      if (frag.fragment && frag.fragment !== frag.key) {
        fragmentByKey.set(frag.fragment, frag);
      }
    }
  }

  const records = Object.values<any>(recordsMap);
  records.sort((a: any, b: any) => (a.orderIndex ?? '').localeCompare(b.orderIndex ?? ''));

  const displayColumns = view.columns ?? Object.keys(definitionMap);
  const targetDefId = view.targetDefinition;
  const coverDefId = view.coverDefinition;

  // Collect all text column IDs across all columns (not just display)
  // to build a positional fragment mapping.
  const allTextColIds = Object.entries(definitionMap)
    .filter(([_, def]: [string, any]) => def.type === 'text')
    .map(([id]) => id);

  // Build positional map: for each record, text columns map to
  // sequential fragments.
  const positionalFragments = new Map<string, any>();
  let fragIdx = 0;
  for (const record of records) {
    for (const colId of allTextColIds) {
      const val = record.values?.[colId];
      if (typeof val === 'string' && fragIdx < fragmentList.length) {
        positionalFragments.set(val, fragmentList[fragIdx]);
        fragIdx++;
      }
    }
  }

  const cols = Math.min(records.length, 3) || 2;
  const cards: string[] = [];

  for (const record of records) {
    const values = record.values ?? {};
    let title = '';
    let description = '';
    let href = '';
    let coverImage = '';

    // Extract href from the target definition column.
    if (targetDefId && values[targetDefId]) {
      const targetVal = values[targetDefId];
      if (typeof targetVal === 'object' && targetVal !== null) {
        if (targetVal.url) {
          href = targetVal.url;
        } else if (targetVal.kind === 'page' && targetVal.page) {
          href = ctx.pageIdToPath.get(targetVal.page) ?? '';
          if (href && !href.startsWith('/')) href = '/' + href;
        } else if (targetVal.kind === 'space' && targetVal.space) {
          href = ctx.spaceIdToPath.get(targetVal.space) ?? '';
          if (href && !href.startsWith('/')) href = '/' + href;
        }
      }
    }

    // Extract cover image from the cover definition column.
    // Values can be file objects with downloadURL, or bare file ID strings.
    if (coverDefId && values[coverDefId]) {
      const coverVal = values[coverDefId];
      const files = Array.isArray(coverVal) ? coverVal : [coverVal];
      for (const file of files) {
        if (typeof file === 'object' && file?.downloadURL) {
          coverImage = file.downloadURL;
          break;
        } else if (typeof file === 'string') {
          // Bare file ID — resolve through the file map.
          const url = ctx.fileIdToUrl.get(file);
          if (url) {
            coverImage = url;
            break;
          }
        }
      }
    }

    // Extract title and description from display columns.
    for (const colId of displayColumns) {
      const def = definitionMap[colId];
      if (!def) continue;
      const val = values[colId];
      if (!val) continue;

      if (def.type === 'text') {
        const text = resolveFragmentText(val, fragmentByKey, positionalFragments);
        if (!title) title = text;
        else if (!description) description = text;
      }
    }

    if (title || href) {
      let cardAttrs = `title="${escapeAttr(title || 'Card')}"`;
      if (href) cardAttrs += ` href="${escapeAttr(href)}"`;
      if (coverImage) cardAttrs += ` img="${escapeAttr(coverImage)}"`;

      cards.push(description
        ? `<Card ${cardAttrs}>\n${description}\n</Card>`
        : `<Card ${cardAttrs} />`);
    }
  }

  if (cards.length === 0) return '';
  return `<CardGroup cols={${cols}}>\n${cards.join('\n')}\n</CardGroup>`;
}

/**
 * Resolve a text value from a card table record.
 *
 * Text column values in GitBook's API are opaque fragment references
 * (strings) that reference items in the table node's `fragments` array.
 * We try keyed lookup first, then positional fallback.
 */
function resolveFragmentText(
  value: any,
  fragmentByKey: Map<string, any>,
  positionalFragments: Map<string, any>,
): string {
  if (typeof value !== 'string') {
    return extractTextFromFragments(value);
  }

  // Try keyed lookup.
  let fragment = fragmentByKey.get(value);
  if (!fragment) {
    // Try positional lookup.
    fragment = positionalFragments.get(value);
  }

  if (!fragment) return ''; // Unknown fragment — omit rather than show ID.

  // Extract text from the fragment's nodes.
  if (fragment.nodes) {
    return fragment.nodes
      .map((n: any) => extractPlainText(n))
      .join('')
      .trim();
  }

  return '';
}

function renderMarkdownTable(node: GitBookDocumentNode, ctx: RenderContext): string {
  // Regular tables may use child nodes (table-row/table-cell) or
  // may use the same records/definition structure as card tables.
  const rows = (node.nodes ?? []).filter((n) => n.type === 'table-row');

  if (rows.length > 0) {
    const table: string[][] = [];
    for (const row of rows) {
      const cells = (row.nodes ?? []).filter(
        (n) => n.type === 'table-cell' || n.type === 'table-header',
      );
      table.push(cells.map((cell) => renderInlineChildren(cell, ctx).replace(/\|/g, '\\|')));
    }

    if (table.length === 0) return '';

    const header = table[0];
    const separator = header.map(() => '---');
    const bodyRows = table.slice(1);

    const lines = [
      '| ' + header.join(' | ') + ' |',
      '| ' + separator.join(' | ') + ' |',
      ...bodyRows.map((row) => '| ' + row.join(' | ') + ' |'),
    ];

    return lines.join('\n');
  }

  // Record-based table: render as a markdown table using definitions and records.
  const definitionMap = node.data?.definition ?? {};
  const recordsMap = node.data?.records ?? {};
  const view = node.data?.view ?? {};

  const fragmentByKey = new Map<string, any>();
  const fragmentList: any[] = [];
  if (Array.isArray(node.fragments)) {
    for (const frag of node.fragments as any[]) {
      fragmentList.push(frag);
      if (frag.key) fragmentByKey.set(frag.key, frag);
    }
  }

  const displayColumns = view.columns ?? Object.keys(definitionMap);
  const records = Object.values<any>(recordsMap);
  records.sort((a: any, b: any) => (a.orderIndex ?? '').localeCompare(b.orderIndex ?? ''));

  // Build positional fragment map.
  const allTextColIds = Object.entries(definitionMap)
    .filter(([_, def]: [string, any]) => def.type === 'text')
    .map(([id]) => id);
  const positionalFragments = new Map<string, any>();
  let fragIdx = 0;
  for (const record of records) {
    for (const colId of allTextColIds) {
      const val = record.values?.[colId];
      if (typeof val === 'string' && fragIdx < fragmentList.length) {
        positionalFragments.set(val, fragmentList[fragIdx]);
        fragIdx++;
      }
    }
  }

  if (displayColumns.length === 0 || records.length === 0) return '';

  const header = displayColumns.map((colId: string) => {
    const def = definitionMap[colId];
    return def?.title || '';
  });

  const separator = header.map(() => '---');
  const bodyRows = records.map((record: any) => {
    return displayColumns.map((colId: string) => {
      const val = record.values?.[colId];
      if (!val) return '';
      if (typeof val === 'string') {
        return resolveFragmentText(val, fragmentByKey, positionalFragments).replace(/\|/g, '\\|');
      }
      if (typeof val === 'object' && val !== null && val.url) {
        return val.url.replace(/\|/g, '\\|');
      }
      return String(val).replace(/\|/g, '\\|');
    });
  });

  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + separator.join(' | ') + ' |',
    ...bodyRows.map((row: string[]) => '| ' + row.join(' | ') + ' |'),
  ];

  return lines.join('\n');
}

function renderButton(node: GitBookDocumentNode, ctx: RenderContext): string {
  const label = node.data?.label ?? extractPlainText(node) ?? 'Link';
  const ref = node.data?.ref;

  let url = '';
  if (ref) {
    if (ref.kind === 'url') {
      url = ref.url ?? '';
    } else if (ref.kind === 'page' && ref.page) {
      url = ctx.pageIdToPath.get(ref.page) ?? '';
      if (url && !url.startsWith('/')) url = '/' + url;
    }
  }

  if (!url) return label;
  return `[${label}](${url})`;
}

function renderContentRef(node: GitBookDocumentNode, ctx: RenderContext): string {
  const ref = node.data?.ref;
  if (!ref) return '';

  let href = '';
  let title = '';

  if (ref.kind === 'url') {
    href = ref.url ?? '';
    title = ref.title ?? href;
  } else if (ref.kind === 'page' && ref.page) {
    const path = ctx.pageIdToPath.get(ref.page);
    href = path ? (path.startsWith('/') ? path : '/' + path) : '';
    title = ref.title ?? path ?? 'Page';
  }

  if (!href) return '';
  return `<Card title="${escapeAttr(title)}" href="${escapeAttr(href)}" />`;
}

function renderImage(node: GitBookDocumentNode): string {
  // `images` block wraps one or more `image` children.
  if (node.type === 'images') {
    return (node.nodes ?? []).map(renderImage).filter(Boolean).join('\n\n');
  }

  const src = node.data?.ref?.file?.downloadURL
    ?? node.data?.ref?.url
    ?? node.data?.src
    ?? '';
  const alt = node.data?.alt ?? node.data?.caption ?? '';

  if (!src) return '';
  return `![${alt}](${src})`;
}

function renderOrderedList(node: GitBookDocumentNode, ctx: RenderContext): string {
  return (node.nodes ?? [])
    .map((item, i) => {
      const content = renderChildren(item, ctx);
      const lines = content.split('\n');
      const first = `${i + 1}. ${lines[0]}`;
      const rest = lines.slice(1).map((l) => `   ${l}`);
      return [first, ...rest].join('\n');
    })
    .join('\n');
}

function renderUnorderedList(node: GitBookDocumentNode, ctx: RenderContext): string {
  return (node.nodes ?? [])
    .map((item) => {
      const content = renderChildren(item, ctx);
      const lines = content.split('\n');
      const first = `- ${lines[0]}`;
      const rest = lines.slice(1).map((l) => `  ${l}`);
      return [first, ...rest].join('\n');
    })
    .join('\n');
}

function renderLink(node: GitBookDocumentNode, ctx: RenderContext): string {
  const url = node.data?.ref?.url ?? node.data?.href ?? '';
  const text = renderInlineChildren(node, ctx) || url;
  if (!url) return text;
  return `[${text}](${url})`;
}

function renderSwagger(node: GitBookDocumentNode): string {
  const url = node.data?.url;
  if (!url) return '';
  return `<Frame src="${escapeAttr(url)}" />`;
}

function renderFile(node: GitBookDocumentNode): string {
  const file = node.data?.ref?.file;
  if (!file) return '';
  const name = file.name ?? 'Download';
  const url = file.downloadURL ?? '';
  if (!url) return name;
  return `[${name}](${url})`;
}

// ── Inline text rendering ────────────────────────────────────────────

/**
 * Render inline children of a node (paragraphs, headings, etc.).
 * Handles both the `leaves` pattern (text runs with marks) and
 * nested inline nodes like `link`.
 */
function renderInlineChildren(node: GitBookDocumentNode, ctx: RenderContext): string {
  // Some nodes use `leaves` directly for inline text.
  if (node.leaves && node.leaves.length > 0) {
    return node.leaves.map(renderLeaf).join('');
  }

  // Otherwise walk child nodes.
  if (!node.nodes || node.nodes.length === 0) return '';

  return node.nodes
    .map((child) => {
      // Inline text node with leaves.
      if (child.type === 'text' && child.leaves) {
        return child.leaves.map(renderLeaf).join('');
      }

      // Inline link.
      if (child.type === 'link') {
        return renderLink(child, ctx);
      }

      // Inline image.
      if (child.type === 'image' || child.type === 'images') {
        return renderImage(child);
      }

      // Inline code or other inline blocks — try leaves, then recurse.
      if (child.leaves && child.leaves.length > 0) {
        return child.leaves.map(renderLeaf).join('');
      }

      return renderInlineChildren(child, ctx);
    })
    .join('');
}

/**
 * Render a single text leaf, applying any marks (bold, italic, etc.).
 */
function renderLeaf(leaf: GitBookDocumentLeaf): string {
  let text = leaf.text;
  if (!leaf.marks || leaf.marks.length === 0) return text;

  for (const mark of leaf.marks) {
    switch (mark.type) {
      case 'bold':
        text = `**${text}**`;
        break;
      case 'italic':
        text = `*${text}*`;
        break;
      case 'code':
        text = `\`${text}\``;
        break;
      case 'strikethrough':
        text = `~~${text}~~`;
        break;
    }
  }

  return text;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Render all child nodes of a block, joining with double newlines.
 */
function renderChildren(node: GitBookDocumentNode, ctx: RenderContext): string {
  if (!node.nodes || node.nodes.length === 0) return '';
  return node.nodes
    .map((child) => renderNode(child, ctx))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Extract plain text from a node tree (for code blocks, etc.).
 */
function extractPlainText(node: GitBookDocumentNode): string {
  if (node.leaves) {
    return node.leaves.map((l) => l.text).join('');
  }
  if (!node.nodes) return '';
  return node.nodes.map(extractPlainText).join('');
}

/**
 * Extract text from GitBook's fragment-based value format (used in
 * card table records).
 */
function extractTextFromFragments(val: any): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    return val.map(extractTextFromFragments).join('');
  }
  if (val?.nodes) {
    return val.nodes.map((n: any) => extractPlainText(n)).join('');
  }
  if (val?.text) return val.text;
  return '';
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
