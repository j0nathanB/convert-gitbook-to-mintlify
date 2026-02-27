#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { glob } from 'glob';

// ── API layer ────────────────────────────────────────────────────────
import { GitBookClient } from './api/client.js';
import { fetchSitePublished, fetchSiteRedirects } from './api/site.js';
import { fetchSpacePages, fetchSpaceFiles, fetchPageContent } from './api/space.js';
import { fetchOpenAPISpecs } from './api/openapi.js';

// ── Parsers ──────────────────────────────────────────────────────────
import { parseSummaryFile, parseMultipleSummaries } from './parsers/summary-parser.js';
import { readMarkdownFile, readAllMarkdownFiles } from './parsers/markdown-reader.js';

// ── Reconciler ───────────────────────────────────────────────────────
import { mergeNavTrees } from './reconciler/nav-merger.js';
import { disambiguateSlugs } from './reconciler/slug-disambiguator.js';
import { buildLinkMap, buildImageMap } from './reconciler/link-mapper.js';
import { buildAssetInventory, categorizeAssets } from './reconciler/asset-inventory.js';

// ── Transformer ──────────────────────────────────────────────────────
import { convertToMdx } from './transformer/mdx-converter.js';
import { convertHtmlToMdx } from './transformer/hast-to-mdx.js';
import { apiDocumentToMdx } from './transformer/api-to-mdx.js';

// ── Scraper ─────────────────────────────────────────────────────────
import { crawlSite } from './scraper/crawler.js';
import type { CrawledTab } from './scraper/crawler.js';
import { extractNavigation } from './scraper/nav-extractor.js';
import { extractTabs } from './scraper/tab-extractor.js';
import { extractTheme } from './scraper/theme-extractor.js';
import { extractMainContent, cleanScrapedContent } from './scraper/content-cleaner.js';
import { defaultSelectors, mergeSelectors } from './scraper/selectors.js';

// ── Output ───────────────────────────────────────────────────────────
import { buildDocsJson } from './output/docs-json.js';
import { downloadAssets, downloadLogos } from './output/asset-downloader.js';
import { writeOutputFiles } from './output/file-writer.js';
import { generateReport, writeReportFiles } from './output/report-generator.js';
import { promptForBranding } from './output/branding-prompts.js';

// ── Validation ───────────────────────────────────────────────────────
import { runValidation } from './validation/runner.js';

// ── Utilities ────────────────────────────────────────────────────────
import { logger, createSpinner, setVerbose } from './utils/logger.js';
import { loadConfig, mergeConfigs, getDefaultConfig } from './utils/config.js';

// ── Types ────────────────────────────────────────────────────────────
import type {
  GitBookSitePublished,
  GitBookSiteStructure,
  GitBookCustomization,
  GitBookPage,
  GitBookFile,
  GitBookRedirect,
  GitBookOpenAPISpec,
  NavTab,
  NavGroup,
  NavPage,
  NavTreeNode,
  ParsedPage,
  ImageAsset,
  MigrationConfig,
  MigrationReport,
  Discrepancy,
  ManualReviewItem,
  MigrationWarning,
} from './types.js';

// ─── CLI setup ───────────────────────────────────────────────────────

const program = new Command();

program
  .name('gitbook-to-mintlify')
  .description('Convert GitBook documentation to Mintlify format')
  .version('1.0.0')
  .option('--source <path>', 'GitBook source directory')
  .option('--api-token <token>', 'GitBook API token')
  .option('--org-id <id>', 'GitBook organization ID')
  .option('--site-id <id>', 'GitBook site ID')
  .option('--url <url>', 'Published GitBook site URL (fallback scraper mode)')
  .requiredOption('--output <path>', 'Output directory')
  .option('--config <path>', 'Path to migration.json config file')
  .option('--dry-run', 'Report only, no output files')
  .option('--strict', 'Error on unrecognized GitBook blocks')
  .option('--no-prompt', 'Skip interactive branding prompts')
  .option('--verbose', 'Enable debug logging');

program.action(async (opts) => {
  try {
    await run(opts);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    if (error instanceof Error && error.stack && opts.verbose) {
      logger.debug(error.stack);
    }
    process.exit(1);
  }
});

program.parse();

// ─── Main orchestration pipeline ─────────────────────────────────────

interface CliOptions {
  source?: string;
  apiToken?: string;
  orgId?: string;
  siteId?: string;
  url?: string;
  output: string;
  config?: string;
  dryRun?: boolean;
  strict?: boolean;
  prompt?: boolean;   // commander stores --no-prompt as opts.prompt = false
  verbose?: boolean;
}

