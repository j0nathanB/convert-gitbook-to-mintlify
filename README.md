# gitbook-to-mintlify

CLI that converts a GitBook site into a Mintlify docs site.

## Quickstart

```bash
npm install
npx gitbook-to-mintlify \
  --api-token <GITBOOK_API_TOKEN> \
  --org-id <ORG_ID> \
  --site-id <SITE_ID> \
  --url https://docs.example.com \
  --output ./mintlify-docs \
  --no-prompt
```

`--output` is the only required flag. Everything else is optional but you'll get the best results by providing API credentials (`--api-token`, `--org-id`, `--site-id`) plus the published `--url`.

Env vars `GITBOOK_API_KEY`, `GITBOOK_ORG_ID`, and `GITBOOK_SITE_ID` work as fallbacks when flags aren't passed.

Other flags: `--source <path>` (local GitBook directory), `--config <path>` (migration.json), `--dry-run`, `--strict`, `--verbose`, `--columns-mode stacked|cards|skip`.

---

## 1. What we built and design choices

**API-first architecture.** The GitBook Content API returns a structured block tree — proprietary JSON, not HTML. We render blocks directly to Mintlify MDX components (`<Card>`, `<Accordion>`, `<CodeGroup>`, `<Tabs>`, `<Update>`, etc.), preserving semantic intent rather than guessing from CSS classes.

**Scraper as supplement.** A Playwright crawl fills gaps the API doesn't expose: layout hints, logos, tab navigation structure. It's not the primary path — it's a fallback and a data source for reconciliation.

**Reconciliation layer.** The API and scraper often disagree on titles, paths, and structure. The reconciler merges both with precedence rules and tracks every discrepancy in a report.

**Navigation mapping.** GitBook sections become Mintlify tabs. Page trees become groups and pages. Single-page tabs auto-detect and get `mode: "center"` (no sidebar). Tab landing pages get `mode: "wide"` (no TOC).

**Why not pandoc.** GitBook's block tree is proprietary JSON. Roundtripping through pandoc or unified loses which block is a "hint" vs a blockquote, a card table vs a regular table. Direct mapping preserves intent.

---

## 2. Branding parity

**Automated:** colors (primary/dark/light), logo (light + dark, with fallback), favicon, font family, footer socials (auto-detected platform), page layout modes derived from GitBook's outline/TOC flags, site name.

**Flagged for manual review** (written to `_migration/manual-review.md`): bold theme tints, sidebar background fills, column layouts with content summaries, OpenAPI rendering differences, color contrast (WCAG AA).

**Falls short:** Mintlify can't show logo + site name text simultaneously. No equivalent for GitBook's tinted header/sidebar. Custom CSS/JS isn't carried over.

---

## 3. What breaks at scale

- **API rate limits.** No public docs on GitBook rate limits. No retry/backoff yet — burst fetching can hit 429s.
- **Scraper bottleneck.** Sequential Playwright crawl with delays. Fine for a one-off migration, painful if you're running 6+ per week.
- **Path collisions.** Parent-page/child-directory same-slug ambiguity. Handled with an `/index` suffix, but may surprise users.
- **Block coverage gaps.** Uncommon block types (drawing, KaTeX, custom integrations) pass through or drop silently. `--strict` surfaces these as errors.
- **OpenAPI multi-operation pages.** GitBook renders N endpoints per page; Mintlify supports 1. Only the first is rendered — the rest need manual splitting.
- **Older GitBook formats.** v1/v2 repos with raw markdown work through `--source` but miss branding entirely.

---

## 4. What we'd improve

- Retry with exponential backoff for API calls
- `SUMMARY.md` ingestion from public GitHub repos (no API key needed)
- Parallel page fetching
- Theme approximation CSS for bold/tinted themes
- Auto-split multi-operation OpenAPI pages
- CI integration (GitHub Action that outputs a preview link)
