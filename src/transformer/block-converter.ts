/**
 * Convert GitBook block tokens into Mintlify MDX components.
 *
 * Each GitBook custom block (hints, tabs, code-tabs, swagger, etc.) is
 * mapped to the corresponding Mintlify component.  Nested blocks are
 * handled recursively so that, e.g., a hint inside a tab inside a tabs
 * block is converted correctly.
 */

import type { BlockToken } from '../types.js';

// ── Public API ───────────────────────────────────────────────────────

/**
 * Convert a single `BlockToken` (and any nested children) into its
 * Mintlify MDX string representation.
 */
export function convertBlock(token: BlockToken): string {
  const handler = BLOCK_HANDLERS[token.type];
  if (handler) {
    return handler(token);
  }

  // Unknown block -- return the raw content as-is so nothing is lost.
  return token.raw;
}

/**
 * Convert an array of block tokens, joining them with blank lines.
 */
export function convertBlocks(tokens: BlockToken[]): string {
  return tokens.map((t) => convertBlock(t)).join('\n\n');
}

// ── Block handler registry ───────────────────────────────────────────

type BlockHandler = (token: BlockToken) => string;

const BLOCK_HANDLERS: Record<string, BlockHandler> = {
  hint: handleHint,
  tabs: handleTabs,
  stepper: handleStepper,
  details: handleDetails,
  embed: handleEmbed,
  'content-ref': handleContentRef,
  code: handleCode,
  file: handleFile,
  swagger: handleSwagger,
  'api-method': handleSwagger, // legacy alias
  'code-tabs': handleCodeTabs,
};

// ── Hint ─────────────────────────────────────────────────────────────

const HINT_STYLE_MAP: Record<string, string> = {
  info: 'Info',
  warning: 'Warning',
  danger: 'Danger',
  success: 'Check',
};

function handleHint(token: BlockToken): string {
  const style = token.attributes['style'] || 'info';
  const tag = HINT_STYLE_MAP[style] || 'Info';
  const body = convertChildrenOrContent(token);
  return `<${tag}>\n${body}\n</${tag}>`;
}

// ── Tabs ─────────────────────────────────────────────────────────────

function handleTabs(token: BlockToken): string {
  const tabs = token.children
    .filter((child) => child.type === 'tab')
    .map((child) => {
      const title = child.attributes['title'] || '';
      const body = convertChildrenOrContent(child);
      return `<Tab title="${escapeAttr(title)}">\n${body}\n</Tab>`;
    })
    .join('\n');

  return `<Tabs>\n${tabs}\n</Tabs>`;
}

// ── Stepper / Steps ──────────────────────────────────────────────────

function handleStepper(token: BlockToken): string {
  const steps = token.children
    .filter((child) => child.type === 'step')
    .map((child) => {
      const title = child.attributes['title'] || '';
      const body = convertChildrenOrContent(child);
      return `<Step title="${escapeAttr(title)}">\n${body}\n</Step>`;
    })
    .join('\n');

  return `<Steps>\n${steps}\n</Steps>`;
}

// ── Details / Accordion ──────────────────────────────────────────────

function handleDetails(token: BlockToken): string {
  const title = token.attributes['title'] || token.attributes['summary'] || '';
  const body = convertChildrenOrContent(token);
  return `<Accordion title="${escapeAttr(title)}">\n${body}\n</Accordion>`;
}

// ── Embed ────────────────────────────────────────────────────────────

function handleEmbed(token: BlockToken): string {
  const url = token.attributes['url'] || '';
  const caption = token.attributes['caption'] || token.content.trim();
  let result = `<Frame src="${escapeAttr(url)}" />`;
  if (caption) {
    result += `\n\n${caption}`;
  }
  return result;
}

// ── Content-ref ──────────────────────────────────────────────────────

function handleContentRef(token: BlockToken): string {
  const href = token.attributes['href'] || token.attributes['url'] || '';
  const title = token.attributes['title'] || token.content.trim() || href;
  const description = token.attributes['description'] || '';
  const body = description || token.content.trim();
  return `<Card title="${escapeAttr(title)}" href="${escapeAttr(href)}">\n${body}\n</Card>`;
}

// ── Code ─────────────────────────────────────────────────────────────

function handleCode(token: BlockToken): string {
  const lang = token.attributes['lang'] || token.attributes['language'] || '';
  const title = token.attributes['title'] || '';
  // Deliberately drop lineNumbers attribute per spec.

  const fence = '```';
  const meta = [lang, title ? `title="${title}"` : ''].filter(Boolean).join(' ');
  const body = token.content;
  return `${fence}${meta}\n${body}\n${fence}`;
}

// ── File ─────────────────────────────────────────────────────────────

function handleFile(token: BlockToken): string {
  const src = token.attributes['src'] || token.attributes['path'] || '';
  const caption = token.attributes['caption'] || token.content.trim() || src;

  // If the path looks like a downloadable file, use a Card with download icon.
  if (src) {
    return `<Card title="${escapeAttr(caption)}" icon="download" href="${escapeAttr(src)}">\n${caption}\n</Card>`;
  }

  // Fallback: simple link
  return `[${caption}](${src})`;
}

