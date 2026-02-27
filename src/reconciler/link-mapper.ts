import type { ImageAsset, NavGroup, NavPage, NavTab } from '../types.js';

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Build a mapping from old GitBook paths to new Mintlify paths.
 *
 * The map keys are the original GitBook-style paths (e.g. `guides/setup.md`,
 * `guides/setup.md#configuration`) and the values are the corresponding
 * Mintlify slugs (e.g. `/docs/guides/setup`, `/docs/guides/setup#configuration`).
 *
 * @param tabs         The reconciled navigation tabs.
 * @param sectionPaths A map from source directory name to the Mintlify
 *                     section path prefix (e.g. `"api-reference" → "api-reference"`).
 */
export function buildLinkMap(
  tabs: NavTab[],
  sectionPaths: Map<string, string>,
): Map<string, string> {
  const linkMap = new Map<string, string>();

  for (const tab of tabs) {
    const sectionPrefix = sectionPaths.get(tab.slug) ?? tab.slug;

    for (const group of tab.groups) {
      collectPageMappings(group, sectionPrefix, linkMap);
    }
  }

  return linkMap;
}

/**
 * Build a mapping from old image paths (`.gitbook/assets/...`) to their
 * new locations under Mintlify's `/images/` directory.
 */
export function buildImageMap(assets: ImageAsset[]): Map<string, string> {
  const imageMap = new Map<string, string>();

  for (const asset of assets) {
    if (asset.targetPath) {
      imageMap.set(asset.sourcePath, asset.targetPath);

      // Also map common alternative representations of the same source
      // path so link rewriting catches all variants.
      const withoutLeadingSlash = asset.sourcePath.replace(/^\/+/, '');
      const withLeadingSlash = '/' + withoutLeadingSlash;

      if (!imageMap.has(withoutLeadingSlash)) {
        imageMap.set(withoutLeadingSlash, asset.targetPath);
      }
      if (!imageMap.has(withLeadingSlash)) {
        imageMap.set(withLeadingSlash, asset.targetPath);
      }

      // URL-encoded variant (spaces → %20).
      const encoded = asset.sourcePath.replace(/ /g, '%20');
      if (encoded !== asset.sourcePath && !imageMap.has(encoded)) {
        imageMap.set(encoded, asset.targetPath);
      }
    }
  }

  return imageMap;
}

// ─── Internal helpers ──────────────────────────────────────────────────

/**
 * Recursively walk a nav group, recording path mappings for every page.
 */
function collectPageMappings(
  group: NavGroup,
  sectionPrefix: string,
  linkMap: Map<string, string>,
): void {
  for (const page of group.pages) {
    addPageMappings(page, sectionPrefix, linkMap);
  }

  if (group.groups) {
    for (const sub of group.groups) {
      collectPageMappings(sub, sectionPrefix, linkMap);
    }
  }
}

/**
 * For a single page, compute and record all old→new path variants.
 */
function addPageMappings(
  page: NavPage,
  sectionPrefix: string,
  linkMap: Map<string, string>,
): void {
  const outputPath = page.outputPath ?? page.path;
  const newPath = buildNewPath(outputPath, sectionPrefix);

  // Original path as-is.
  linkMap.set(page.path, newPath);

  // Without .md / .mdx extension.
  const stripped = stripMdExtension(page.path);
  if (stripped !== page.path) {
    linkMap.set(stripped, newPath);
  }

  // With leading slash variant.
  const withSlash = '/' + page.path.replace(/^\/+/, '');
  if (!linkMap.has(withSlash)) {
    linkMap.set(withSlash, newPath);
  }

  // Stripped with leading slash.
  const strippedWithSlash = '/' + stripped.replace(/^\/+/, '');
  if (!linkMap.has(strippedWithSlash)) {
    linkMap.set(strippedWithSlash, newPath);
  }
}

/**
 * Build the new Mintlify path for a page, incorporating the section
 * prefix and stripping the file extension.
 */
function buildNewPath(outputPath: string, sectionPrefix: string): string {
  let cleaned = stripMdExtension(outputPath);

  // Remove any leading slash so we can prepend the section prefix
  // consistently.
  cleaned = cleaned.replace(/^\/+/, '');

  // If the page path already starts with the section prefix, do not
  // duplicate it.
  const prefixLower = sectionPrefix.toLowerCase().replace(/^\/+/, '');
  if (prefixLower && !cleaned.toLowerCase().startsWith(prefixLower + '/')) {
    cleaned = `${sectionPrefix.replace(/^\/+/, '')}/${cleaned}`;
  }

  // Ensure a leading slash for the final Mintlify path.
  return '/' + cleaned;
}

// ─── Utilities ─────────────────────────────────────────────────────────

function stripMdExtension(p: string): string {
  return p.replace(/\.mdx?$/, '');
}
