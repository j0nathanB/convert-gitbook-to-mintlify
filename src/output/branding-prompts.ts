import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import type { GitBookCustomization } from '../types.js';
import { logger } from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface BrandingResult {
  logo?: { light?: string; dark?: string };
  favicon?: string;
  font?: string;
  primaryColor?: string;
  warnings: string[];
}

// ── Default font that GitBook uses when no custom font is set ────────

const GITBOOK_DEFAULT_FONT = 'ABCFavorit';

// ── WCAG contrast utilities ──────────────────────────────────────────

/**
 * Parse a hex color string (3, 4, 6, or 8 hex digits, with or without
 * leading `#`) into an `[r, g, b]` tuple with values in 0-255.
 *
 * Returns `null` for unparseable input.
 */
function parseHexColor(color: string): [number, number, number] | null {
  let hex = color.replace(/^#/, '');

  // Expand shorthand (e.g. "abc" → "aabbcc", "abcd" → "aabbccdd")
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }

  // Strip alpha channel if present
  if (hex.length === 8) {
    hex = hex.slice(0, 6);
  }

  if (hex.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }

  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * Compute the relative luminance of a color per WCAG 2.1.
 *
 * @see https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Compute the WCAG 2.1 contrast ratio between two colors given as hex
 * strings.
 *
 * Returns a value between 1 (identical) and 21 (black vs white).
 * Returns `0` if either color cannot be parsed.
 */
export function checkContrast(color: string, background: string): number {
  const fg = parseHexColor(color);
  const bg = parseHexColor(background);

  if (!fg || !bg) return 0;

  const lumA = relativeLuminance(...fg);
  const lumB = relativeLuminance(...bg);

  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);

  return (lighter + 0.05) / (darker + 0.05);
}

// ── Prompting logic ──────────────────────────────────────────────────

/**
 * Prompt the user for missing branding values, or silently log gaps
 * when `noPrompt` is true.
 */
export async function promptForBranding(
  customization: GitBookCustomization | null,
  noPrompt: boolean,
): Promise<BrandingResult> {
  const result: BrandingResult = { warnings: [] };

  if (noPrompt) {
    return gatherGaps(customization, result);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // ── Logos ───────────────────────────────────────────────────────
    const lightLogo = customization?.header?.logo?.light;
    const darkLogo = customization?.header?.logo?.dark;

    if (!lightLogo) {
      const answer = await rl.question(
        'No light logo detected. Provide a path or URL (or press Enter to skip): ',
      );
      if (answer.trim()) {
        result.logo = { ...result.logo, light: answer.trim() };
      } else {
        result.warnings.push('No light logo provided');
      }
    }

    if (!darkLogo) {
      const answer = await rl.question(
        'No dark logo detected. Provide a path or URL (or press Enter to skip): ',
      );
      if (answer.trim()) {
        result.logo = { ...result.logo, dark: answer.trim() };
      } else {
        result.warnings.push('No dark logo provided');
      }
    }

    // ── Favicon ────────────────────────────────────────────────────
    const faviconRaw = customization?.favicon?.icon;
    const hasFavicon =
      typeof faviconRaw === 'string'
        ? !!faviconRaw
        : !!(faviconRaw?.light || faviconRaw?.dark);

    if (!hasFavicon) {
      const answer = await rl.question(
        'No favicon detected. Provide a path or URL (or press Enter to skip): ',
      );
      if (answer.trim()) {
        result.favicon = answer.trim();
      } else {
        result.warnings.push('No favicon provided');
      }
    }

    // ── Font ───────────────────────────────────────────────────────
    const currentFont = customization?.styling?.font;
    if (!currentFont || currentFont === GITBOOK_DEFAULT_FONT) {
      const label = currentFont
        ? `Current font is the GitBook default (${GITBOOK_DEFAULT_FONT}).`
        : 'No font detected.';
      const answer = await rl.question(
        `${label} Enter a custom font family (or press Enter to skip): `,
      );
      if (answer.trim()) {
        result.font = answer.trim();
      } else {
        result.warnings.push(
          currentFont
            ? `Using GitBook default font (${GITBOOK_DEFAULT_FONT})`
            : 'No font specified',
        );
      }
    }

    // ── Primary color contrast check ───────────────────────────────
    const primaryColor = customization?.styling?.primaryColor?.light;
    if (primaryColor) {
      result.primaryColor = await checkAndPromptColor(primaryColor, rl, result);
    }
  } finally {
    rl.close();
  }

  return result;
}