// ── Swagger / API-method ─────────────────────────────────────────────

/**
 * When there is no external OpenAPI spec reference, parse swagger
 * sub-blocks into static Mintlify MDX with `<ParamField>` and
 * `<ResponseField>` components.
 */
function handleSwagger(token: BlockToken): string {
  const method = (token.attributes['method'] || 'GET').toUpperCase();
  const path = token.attributes['path'] || '';
  const summary = token.attributes['summary'] || token.attributes['description'] || '';

  const parts: string[] = [];

  // Title area
  if (summary) {
    parts.push(summary);
    parts.push('');
  }

  if (method && path) {
    parts.push(`\`${method} ${path}\``);
    parts.push('');
  }

  // Group children by type
  const paramChildren = token.children.filter(
    (c) => c.type === 'swagger-parameter' || c.type === 'api-method-parameter',
  );
  const responseChildren = token.children.filter(
    (c) => c.type === 'swagger-response' || c.type === 'api-method-response',
  );
  const descriptionChildren = token.children.filter(
    (c) => c.type === 'swagger-description' || c.type === 'api-method-description',
  );

  // Description
  for (const desc of descriptionChildren) {
    const body = convertChildrenOrContent(desc);
    if (body.trim()) {
      parts.push(body.trim());
      parts.push('');
    }
  }

  // Parameters
  if (paramChildren.length > 0) {
    parts.push('## Parameters');
    parts.push('');
    for (const param of paramChildren) {
      parts.push(convertSwaggerParameter(param));
    }
    parts.push('');
  }

  // Responses
  if (responseChildren.length > 0) {
    parts.push('## Responses');
    parts.push('');
    for (const resp of responseChildren) {
      parts.push(convertSwaggerResponse(resp));
    }
  }

  // Any remaining children rendered generically
  const handledTypes = new Set([
    'swagger-parameter', 'api-method-parameter',
    'swagger-response', 'api-method-response',
    'swagger-description', 'api-method-description',
  ]);
  const remaining = token.children.filter((c) => !handledTypes.has(c.type));
  if (remaining.length > 0) {
    parts.push(convertBlocks(remaining));
  }

  return parts.join('\n');
}

/**
 * Convert a swagger-parameter block into a `<ParamField>` component.
 *
 * The `in` attribute maps to the Mintlify prop name:
 *   in="path"   -> `<ParamField path="name" ...>`
 *   in="query"  -> `<ParamField query="name" ...>`
 *   in="header" -> `<ParamField header="name" ...>`
 *   in="body"   -> `<ParamField body="name" ...>`
 *   in="cookie" -> `<ParamField cookie="name" ...>`
 */
function convertSwaggerParameter(token: BlockToken): string {
  const name = token.attributes['name'] || 'param';
  const location = token.attributes['in'] || 'query';
  const type = token.attributes['type'] || '';
  const required = token.attributes['required'] === 'true';
  const description = token.content.trim() || token.attributes['description'] || '';

  const props: string[] = [`${location}="${escapeAttr(name)}"`];
  if (type) props.push(`type="${escapeAttr(type)}"`);
  if (required) props.push('required');

  const body = description || '';
  return `<ParamField ${props.join(' ')}>\n${body}\n</ParamField>`;
}

/**
 * Convert a swagger-response block into a `<ResponseField>` or a
 * descriptive section.
 */
function convertSwaggerResponse(token: BlockToken): string {
  const status = token.attributes['status'] || token.attributes['code'] || '200';
  const description = token.attributes['description'] || token.content.trim() || '';
  const body = convertChildrenOrContent(token);

  const parts: string[] = [];
  parts.push(`### ${status}`);
  if (description) {
    parts.push('');
    parts.push(description);
  }
  if (body.trim() && body.trim() !== description.trim()) {
    parts.push('');
    parts.push(body.trim());
  }
  return parts.join('\n');
}

// ── Code-tabs (legacy) ───────────────────────────────────────────────

function handleCodeTabs(token: BlockToken): string {
  const items = token.children
    .filter((child) => child.type === 'code-tabs-item' || child.type === 'code')
    .map((child) => {
      const lang = child.attributes['lang'] || child.attributes['language'] || '';
      const title = child.attributes['title'] || '';
      const meta = [lang, title ? `title="${title}"` : ''].filter(Boolean).join(' ');
      return `\`\`\`${meta}\n${child.content}\n\`\`\``;
    })
    .join('\n');

  return `<CodeGroup>\n${items}\n</CodeGroup>`;
}

// ── Shared helpers ───────────────────────────────────────────────────

/**
 * If a token has children, recursively convert them; otherwise return
 * the token's direct content.
 */
function convertChildrenOrContent(token: BlockToken): string {
  if (token.children.length > 0) {
    return convertBlocks(token.children);
  }
  return token.content;
}

/**
 * Escape double-quote characters for use inside an HTML/JSX attribute value.
 */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}
