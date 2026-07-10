# AlpaCrawl

AlpaCrawl crawls a site and its inner pages using [Puppeteer](https://github.com/puppeteer/puppeteer), extracts content via CSS selector, sends it to a local [LM Studio](https://lmstudio.ai/) model to generate question–answer pairs, and saves the results as [Alpaca-format](https://github.com/tatsu-lab/stanford_alpaca) JSON training data.

## Requirements

- Node.js
- An OpenAI-compatible API (such as [LM Studio](https://lmstudio.ai/) running locally, Ollama, DeepSeek, OpenAI, Groq, Together, etc.)
- Dependencies installed: `npm install`

## Setup

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Edit `.env` to configure your API endpoint. You can use either LM Studio or any OpenAI-compatible API.

### Local LM Studio (Default)

```env
LM_STUDIO_URL=http://localhost:1234/v1/chat/completions
LM_STUDIO_MODEL=qwythos-9b-claude-mythos-5-1m
```

### OpenAI Compatible APIs (OpenAI, DeepSeek, Ollama, Groq, Together, etc.)

For standard OpenAI-compatible APIs, define the environment variables:

```env
OPENAI_BASE_URL=https://api.openai.com/v1
# or e.g., https://api.deepseek.com, http://localhost:11434, or https://api.groq.com/openai/v1
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-4o
```

> [!NOTE]
> If `OPENAI_BASE_URL` is set and does not end with `/chat/completions`, AlpaCrawl will automatically resolve and append the correct endpoint format.

## Usage

```
node crawl.js <startUrl> <selector> [maxDepth] [options]
```

- `startUrl` — where to start crawling, e.g. `https://docs.example.com/`
- `selector` — CSS selector for the content root to extract, e.g. `main`, `#content`, `.article-body`
- `maxDepth` — how many link-hops to follow from the start URL. Omit for unlimited.

### Examples

Crawl an entire docs site and generate training data:

```
node crawl.js https://abc.com/docs main
```

Only crawl pages under `/docs`:

```
node crawl.js https://abc.com/docs main --include-prefix /docs
```

Preview which URLs would be crawled (no files written, no AI calls):

```
node crawl.js https://abc.com/docs main --dry-run --verbose
```

Crawl only two levels deep, ten pages at a time:

```
node crawl.js https://abc.com/docs main 2 --concurrency 10
```

Only merge existing JSON files in output directory without crawling:

```
node crawl.js --merge-only
```

Or merge files in a custom output directory:

```
node crawl.js --merge-only --out my-custom-output
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--out`, `-o` | `output` | Output directory for JSON files |
| `--concurrency` | `3` | Number of pages processed in parallel |
| `--same-origin` | `true` | Restrict the crawl to the start URL's origin |
| `--include-prefix` | none | Only follow links whose path starts with this prefix (e.g. `/docs`) |
| `--delay` | `0` | Delay in ms before each navigation (per worker) |
| `--timeout` | `30000` | Per-page navigation timeout in ms |
| `--wait-for` | none | Extra CSS selector to wait for, or a number of ms to wait, before extracting |
| `--max-pages` | `2000` | Safety cap on total pages visited |
| `--system-prompt` | built-in | Override the system prompt sent to the AI model for Q&A generation |
| `--dry-run` | `false` | Crawl and log URLs without writing files or calling the AI model |
| `--merge-only` | `false` | Skip crawling and only merge the existing JSON files in the output directory |
| `--verbose` | `false` | Print the reason for every skipped/failed URL |

## How it works

1. Starting from `startUrl`, each page is loaded in a headless browser.
2. The selector's content is cloned and cleaned (scripts, styles, comments, and `class`/`id`/`style`/`on*`/`data-*`/`aria-*` attributes are stripped; relative `href`/`src` are resolved to absolute URLs).
3. The cleaned HTML is sent to the configured AI model with a system prompt instructing it to generate Alpaca-format Q&A pairs.
4. The resulting pairs are **saved to disk immediately** as a JSON file — a crash partway through the crawl still leaves you with every page processed up to that point.
5. Links found on the page are queued for crawling if they pass the `--same-origin` / `--include-prefix` / depth / `--max-pages` filters.
6. Once the whole crawl finishes, a final merge pass reads every JSON file and compiles all Q&A pairs into a single `_alpaca_dataset.json` file.

Pages where the selector isn't found are skipped (but their links are still followed, since the page may lead to pages that do have it).

If the AI model fails to generate valid Q&A pairs for a page (after 3 retries), that page is logged as failed and the crawl continues.

## Output format

### Flat file naming

All files are saved directly in the output directory (no subdirectories). Path segments from the URL are joined with dots:

- `https://abc.com/docs/getting-started` → `output/docs.getting-started.json`
- `https://abc.com/` → `output/index.json`

Colliding filenames are disambiguated with a `-2`, `-3`, ... suffix.

### Per-page JSON

Each page produces a JSON file with:

```json
{
  "source_url": "https://abc.com/docs/getting-started",
  "title": "Getting Started",
  "pairs": [
    {
      "instruction": "What is the first step to get started?",
      "input": "",
      "output": "The first step is to ..."
    }
  ]
}
```

### Merged dataset

After the crawl, `_alpaca_dataset.json` contains a flat array of all pairs:

```json
[
  { "instruction": "...", "input": "", "output": "..." },
  { "instruction": "...", "input": "", "output": "..." }
]
```

This file is ready to use as training data for fine-tuning.

## Summary output

At the end of a run you'll see counts of saved/skipped/failed pages plus the total merged pair count. Pass `--verbose` to also print the reason each skipped or failed URL was excluded.
