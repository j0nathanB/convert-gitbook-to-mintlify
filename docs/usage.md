# Usage Guide

## Running the tool

There are three ways to run it:

### During development (from this repo)

```bash
# Using tsx (no build step needed)
npx tsx src/cli.ts --source ./my-gitbook-repo --output ./mintlify-docs

# Or build first, then run the compiled JS
npm run build
node dist/cli.js --source ./my-gitbook-repo --output ./mintlify-docs
```

### After publishing to npm (not yet published)

```bash
npx gitbook-to-mintlify --source ./my-gitbook-repo --output ./mintlify-docs
```

---

## Input modes

The tool has four input scenarios depending on what you have access to:

| Scenario | Flags | What you get |
|---|---|---|
| **API + source files** (best) | `--api-token --org-id --site-id --source` | Full structure, branding, and content |
| **API only** | `--api-token --org-id --site-id` | Structure + branding, but content comes from API's JSON doc model (less clean) |
| **Source files only** | `--source` | Content from markdown, but no branding/theme data |
| **Scrape a public site** | `--url https://docs.example.com` | Playwright crawls the live site (slowest, least reliable) |

---

## All CLI options

```
--source <path>        Path to a cloned GitBook repo
--api-token <token>    GitBook API token (from gitbook.com settings)
--org-id <id>          GitBook organization ID
--site-id <id>         GitBook site ID
--url <url>            Public GitBook site URL (triggers Playwright scraper)
--output <path>        Where to write the Mintlify project (required)
--config <path>        Path to a migration.json for overrides
--dry-run              Analyze and report without writing any files
--strict               Error on any unrecognized {% %} block (default: silently pass through)
--no-prompt            Skip interactive branding prompts (logs gaps to report instead)
--verbose              Show debug-level logging
```

---

## Config file (migration.json)

For more control, you can create a `migration.json`:

```json
{
  "tabs": {
    "SUMMARY.md": { "label": "Guides", "slug": "guides" },
    "SUMMARY-api.md": { "label": "API Reference", "slug": "api-reference" }
  },
  "transforms": {
    "flattenSingleChildGroups": true,
    "removeFirstH1": true,
    "codeBlockDefaultLanguage": "bash",
    "normalizeFilenames": true
  },
  "brandingOverrides": {
    "colors": { "primary": "#6C5CE7" }
  },
  "strict": false
}
```

This lets you manually set tab labels (when SUMMARY.md filenames aren't descriptive), override branding values you already know, and control transform behavior.

---

## Typical workflow

1. **Dry run first** to see what you're dealing with:
   ```bash
   npx tsx src/cli.ts --source ./gitbook-repo --output ./out --dry-run --verbose
   ```

2. **Full run** once you're happy:
   ```bash
   npx tsx src/cli.ts --source ./gitbook-repo --output ./out
   ```

3. **Check the migration report** at `./out/_migration/report.json` and `./out/_migration/manual-review.md`

4. **Validate** by running `mintlify dev` inside the output directory to see if it renders correctly