async function run(opts: CliOptions): Promise<void> {
  // ── Verbose mode ────────────────────────────────────────────────────
  if (opts.verbose) {
    setVerbose(true);
  }

  // ── Load and merge configuration ────────────────────────────────────
  const fileConfig = await loadConfig(opts.config);
  const cliOverrides: Partial<MigrationConfig> = {
    output: opts.output,
    strict: opts.strict ?? false,
    dryRun: opts.dryRun ?? false,
    noPrompt: opts.prompt === false,
  };

  // CLI flags take priority, then env vars.
  const apiToken = opts.apiToken ?? process.env.GITBOOK_API_KEY;
  const orgId = opts.orgId ?? process.env.GITBOOK_ORG_ID;
  const siteId = opts.siteId ?? process.env.GITBOOK_SITE_ID;

  if (apiToken) cliOverrides.api = { ...cliOverrides.api, token: apiToken };
  if (orgId) cliOverrides.api = { ...cliOverrides.api, orgId: orgId };
  if (siteId) cliOverrides.api = { ...cliOverrides.api, siteId: siteId };
  if (opts.source) cliOverrides.source = opts.source;
  if (opts.url ?? process.env.GITBOOK_URL) cliOverrides.url = opts.url ?? process.env.GITBOOK_URL;

  const config = mergeConfigs(getDefaultConfig(), fileConfig, cliOverrides);
  const outputDir = resolve(config.output);

  logger.debug(`Resolved config: ${JSON.stringify(config, null, 2)}`);

  // ── Mode detection ──────────────────────────────────────────────────
  const hasApi = !!(config.api.token && config.api.orgId && config.api.siteId);
  const hasSource = !!config.source;
  const hasScraper = !!config.url;

  if (!hasApi && !hasSource && !hasScraper) {
    throw new Error(
      'At least one data source is required. Provide:\n' +
      '  --api-token + --org-id + --site-id   (API mode)\n' +
      '  --source <path>                      (source file mode)\n' +
      '  --url <url>                          (scraper mode)',
    );
  }

  logger.info(
    `Mode: ${[
      hasApi ? 'API' : null,
      hasSource ? 'Source' : null,
      hasScraper ? 'Scraper' : null,
    ]
      .filter(Boolean)
      .join(' + ')}`,
  );

  // ── Shared state across phases ──────────────────────────────────────
  let sitePublished: GitBookSitePublished | null = null;
  let apiStructure: GitBookSiteStructure | null = null;
  let customization: GitBookCustomization | null = null;
  let apiPages: GitBookPage[] = [];
  let apiFiles: GitBookFile[] = [];
  let apiRedirects: GitBookRedirect[] = [];
  let openapiSpecs: GitBookOpenAPISpec[] = [];
  let summaryTabs: NavTab[] = [];
  let parsedPages: ParsedPage[] = [];
  const warnings: MigrationWarning[] = [];

  // Map from GitBook page ID → output path (for resolving content-ref / button links).
  const pageIdToPath = new Map<string, string>();
  // Map from page ID → space ID (for fetching page content from the right space).
  const pageIdToSpaceId = new Map<string, string>();
  // Map from file ID → download URL (for resolving cover images in card tables).
  const fileIdToUrl = new Map<string, string>();
  // Map from space ID → path prefix (for resolving kind:"space" refs).
  const spaceIdToPath = new Map<string, string>();

  // ════════════════════════════════════════════════════════════════════
  // Phase 1: API Data Extraction
  // ════════════════════════════════════════════════════════════════════

  if (hasApi) {
    const spinner = createSpinner('Fetching data from GitBook API...').start();

    try {
      const client = new GitBookClient(config.api.token!);

      // Fetch site published profile (structure + customization)
      spinner.text = 'Fetching site published profile...';
      sitePublished = await fetchSitePublished(
        client,
        config.api.orgId!,
        config.api.siteId!,
      );
      apiStructure = sitePublished.structure;
      // The API nests customization under a "site" key.
      const rawCustom = sitePublished.customizations as any;
      customization = rawCustom?.site ?? rawCustom;

      logger.debug(`Site: ${sitePublished.site.title} (${sitePublished.site.id})`);

      // Collect all space IDs from the structure
      const spaceIds = extractSpaceIds(apiStructure);
      logger.debug(`Found ${spaceIds.length} space(s) in site structure`);

      // Fetch pages and files for each space, building ID maps as we go.
      for (const spaceId of spaceIds) {
        spinner.text = `Fetching pages for space ${spaceId}...`;
        const pages = await fetchSpacePages(client, spaceId);
        apiPages.push(...pages);

        // Build page-ID-to-path and page-ID-to-spaceId maps.
        // Include site basename so resolved paths match Mintlify output paths.
        const sectionPrefix = findSpacePathPrefix(apiStructure!, spaceId);
        const siteBase = sitePublished?.site.basename ?? '';
        const fullPrefix = [siteBase, sectionPrefix].filter(Boolean).join('/');
        buildPageIdMap(pages, fullPrefix, pageIdToPath, pageIdToSpaceId, spaceId);

        // Build space-ID-to-path map for resolving kind:"space" refs.
        const spaceRoot = fullPrefix ? `/${fullPrefix}` : '/';
        spaceIdToPath.set(spaceId, spaceRoot);

        spinner.text = `Fetching files for space ${spaceId}...`;
        const files = await fetchSpaceFiles(client, spaceId);
        apiFiles.push(...files);

        // Build file-ID-to-URL map for resolving cover images.
        for (const file of files) {
          if (file.downloadURL) {
            fileIdToUrl.set(file.id, file.downloadURL);
          }
        }
      }

      // Fetch OpenAPI specs
      spinner.text = 'Fetching OpenAPI specs...';
      openapiSpecs = await fetchOpenAPISpecs(client, config.api.orgId!);

      // Fetch site redirects
      spinner.text = 'Fetching site redirects...';
      apiRedirects = await fetchSiteRedirects(
        client,
        config.api.orgId!,
        config.api.siteId!,
      );

      spinner.succeed(
        `API data fetched: ${apiPages.length} page(s), ${apiFiles.length} file(s), ` +
        `${openapiSpecs.length} OpenAPI spec(s), ${apiRedirects.length} redirect(s)`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.fail(`API data extraction failed: ${message}`);
      throw error;
    }
  }

  // ── Theme / color translation warnings ───────────────────────────────
  if (customization?.styling) {
    const styling = customization.styling;
    const theme = styling.theme;
    const tintLight = styling.tint?.color?.light;
    const tintDark = styling.tint?.color?.dark;
    const sidebarBg = styling.sidebar?.background;

    // GitBook "bold" theme fills the header & sidebar with the tint/primary
    // color.  Mintlify has no equivalent — primary is used only as an accent
    // color for links and buttons.
    if (theme === 'bold' || theme === 'default-bold') {
      const colorNote = tintLight
        ? ` (tint: ${tintLight}/${tintDark ?? 'n/a'})`
        : '';
      warnings.push({
        type: 'theme_translation',
        message:
          `GitBook uses the "${theme}" theme${colorNote} which fills the header and sidebar ` +
          `with the primary/tint color. Mintlify only uses the primary color as an accent ` +
          `for links and buttons — there is no direct equivalent for header/sidebar ` +
          `background fills. You may approximate this with Mintlify's background.color ` +
          `setting, but it tints the entire page, not just the header.`,
        severity: 'warning',
      });
    }

    // Sidebar filled background has no Mintlify equivalent
    if (sidebarBg === 'filled') {
      warnings.push({
        type: 'theme_translation',
        message:
          `GitBook sidebar has background: "filled" which tints the sidebar background. ` +
          `Mintlify does not support sidebar background customization.`,
        severity: 'warning',
      });
    }
  }

  // Build manual-review items for theme translation issues (used in report).
  const themeReviewItems: ManualReviewItem[] = warnings
    .filter((w) => w.type === 'theme_translation')
    .map((w) => ({
      path: 'docs.json',
      reason: w.message,
      severity: 'medium' as const,
    }));

  // ════════════════════════════════════════════════════════════════════
  // Phase 2: Source File Parsing
  // ════════════════════════════════════════════════════════════════════

  if (hasSource) {
    const spinner = createSpinner('Parsing source files...').start();

    try {
      const sourceDir = resolve(config.source!);

      // Find all SUMMARY.md files
      spinner.text = 'Finding SUMMARY.md files...';
      const summaryFiles = await glob('**/SUMMARY.md', {
        cwd: sourceDir,
        absolute: true,
      });

      if (summaryFiles.length === 0) {
        spinner.warn('No SUMMARY.md files found in source directory');
      } else {
        logger.debug(`Found ${summaryFiles.length} SUMMARY.md file(s)`);

        // Parse each SUMMARY.md
        spinner.text = `Parsing ${summaryFiles.length} SUMMARY.md file(s)...`;
        summaryTabs = await parseMultipleSummaries(summaryFiles);

        // Collect all referenced markdown file paths from the nav tabs
        const mdFilePaths = collectMarkdownPaths(summaryTabs);
        logger.debug(`Found ${mdFilePaths.length} referenced markdown file(s)`);

        // Read all referenced markdown files
        spinner.text = `Reading ${mdFilePaths.length} markdown file(s)...`;
        parsedPages = await readAllMarkdownFiles(sourceDir, mdFilePaths);

        spinner.succeed(
          `Source files parsed: ${summaryTabs.length} tab(s), ${parsedPages.length} page(s)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.fail(`Source file parsing failed: ${message}`);
      throw error;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Scraper
  // ════════════════════════════════════════════════════════════════════

  if (hasScraper) {
    const scraperSpinner = createSpinner('Scraping published site...').start();

    try {
      const selectors = mergeSelectors(config.scraper.selectors);

      // Crawl the site to discover pages and get HTML
      scraperSpinner.text = 'Crawling site pages...';
      const crawlResult = await crawlSite(config.url!, {
        concurrency: config.scraper.concurrency,
        delayMs: config.scraper.delayMs,
        sidebarExpansionRounds: config.scraper.sidebarExpansionRounds,
        skipPaths: config.scraper.skipPaths,
        authCookie: config.scraper.authCookie,
        selectors,
      });

      if (crawlResult.errors.length > 0) {
        for (const err of crawlResult.errors) {
          warnings.push({ type: 'scraper', message: err, severity: 'warning' });
        }
      }

      logger.debug(`Crawled ${crawlResult.pages.length} page(s), ${crawlResult.errors.length} error(s)`);

      // Convert scraped pages to ParsedPage format.
      // When API is available, try to fetch rich content from the API for
      // each page and render with apiDocumentToMdx (primary path).  Fall
      // back to scraper HTML → MDX conversion if API content is unavailable.
      scraperSpinner.text = 'Converting scraped content to MDX...';
      const apiClient = hasApi ? new GitBookClient(config.api.token!) : null;

      for (const crawledPage of crawlResult.pages) {
        const pagePath = crawledPage.path.replace(/^\//, '') || 'index';
        const outputPath = `${pagePath}.mdx`.replace(/\/+$/, '/index.mdx');

        // Clean browser <title> — strip " | Section | Site" suffixes.
        const pageTitle = (crawledPage.title || '').split(' | ')[0].trim();

        // Derive Mintlify page mode from GitBook layout hints.
        const frontmatter: Record<string, unknown> = {};
        let mdxBody = '';
        let usedApi = false;

        // Try API content rendering first.
        if (apiClient) {
          const pageId = findPageIdByPath(pageIdToPath, pagePath, sitePublished?.site.basename);
          if (pageId) {
            const spaceId = pageIdToSpaceId.get(pageId);
            if (spaceId) {
              try {
                scraperSpinner.text = `Fetching API content for ${pagePath}...`;
                const pageContent = await fetchPageContent(apiClient, spaceId, pageId);

                if (pageContent.document?.nodes) {
                  mdxBody = apiDocumentToMdx(pageContent.document.nodes, pageIdToPath, {
                    fileIdToUrl,
                    spaceIdToPath,
                  });
                  usedApi = true;

                  // Use API layout metadata for frontmatter mode.
                  if (pageContent.layout) {
                    const { width, tableOfContents, title: showTitle } = pageContent.layout;
                    if (width === 'wide' && tableOfContents === false) {
                      frontmatter.mode = 'wide';
                    } else if (showTitle === false && tableOfContents === false) {
                      frontmatter.mode = 'center';
                    }
                  }
                }
              } catch (err) {
                logger.debug(`API content fetch failed for ${pagePath}, falling back to scraper: ${err}`);
              }
            }
          }
        }

        // Fall back to scraper HTML conversion.
        if (!usedApi) {
          const cleanHtml = extractMainContent(crawledPage.html, selectors);
          mdxBody = convertHtmlToMdx(cleanHtml);

          if (crawledPage.layoutHints) {
            const { hasToc, isCentered } = crawledPage.layoutHints;
            if (!hasToc && isCentered) {
              frontmatter.mode = 'center';
            } else if (!hasToc) {
              frontmatter.mode = 'wide';
            }
          }
        }

        parsedPages.push({
          path: outputPath,
          title: pageTitle,
          frontmatter,
          rawBody: mdxBody,
          gitbookBlocks: [],
          images: [],
          internalLinks: [],
        });

        // Build a nav structure from crawled pages if we don't have one from API/source
        if (summaryTabs.length === 0) {
          // We'll build tabs from the crawled structure after the loop
        }
      }

      // If no API or source nav, build nav from crawler tab structure
      if (summaryTabs.length === 0 && parsedPages.length > 0) {
        if (crawlResult.tabs.length > 0) {
          summaryTabs = buildNavTabsFromCrawledTabs(crawlResult.tabs, parsedPages);
        } else {
          // Ultimate flat fallback when no tabs discovered at all
          const defaultGroup = {
            label: 'Documentation',
            pages: parsedPages.map((p) => ({
              label: p.title || p.path.replace(/\.mdx$/, '').split('/').pop() || 'Untitled',
              path: p.path,
            })),
          };
          summaryTabs = [{
            label: 'Documentation',
            slug: 'documentation',
            groups: [defaultGroup],
          }];
        }
      }

      // Extract theme/logo from the first crawled page if available.
      if (crawlResult.pages.length > 0) {
        scraperSpinner.text = 'Extracting theme from scraped page...';
        try {
          const { chromium } = await import('playwright');
          const browser = await chromium.launch({ headless: true });
          const themePage = await browser.newPage();
          await themePage.goto(config.url!, { waitUntil: 'networkidle', timeout: 30_000 });
          const scraped = await extractTheme(themePage, selectors);
          await browser.close();

          // Use scraped logo/favicon as fallback when API didn't provide them.
          const hasApiLogo = customization?.header?.logo?.light || customization?.header?.logo?.dark;
          if (scraped.logo && !hasApiLogo) {
            const origin = new URL(config.url!).origin;
            const resolveUrl = (src: string) =>
              src.startsWith('http') ? src : `${origin}${src}`;

            // GitBook often hides the dark variant via CSS (hidden dark:block).
            // If only the light icon was found, infer the dark URL by swapping
            // the theme query parameter.
            let darkUrl = scraped.logo.dark;
            if (!darkUrl && scraped.logo.light?.includes('theme=light')) {
              darkUrl = scraped.logo.light.replace('theme=light', 'theme=dark');
            }

            if (!customization) {
              customization = {} as any;
            }
            customization!.header = customization!.header ?? {};
            customization!.header.logo = {
              light: scraped.logo.light ? resolveUrl(scraped.logo.light) : undefined,
              dark: darkUrl ? resolveUrl(darkUrl) : undefined,
            };
            logger.info('Using scraped logo URLs as fallback');
          }

          const hasApiFavicon = (() => {
            const icon = customization?.favicon?.icon;
            if (!icon) return false;
            if (typeof icon === 'string') return !!icon;
            return !!(icon.light || icon.dark);
          })();
          if (scraped.favicon && !hasApiFavicon) {
            if (!customization) {
              customization = {} as any;
            }
            customization!.favicon = { icon: scraped.favicon.value };
            logger.info('Using scraped favicon URL as fallback');
          }
        } catch (themeErr) {
          const msg = themeErr instanceof Error ? themeErr.message : String(themeErr);
          logger.warn(`Theme extraction from scraper failed: ${msg}`);
        }
      }

      scraperSpinner.succeed(
        `Scraped ${crawlResult.pages.length} page(s) from ${config.url}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      scraperSpinner.fail(`Scraping failed: ${message}`);
      if (message.includes('Cannot find module') && message.includes('playwright')) {
        logger.error('Playwright is not installed. Install it with: npm install playwright && npx playwright install chromium');
      }
      throw error;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 4: Reconciliation
  // ════════════════════════════════════════════════════════════════════

  const reconcileSpinner = createSpinner('Reconciling data sources...').start();

  let reconciledTabs: NavTab[];
  let discrepancies: Discrepancy[] = [];
  let linkMap: Map<string, string>;
  let imageMap: Map<string, string>;
  let assets: ImageAsset[];
  let disambiguationRedirects: Array<{ source: string; destination: string }> = [];

  try {
    // Merge nav trees (API + SUMMARY.md)
    reconcileSpinner.text = 'Merging navigation trees...';
    const mergeResult = mergeNavTrees(apiStructure, summaryTabs, config);
    reconciledTabs = mergeResult.tabs;
    discrepancies = mergeResult.discrepancies;

    // Disambiguate slugs (parent-with-children)
    reconcileSpinner.text = 'Disambiguating slugs...';
    const disambiguateResult = disambiguateSlugs(reconciledTabs);
    reconciledTabs = disambiguateResult.tabs;
    disambiguationRedirects = disambiguateResult.redirects;

    // Build asset inventory
    reconcileSpinner.text = 'Building asset inventory...';
    assets = await buildAssetInventory(
      apiFiles,
      parsedPages,
      config.source ? resolve(config.source) : undefined,
    );

    // Build link map and image map
    reconcileSpinner.text = 'Building link and image maps...';
    const sectionPaths = new Map<string, string>();
    for (const tab of reconciledTabs) {
      sectionPaths.set(tab.slug, tab.slug);
    }
    linkMap = buildLinkMap(reconciledTabs, sectionPaths);
    imageMap = buildImageMap(assets);

    // Categorize assets
    const categorized = categorizeAssets(assets);

    reconcileSpinner.succeed(
      `Reconciliation complete: ${reconciledTabs.length} tab(s), ` +
      `${discrepancies.length} discrepancy(ies), ` +
      `${linkMap.size} link mapping(s), ` +
      `${assets.length} asset(s) (${categorized.toCopy.length} to copy, ` +
      `${categorized.toDownload.length} to download, ${categorized.missing.length} missing)`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    reconcileSpinner.fail(`Reconciliation failed: ${message}`);
    throw error;
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 5: Content Transformation
  // ════════════════════════════════════════════════════════════════════

  // Build a lookup from output path → icon for injecting into frontmatter.
  const pageIconMap = new Map<string, string>();
  for (const tab of reconciledTabs) {
    for (const group of tab.groups) {
      collectPageIcons(group, pageIconMap);
    }
  }

  const transformSpinner = createSpinner('Transforming content to MDX...').start();

  const convertedPages: Array<{ outputPath: string; content: string }> = [];

  try {
    for (const page of parsedPages) {
      transformSpinner.text = `Converting ${page.path}...`;

      let mdxContent: string;
      if (hasScraper && !hasSource && page.gitbookBlocks.length === 0) {
        // Scraped pages: rawBody is already MDX from convertHtmlToMdx.
        // Clean the title: browser <title> includes section/site suffixes
        // like "Page | Section | Site Name" — take just the first segment.
        const cleanTitle = (page.title || '').split(' | ')[0].trim();

        let body = page.rawBody;

        // Strip first H1 if it matches the title (avoids redundancy).
        if (config.transforms.removeFirstH1) {
          body = body.replace(/^(#\s+.+\n?\n?)/, (match: string, h1: string) => {
            const h1Text = h1.replace(/^#\s+/, '').trim();
            // Remove if it matches the clean title or the full title.
            if (h1Text === cleanTitle || h1Text === page.title) {
              return '';
            }
            return match;
          });
        }

        // Look up the page icon from the nav structure.
        const pageOutputPath = page.path
          .replace(/\.md$/, '')
          .replace(/\.mdx$/, '')
          .replace(/^\/+/, '')
          + '.mdx';
        const pageIcon = pageIconMap.get(pageOutputPath);

        const fmLines = [
          '---',
          `title: "${cleanTitle.replace(/"/g, '\\"')}"`,
        ];
        if (pageIcon) {
          fmLines.push(`icon: "${pageIcon}"`);
        }
        if (page.frontmatter.mode) {
          fmLines.push(`mode: "${page.frontmatter.mode}"`);
        }
        fmLines.push('---');
        const fm = fmLines.join('\n');
        mdxContent = `${fm}\n\n${body}\n`;
      } else {
        mdxContent = convertToMdx(page, {
          linkMap,
          imageMap,
          removeFirstH1: config.transforms.removeFirstH1,
          strict: config.strict,
        });
      }

      // Compute output path: ensure .mdx extension
      const outputPath = page.path
        .replace(/\.md$/, '')
        .replace(/\.mdx$/, '')
        .replace(/^\/+/, '')
        + '.mdx';

      convertedPages.push({ outputPath, content: mdxContent });
    }

    transformSpinner.succeed(`Transformed ${convertedPages.length} page(s) to MDX`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    transformSpinner.fail(`Content transformation failed: ${message}`);
    throw error;
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 6: Output Generation
  // ════════════════════════════════════════════════════════════════════

  if (!config.dryRun) {
    const outputSpinner = createSpinner('Generating output...').start();

    try {
      // Prompt for branding if needed
      outputSpinner.stop();
      const brandingResult = await promptForBranding(customization, config.noPrompt);
      outputSpinner.start('Building docs.json...');

      // Merge branding overrides
      const brandingOverrides = { ...config.brandingOverrides };
      if (brandingResult.logo) {
        brandingOverrides.logo = { ...brandingOverrides.logo, ...brandingResult.logo };
      }
      if (brandingResult.favicon) {
        brandingOverrides.favicon = brandingResult.favicon;
      }
      if (brandingResult.font) {
        brandingOverrides.font = brandingResult.font;
      }
      if (brandingResult.primaryColor) {
        brandingOverrides.colors = {
          ...brandingOverrides.colors,
          primary: brandingResult.primaryColor,
        };
      }

      // Combine API redirects with disambiguation redirects
      const allRedirects = [
        ...apiRedirects,
        ...disambiguationRedirects,
      ];

      // Build docs.json
      const docsJson = buildDocsJson({
        customization,
        tabs: reconciledTabs,
        redirects: allRedirects.length > 0 ? allRedirects : undefined,
        brandingOverrides,
        siteName: sitePublished?.site.title,
      });

      // Download/copy assets
      outputSpinner.text = 'Downloading assets...';
      const categorized = categorizeAssets(assets);
      let downloadResult = { downloaded: 0, failed: [] as string[] };

      if (categorized.toDownload.length > 0) {
        const downloadItems = categorized.toDownload
          .filter((a) => a.apiDownloadUrl)
          .map((a) => ({
            url: a.apiDownloadUrl!,
            targetPath: resolve(outputDir, a.targetPath.replace(/^\//, '')),
          }));

        downloadResult = await downloadAssets(downloadItems);
      }

      // Download logos
      outputSpinner.text = 'Downloading logos...';
      const logoResult = await downloadLogos(customization, outputDir);

      // Update docs.json with downloaded logo paths
      if (logoResult.lightLogo || logoResult.darkLogo) {
        docsJson.logo = {
          ...docsJson.logo,
          ...(logoResult.lightLogo ? { light: logoResult.lightLogo } : {}),
          ...(logoResult.darkLogo ? { dark: logoResult.darkLogo } : {}),
        };
      }
      if (logoResult.favicon) {
        docsJson.favicon = logoResult.favicon;
      }

      // Generate migration report
      const report = generateReport({
        stats: {
          totalPages: convertedPages.length,
          imagesCopied: categorized.toCopy.length,
          imagesDownloaded: downloadResult.downloaded,
          linksRewritten: linkMap.size,
          redirectsPreserved: allRedirects.length,
          blocksConverted: parsedPages.reduce(
            (sum, p) => sum + p.gitbookBlocks.length,
            0,
          ),
          blocksUnrecognized: 0,
        },
        dataSources: {
          api: hasApi,
          sourceFiles: hasSource,
          scraper: hasScraper,
        },
        discrepancies,
        warnings: [
          ...warnings,
          ...brandingResult.warnings.map((msg) => ({
            type: 'branding',
            message: msg,
            severity: 'warning' as const,
          })),
          ...downloadResult.failed.map((url) => ({
            type: 'asset_download',
            message: `Failed to download: ${url}`,
            severity: 'warning' as const,
          })),
          ...categorized.missing.map((a) => ({
            type: 'missing_asset',
            path: a.sourcePath,
            message: `Image referenced but not found: ${a.sourcePath}`,
            severity: 'warning' as const,
          })),
        ],
        manualReviewQueue: [
          ...categorized.missing.map((a) => ({
            path: a.referencedIn[0] ?? a.sourcePath,
            reason: `Missing image: ${a.sourcePath}`,
            severity: 'medium' as const,
          })),
          ...themeReviewItems,
        ],
      });

      // Write all output files
      outputSpinner.text = 'Writing output files...';
      await writeOutputFiles({
        outputDir,
        pages: convertedPages,
        docsJson,
        report,
        assets,
      });

      outputSpinner.succeed(`Output generated at ${outputDir}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outputSpinner.fail(`Output generation failed: ${message}`);
      throw error;
    }
  } else {
    logger.info(chalk.yellow('Dry run -- skipping output generation'));

    // Still generate and display the report
    const report = generateReport({
      stats: {
        totalPages: convertedPages.length,
        imagesCopied: 0,
        imagesDownloaded: 0,
        linksRewritten: linkMap.size,
        redirectsPreserved: apiRedirects.length + disambiguationRedirects.length,
        blocksConverted: parsedPages.reduce(
          (sum, p) => sum + p.gitbookBlocks.length,
          0,
        ),
        blocksUnrecognized: 0,
      },
      dataSources: {
        api: hasApi,
        sourceFiles: hasSource,
        scraper: hasScraper,
      },
      discrepancies,
      warnings,
    });

    logger.info(chalk.bold('\nDry Run Report:'));
    logger.info(`  Pages:        ${report.stats.totalPages}`);
    logger.info(`  Links mapped: ${report.stats.linksRewritten}`);
    logger.info(`  Redirects:    ${report.stats.redirectsPreserved}`);
    logger.info(`  Blocks:       ${report.stats.blocksConverted}`);
    logger.info(`  Discrepancies: ${report.discrepancies.length}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 7: Validation
  // ════════════════════════════════════════════════════════════════════

  if (!config.dryRun) {
    const validationSpinner = createSpinner('Running validation...').start();

    try {
      validationSpinner.stop();
      const validationResult = await runValidation(outputDir);

      if (validationResult.passed) {
        logger.success(chalk.green('\nMigration completed successfully.'));
      } else {
        logger.warn(chalk.yellow('\nMigration completed with validation warnings.'));
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Validation encountered an error: ${message}`);
    }
  }

  logger.info(chalk.bold(`\nOutput directory: ${outputDir}`));
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract all unique space IDs from a GitBook site structure.
 */
function extractSpaceIds(structure: GitBookSiteStructure): string[] {
  const ids = new Set<string>();

  if (structure.type === 'sections') {
    for (const section of structure.structure) {
      for (const siteSpace of section.siteSpaces) {
        ids.add(siteSpace.space.id);
      }
    }
  } else {
    for (const siteSpace of structure.structure) {
      ids.add(siteSpace.space.id);
    }
  }

  return [...ids];
}

/**
 * Collect all markdown file paths referenced in the navigation tabs.
 */
function collectMarkdownPaths(tabs: NavTab[]): string[] {
  const paths = new Set<string>();

  for (const tab of tabs) {
    for (const group of tab.groups) {
      collectPathsFromGroup(group, paths);
    }
  }

  return [...paths];
}

/**
 * Recursively collect page paths from a nav group.
 */
function collectPathsFromGroup(
  group: { pages: Array<{ path: string }>; groups?: Array<typeof group> },
  paths: Set<string>,
): void {
  for (const page of group.pages) {
    if (page.path) {
      paths.add(page.path);
    }
  }

  if (group.groups) {
    for (const sub of group.groups) {
      collectPathsFromGroup(sub, paths);
    }
  }
}

// ── Tab-aware nav builder from crawled tabs ──────────────────────────

/**
 * Convert `CrawledTab[]` (from the crawler) into `NavTab[]` used by
 * the reconciler and docs.json builder.
 *
 * Tabs with a populated sidebar navTree produce multiple groups
 * reflecting the sidebar hierarchy.  Tabs with empty sidebars (e.g.
 * Home, Changelog) produce a single-page tab if a matching crawled
 * page exists.
 */
function buildNavTabsFromCrawledTabs(
  crawledTabs: CrawledTab[],
  parsedPages: ParsedPage[],
): NavTab[] {
  // Index crawled pages by normalized pathname for quick lookup.
  const pageByPath = new Map<string, ParsedPage>();
  for (const p of parsedPages) {
    const norm = p.path.replace(/\.mdx$/, '').replace(/\/+$/, '');
    pageByPath.set(norm, p);
  }

  const navTabs: NavTab[] = [];

  for (const tab of crawledTabs) {
    const slug = tab.slug;

    if (tab.navTree.length > 0) {
      // Build groups from the navTree.
      const groups = navTreeToGroups(tab.navTree, tab.label);

      // Prepend a landing-page group for the tab itself if a page
      // exists at the tab URL path AND isn't already in the navTree groups.
      const tabPath = pathFromUrl(tab.url);
      const tabPage = findParsedPage(pageByPath, tabPath);
      if (tabPage) {
        const alreadyInGroups = groups.some((g) =>
          g.pages.some((p) => typeof p !== 'string' && 'path' in p && p.path === tabPage.path),
        );
        if (!alreadyInGroups) {
          const landingGroup: NavGroup = {
            label: tab.label,
            pages: [{
              label: tabPage.title || tab.label,
              path: tabPage.path,
            }],
          };
          groups.unshift(landingGroup);
        }
      }

      navTabs.push({ label: tab.label, slug, groups, ...(tab.icon ? { icon: tab.icon } : {}) });
    } else {
      // Tab with no sidebar (Home, Changelog, etc.) — single page.
      const tabPath = pathFromUrl(tab.url);
      const tabPage = findParsedPage(pageByPath, tabPath);
      if (tabPage) {
        navTabs.push({
          label: tab.label,
          slug,
          ...(tab.icon ? { icon: tab.icon } : {}),
          groups: [{
            label: tab.label,
            pages: [{
              label: tabPage.title || tab.label,
              path: tabPage.path,
            }],
          }],
        });
      }
    }
  }

  return navTabs;
}

/**
 * Convert a NavTreeNode[] sidebar tree into NavGroup[].
 *
 * Top-level nodes without children become pages in a default group.
 * Top-level nodes that are group headers (no path, have children)
 * become separate NavGroups.
 */
function navTreeToGroups(nodes: NavTreeNode[], defaultLabel: string): NavGroup[] {
  const groups: NavGroup[] = [];
  let currentPages: NavPage[] = [];

  for (const node of nodes) {
    if (!node.path && node.children?.length > 0) {
      // Flush accumulated pages as a default group.
      if (currentPages.length > 0) {
        groups.push({ label: defaultLabel, pages: currentPages });
        currentPages = [];
      }
      // This is a named group header.
      const groupPages = flattenTreeToPages(node.children);
      if (groupPages.length > 0) {
        groups.push({ label: node.label, pages: groupPages });
      }
    } else if (node.path) {
      const outPath = nodePathToOutputPath(node.path);
      if (outPath && outPath !== '.mdx') {
        currentPages.push({ label: node.label, path: outPath, ...(node.icon ? { icon: node.icon } : {}) });
      }
      // Also include any children as pages in the same run.
      if (node.children?.length > 0) {
        currentPages.push(...flattenTreeToPages(node.children));
      }
    }
  }

  // Flush remaining pages.
  if (currentPages.length > 0) {
    groups.push({ label: defaultLabel, pages: currentPages });
  }

  return groups;
}

/**
 * Recursively flatten NavTreeNode children into a flat list of NavPages.
 * Filters out nodes with empty or root-only paths.
 */
function flattenTreeToPages(nodes: NavTreeNode[]): NavPage[] {
  const pages: NavPage[] = [];
  for (const node of nodes) {
    if (node.path) {
      const outPath = nodePathToOutputPath(node.path);
      // Skip empty paths or bare ".mdx" (from empty/root-only pathnames).
      if (outPath && outPath !== '.mdx') {
        pages.push({ label: node.label, path: outPath, ...(node.icon ? { icon: node.icon } : {}) });
      }
    }
    if (node.children?.length > 0) {
      pages.push(...flattenTreeToPages(node.children));
    }
  }
  return pages;
}

/**
 * Convert a NavTreeNode path (URL pathname like `/docs/quickstart`)
 * into the output path format used by ParsedPage (`docs/quickstart.mdx`).
 */
function nodePathToOutputPath(nodePath: string): string {
  return nodePath.replace(/^\//, '').replace(/\/+$/, '') + '.mdx';
}

/**
 * Extract the pathname from a URL string.
 */
function pathFromUrl(urlStr: string): string {
  try {
    return new URL(urlStr).pathname;
  } catch {
    return urlStr;
  }
}

/**
 * Find a ParsedPage by pathname, trying several normalization variants.
 */
function findParsedPage(
  index: Map<string, ParsedPage>,
  pathname: string,
): ParsedPage | undefined {
  const norm = pathname.replace(/^\//, '').replace(/\/+$/, '');
  return index.get(norm) ?? index.get(norm + '/index');
}

/**
 * Recursively collect page icons from nav groups into a path→icon map.
 */
function collectPageIcons(
  group: NavGroup,
  iconMap: Map<string, string>,
): void {
  for (const page of group.pages) {
    if (page.icon) {
      iconMap.set(page.path, page.icon);
    }
  }
  if (group.groups) {
    for (const sub of group.groups) {
      collectPageIcons(sub, iconMap);
    }
  }
}

// ── API content rendering helpers ────────────────────────────────────

/**
 * Find the URL path prefix for a space within the site structure.
 *
 * GitBook published URLs use the section path as the URL segment, NOT
 * a combination of section + space paths.  For the default section,
 * pages appear at the site root.
 *
 * For example, if the site basename is `my-docs` and a section path is
 * `documentation`, the published URL is `my-docs/documentation/`.
 * Pages within that space have paths like `basics/editor`, so the full
 * crawled path is `my-docs/documentation/basics/editor`.
 *
 * We use the section path as the prefix.  The default section (Home)
 * gets an empty prefix so its pages appear at root level.
 */
function findSpacePathPrefix(
  structure: GitBookSiteStructure,
  spaceId: string,
): string {
  if (structure.type === 'sections') {
    for (const section of structure.structure) {
      for (const ss of section.siteSpaces) {
        if (ss.space.id === spaceId) {
          // Default section pages appear at the root — no prefix.
          if (section.default) return '';
          return section.path?.replace(/^\//, '').replace(/\/+$/, '') ?? '';
        }
      }
    }
  } else {
    for (const ss of structure.structure) {
      if (ss.space.id === spaceId) {
        return ss.path?.replace(/^\//, '').replace(/\/+$/, '') ?? '';
      }
    }
  }
  return '';
}

/**
 * Recursively walk the API page tree and build ID → path and
 * ID → spaceId maps.
 */
function buildPageIdMap(
  pages: GitBookPage[],
  pathPrefix: string,
  idToPath: Map<string, string>,
  idToSpace: Map<string, string>,
  spaceId: string,
): void {
  for (const page of pages) {
    const pagePath = page.path?.replace(/^\//, '') ?? '';
    const fullPath = [pathPrefix, pagePath].filter(Boolean).join('/');
    idToPath.set(page.id, fullPath);
    idToSpace.set(page.id, spaceId);

    if (page.pages && page.pages.length > 0) {
      buildPageIdMap(page.pages, pathPrefix, idToPath, idToSpace, spaceId);
    }
  }
}

/**
 * Find a page ID by looking up the crawled URL path in the ID-to-path map.
 *
 * Both the crawled path and the map now include the site basename prefix
 * (e.g. `j0nathanb-docs/documentation/basics/editor`).
 * We also handle "readme" landing pages whose published URL omits the
 * trailing `/readme` segment.
 */
function findPageIdByPath(
  idToPath: Map<string, string>,
  urlPath: string,
  _siteBasename?: string,
): string | undefined {
  const normalized = urlPath.replace(/^\//, '').replace(/\/+$/, '');

  // Direct lookup in the map (reverse: find ID by path).
  for (const [id, path] of idToPath) {
    const mapNorm = path.replace(/^\//, '').replace(/\/+$/, '');
    if (mapNorm === normalized) {
      return id;
    }
  }

  // "readme" pages are landing pages — their published URL is just the
  // section path (e.g. `j0nathanb-docs/documentation/`) while the API
  // stores them as `j0nathanb-docs/documentation/readme`.
  const withReadme = normalized ? `${normalized}/readme` : 'readme';
  for (const [id, path] of idToPath) {
    const mapNorm = path.replace(/^\//, '').replace(/\/+$/, '');
    if (mapNorm === withReadme) {
      return id;
    }
  }

  return undefined;
}