// ── Non-interactive gap logging ──────────────────────────────────────

/**
 * When running non-interactively, log all missing branding fields as
 * warnings without prompting.
 */
function gatherGaps(
  customization: GitBookCustomization | null,
  result: BrandingResult,
): BrandingResult {
  if (!customization?.header?.logo?.light) {
    result.warnings.push('No light logo detected');
    logger.warn('Branding gap: no light logo');
  }
  if (!customization?.header?.logo?.dark) {
    result.warnings.push('No dark logo detected');
    logger.warn('Branding gap: no dark logo');
  }

  const faviconRaw = customization?.favicon?.icon;
  const hasFavicon =
    typeof faviconRaw === 'string'
      ? !!faviconRaw
      : !!(faviconRaw?.light || faviconRaw?.dark);
  if (!hasFavicon) {
    result.warnings.push('No favicon detected');
    logger.warn('Branding gap: no favicon');
  }

  const font = customization?.styling?.font;
  if (!font || font === GITBOOK_DEFAULT_FONT) {
    result.warnings.push(
      font
        ? `Using GitBook default font (${GITBOOK_DEFAULT_FONT})`
        : 'No font specified',
    );
    logger.warn(`Branding gap: ${font ? 'using default font' : 'no font specified'}`);
  }

  const primaryColor = customization?.styling?.primaryColor?.light;
  if (primaryColor) {
    const contrastWhite = checkContrast(primaryColor, '#ffffff');
    const contrastBlack = checkContrast(primaryColor, '#000000');
    if (contrastWhite < 4.5 && contrastBlack < 4.5) {
      const msg =
        `Primary color ${primaryColor} has low WCAG contrast ` +
        `(${contrastWhite.toFixed(2)}:1 on white, ${contrastBlack.toFixed(2)}:1 on black)`;
      result.warnings.push(msg);
      logger.warn(msg);
    }
  }

  return result;
}

// ── Color contrast prompt ────────────────────────────────────────────

/**
 * Check the WCAG contrast ratio of the given primary color against
 * white and black backgrounds. If it fails AA (< 4.5:1 on both),
 * warn the user and prompt for an adjusted color.
 */
async function checkAndPromptColor(
  color: string,
  rl: { question(prompt: string): Promise<string> },
  result: BrandingResult,
): Promise<string> {
  const contrastWhite = checkContrast(color, '#ffffff');
  const contrastBlack = checkContrast(color, '#000000');

  if (contrastWhite >= 4.5 || contrastBlack >= 4.5) {
    // Passes AA on at least one background
    return color;
  }

  const msg =
    `Primary color ${color} has low WCAG contrast ` +
    `(${contrastWhite.toFixed(2)}:1 on white, ${contrastBlack.toFixed(2)}:1 on black).`;
  logger.warn(msg);

  const answer = await rl.question(
    `${msg} Enter an adjusted hex color (or press Enter to keep ${color}): `,
  );

  if (answer.trim()) {
    const adjusted = answer.trim().startsWith('#')
      ? answer.trim()
      : `#${answer.trim()}`;

    // Validate the replacement
    const newWhite = checkContrast(adjusted, '#ffffff');
    const newBlack = checkContrast(adjusted, '#000000');
    if (newWhite < 4.5 && newBlack < 4.5) {
      result.warnings.push(
        `Adjusted color ${adjusted} still has low WCAG contrast (${newWhite.toFixed(2)}:1 on white, ${newBlack.toFixed(2)}:1 on black)`,
      );
    }
    return adjusted;
  }

  result.warnings.push(msg);
  return color;
}
