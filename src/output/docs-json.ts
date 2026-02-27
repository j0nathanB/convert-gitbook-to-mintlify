import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  GitBookCustomization,
  GitBookRedirect,
  NavTab,
  NavGroup,
  NavPage,
  DocsJson,
  DocsNavTab,
  DocsNavGroup,
  MigrationConfig,
} from '../types.js';
import { logger } from '../utils/logger.js';

// ── Social platform detection ────────────────────────────────────────

/**
 * Known social platforms and the URL patterns that identify them.
 */
const SOCIAL_PLATFORMS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'twitter', pattern: /twitter\.com|x\.com/i },
  { name: 'github', pattern: /github\.com/i },
  { name: 'discord', pattern: /discord\.(gg|com)/i },
  { name: 'linkedin', pattern: /linkedin\.com/i },
  { name: 'youtube', pattern: /youtube\.com|youtu\.be/i },
  { name: 'slack', pattern: /slack\.com/i },
  { name: 'facebook', pattern: /facebook\.com|fb\.com/i },
  { name: 'instagram', pattern: /instagram\.com/i },
  { name: 'medium', pattern: /medium\.com/i },
  { name: 'reddit', pattern: /reddit\.com/i },
  { name: 'telegram', pattern: /t\.me|telegram\.(me|org)/i },
  { name: 'website', pattern: /.*/ }, // fallback — must be last
];

/**
 * Identify the social platform from a URL. Returns the platform name or
 * `null` if the URL is empty.
 */
function detectPlatform(url: string): string | null {
  if (!url) return null;
  for (const { name, pattern } of SOCIAL_PLATFORMS) {
    if (pattern.test(url)) {
      return name;
    }
  }
  return null;
}

// ── Navigation mapping ───────────────────────────────────────────────

/**
 * Convert an internal `NavGroup` to a Mintlify `DocsNavGroup`.
 */
function mapNavGroup(group: NavGroup): DocsNavGroup {
  const pages: (string | DocsNavGroup)[] = group.pages.map(
    (page: NavPage) => {
      // Mintlify expects extensionless page references in docs.json.
      const raw = page.outputPath ?? page.path;
      return raw.replace(/\.(mdx|md)$/, '');
    },
  );

  // Nested sub-groups
  if (group.groups) {
    for (const sub of group.groups) {
      pages.push(mapNavGroup(sub));
    }
  }

  return { group: group.label, pages };
}

/**
 * Convert internal `NavTab[]` into Mintlify navigation entries.
 */
function buildNavigation(tabs: NavTab[]): DocsNavTab[] {
  return tabs.map((tab) => ({
    tab: tab.label,
    groups: tab.groups.map(mapNavGroup),
  }));
}

// ── Footer socials extraction ────────────────────────────────────────

/**
 * Extract social links from footer links in GitBook customization.
 */
function extractFooterSocials(
  customization: GitBookCustomization | null,
): Record<string, string> | undefined {
  const links = customization?.footer?.links;
  if (!links || links.length === 0) return undefined;

  const socials: Record<string, string> = {};

  for (const link of links) {
    const url = link.to?.url;
    if (!url) continue;

    const platform = detectPlatform(url);
    if (platform && platform !== 'website') {
      socials[platform] = url;
    }
  }

  return Object.keys(socials).length > 0 ? socials : undefined;
}

// ── Public API ───────────────────────────────────────────────────────

export interface BuildDocsJsonOptions {
  customization: GitBookCustomization | null;
  tabs: NavTab[];
  redirects?: GitBookRedirect[];
  brandingOverrides?: MigrationConfig['brandingOverrides'];
  siteName?: string;
}

/**
 * Build a complete Mintlify `docs.json` from GitBook customization data,
 * navigation tabs, and optional overrides.
 */
export function buildDocsJson(options: BuildDocsJsonOptions): DocsJson {
  const { customization, tabs, redirects, brandingOverrides, siteName } =
    options;

  const docsJson: DocsJson = {
    $schema: 'https://mintlify.com/docs.json',
    navigation: buildNavigation(tabs),
  };

  // ── Name ─────────────────────────────────────────────────────────
  if (siteName) {
    docsJson.name = siteName;
  } else if (customization?.title) {
    docsJson.name = customization.title;
  }

  // ── Colors ───────────────────────────────────────────────────────
  const primaryLight = customization?.styling?.primaryColor?.light;
  const primaryDark = customization?.styling?.primaryColor?.dark;
  const tintLight = customization?.styling?.tint?.color?.light;

  if (primaryLight || primaryDark || tintLight) {
    docsJson.colors = {};
    if (primaryLight) docsJson.colors.primary = primaryLight;
    if (primaryDark) docsJson.colors.dark = primaryDark;
    if (tintLight) docsJson.colors.light = tintLight;
  }

  // ── Logo ─────────────────────────────────────────────────────────
  const logoLight = customization?.header?.logo?.light;
  const logoDark = customization?.header?.logo?.dark;
  if (logoLight || logoDark) {
    docsJson.logo = {};
    if (logoLight) docsJson.logo.light = logoLight;
    if (logoDark) docsJson.logo.dark = logoDark;
  }

  // ── Favicon ──────────────────────────────────────────────────────
  const faviconRaw = customization?.favicon?.icon;
  if (faviconRaw) {
    if (typeof faviconRaw === 'string') {
      docsJson.favicon = faviconRaw;
    } else if (faviconRaw.light) {
      docsJson.favicon = faviconRaw.light;
    }
  }

  // ── Font ─────────────────────────────────────────────────────────
  const fontFamily = customization?.styling?.font;
  if (fontFamily) {
    docsJson.font = {
      headings: { family: fontFamily },
      body: { family: fontFamily },
    };
  }

  // ── Footer socials ───────────────────────────────────────────────
  const socials = extractFooterSocials(customization);
  if (socials) {
    docsJson.footerSocials = socials;
  }

  // ── Redirects ────────────────────────────────────────────────────
  if (redirects && redirects.length > 0) {
    docsJson.redirects = redirects.map((r) => ({
      source: r.source,
      destination: r.destination,
    }));
  }

  // ── Branding overrides (highest priority) ────────────────────────
  if (brandingOverrides) {
    if (brandingOverrides.colors) {
      docsJson.colors = { ...docsJson.colors, ...brandingOverrides.colors };
    }
    if (brandingOverrides.logo) {
      docsJson.logo = { ...docsJson.logo, ...brandingOverrides.logo };
    }
    if (brandingOverrides.favicon) {
      docsJson.favicon = brandingOverrides.favicon;
    }
    if (brandingOverrides.font) {
      docsJson.font = {
        headings: { family: brandingOverrides.font },
        body: { family: brandingOverrides.font },
      };
    }
  }

  return docsJson;
}

/**
 * Serialize and write the `docs.json` file to the output directory.
 */
export async function writeDocsJson(
  docsJson: DocsJson,
  outputDir: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const targetPath = join(outputDir, 'docs.json');
  const content = JSON.stringify(docsJson, null, 2) + '\n';
  await writeFile(targetPath, content, 'utf-8');
  logger.info(`Wrote ${targetPath}`);
}
