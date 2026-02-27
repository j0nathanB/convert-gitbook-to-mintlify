// ─── GitBook API Types ───

export interface GitBookSitePublished {
  site: {
    id: string;
    title: string;
    hostname?: string;
    basename?: string;
    visibility: string;
    urls: { published?: string };
  };
  structure: GitBookSiteStructure;
  customizations: GitBookCustomization;
  scripts?: Array<{ type: string; src: string }>;
}

export type GitBookSiteStructure =
  | { type: 'sections'; structure: GitBookSection[] }
  | { type: 'siteSpaces'; structure: GitBookSiteSpace[] };

export interface GitBookSection {
  object: 'site-section';
  id: string;
  title: string;
  default?: boolean;
  path: string;
  siteSpaces: GitBookSiteSpace[];
}

export interface GitBookSiteSpace {
  object: 'site-space';
  id: string;
  path: string;
  space: {
    id: string;
    title: string;
    urls?: { published?: string };
  };
}

export interface GitBookCustomization {
  title?: string;
  styling?: {
    theme?: string;
    primaryColor?: { light: string; dark: string };
    tint?: { color?: { light: string; dark: string } };
    infoColor?: { light: string; dark: string };
    successColor?: { light: string; dark: string };
    warningColor?: { light: string; dark: string };
    dangerColor?: { light: string; dark: string };
    corners?: string;
    depth?: string;
    links?: string;
    font?: string;
    monospaceFont?: string;
    icons?: string;
    sidebar?: { background?: string; list?: string };
    search?: string;
  };
  favicon?: {
    icon?: { light?: string; dark?: string } | string;
  };
  header?: {
    logo?: { light?: string; dark?: string };
    links?: Array<{
      title: string;
      to: { kind: string; url?: string };
    }>;
  };
  footer?: {
    logo?: { light?: string; dark?: string };
    copyright?: string;
    links?: Array<{
      title: string;
      to: { kind: string; url?: string };
    }>;
  };
  internationalization?: { locale?: string };
}

export interface GitBookPage {
  id: string;
  title: string;
  path: string;
  description?: string;
  hidden?: boolean;
  pages?: GitBookPage[];
}

export interface GitBookFile {
  id: string;
  name: string;
  contentType?: string;
  downloadURL?: string;
}

export interface GitBookOpenAPISpec {
  id: string;
  title?: string;
  slug?: string;
  url?: string;
}

export interface GitBookRedirect {
  source: string;
  destination: string;
}

// ─── Internal Data Model ───

export interface NavTreeNode {
  label: string;
  path?: string;         // relative .md file path (source) or slug (output)
  outputPath?: string;   // final output path in Mintlify
  children: NavTreeNode[];
  isDraft?: boolean;
  isOrphan?: boolean;
  hasContent?: boolean;  // for parent-with-children disambiguation
  sourceFile?: string;   // which SUMMARY.md this came from
}

export interface NavTab {
  label: string;
  slug: string;
  sourceFile?: string;
  groups: NavGroup[];
}

export interface NavGroup {
  label: string;
  pages: NavPage[];
  groups?: NavGroup[];
}

export interface NavPage {
  label: string;
  path: string;
  outputPath?: string;
}

export interface ParsedPage {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  rawBody: string;
  gitbookBlocks: GitBookBlockRef[];
  images: string[];
  internalLinks: string[];
}

export interface GitBookBlockRef {
  type: string;
  style?: string;
  attributes?: Record<string, string>;
  line: number;
}

export interface ImageAsset {
  sourcePath: string;
  referencedIn: string[];
  foundInRepo: boolean;
  foundInApi: boolean;
  apiDownloadUrl?: string;
  targetPath: string;
}

export interface LinkMapping {
  oldPath: string;
  newPath: string;
}

// ─── Block Tokenizer Types ───

export interface BlockToken {
  type: string;
  attributes: Record<string, string>;
  content: string;
  children: BlockToken[];
  raw: string;
  startLine: number;
  endLine: number;
}

// ─── Output Types ───

export interface DocsJson {
  $schema: string;
  theme?: string;
  name?: string;
  logo?: {
    light?: string;
    dark?: string;
  };
  favicon?: string;
  colors?: {
    primary?: string;
    light?: string;
    dark?: string;
    background?: {
      light?: string;
      dark?: string;
    };
  };
  navigation: { tabs: DocsNavTab[] };
  redirects?: Array<{ source: string; destination: string }>;
  footerSocials?: Record<string, string>;
  font?: {
    headings?: { family: string };
    body?: { family: string };
  };
}

export type DocsNavItem = DocsNavTab | DocsNavGroup | string;

export interface DocsNavTab {
  tab: string;
  groups: DocsNavGroup[];
}

export interface DocsNavGroup {
  group: string;
  pages: (string | DocsNavGroup)[];
}

// ─── Migration Report Types ───

export interface MigrationReport {
  stats: {
    totalPages: number;
    imagesCopied: number;
    imagesDownloaded: number;
    linksRewritten: number;
    redirectsPreserved: number;
    blocksConverted: number;
    blocksUnrecognized: number;
  };
  dataSources: {
    api: boolean;
    sourceFiles: boolean;
    scraper: boolean;
  };
  discrepancies: Discrepancy[];
  warnings: MigrationWarning[];
  brandingSource: Record<string, { source: string; confidence?: string }>;
  manualReviewQueue: ManualReviewItem[];
}

export interface Discrepancy {
  type: 'label_mismatch' | 'orphan' | 'missing_in_source' | 'draft';
  path: string;
  details: string;
}

export interface MigrationWarning {
  type: string;
  path?: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ManualReviewItem {
  path: string;
  reason: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── Configuration Types ───

export interface MigrationConfig {
  api: {
    token?: string;
    orgId?: string;
    siteId?: string;
  };
  source?: string;
  url?: string;
  output: string;
  tabs: Record<string, { label: string; slug: string }>;
  scraper: {
    enabled: boolean;
    delayMs: number;
    concurrency: number;
    sidebarExpansionRounds: number;
    authCookie?: string;
    skipPaths: string[];
    selectors: {
      sidebarNav?: string;
      sectionsNav: string;
      mainContent?: string;
      themeContainer?: string;
    };
  };
  transforms: {
    flattenSingleChildGroups: boolean;
    removeFirstH1: boolean;
    codeBlockDefaultLanguage: string;
    normalizeFilenames: boolean;
  };
  brandingOverrides: {
    colors?: Record<string, string>;
    logo?: { light?: string; dark?: string };
    favicon?: string;
    font?: string;
  };
  strict: boolean;
  dryRun: boolean;
  noPrompt: boolean;
}
