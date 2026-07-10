#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const puppeteer = require('puppeteer');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are a training-data generator. You will be given the text content of a web page.
Your job is to produce high-quality question–answer pairs from the information in the text.

Rules:
- Output ONLY a JSON array. No markdown fences, no explanations, no extra text.
- Each element must have exactly three keys: "instruction", "input", and "output".
- "instruction" is a clear, self-contained question or task derived from the text.
- "input" should be an empty string "".
- "output" is a thorough, accurate answer drawn directly from the text.
- Generate as many pairs as the content supports (aim for 50 per page).
- Do NOT fabricate information that isn't in the source text.
- IMPORTANT: Pay special attention to CODE BLOCKS and CODE EXAMPLES in the content.
  For each code block, generate at least one Q&A pair that:
  - Asks what the code does, how to use it, or when to use it.
  - Includes the FULL code snippet in the "output" field, properly formatted.
  - Mentions the programming language and filename if available.
- For configuration files, generate pairs asking "How do you configure X?" with the config code in the answer.
- For component/template examples, generate pairs asking "How do you implement X?" with the full code.

Example of valid output:
[{"instruction":"What is X?","input":"","output":"X is ..."},{"instruction":"How do you implement Y in Vue?","input":"","output":"To implement Y, use the following code in your .vue file:\\n<template>...</template>"}]`;

const argv = yargs(hideBin(process.argv))
  .usage('$0 [startUrl] [selector] [maxDepth]')
  .command('$0 [startUrl] [selector] [maxDepth]', 'Crawl a site and generate Alpaca-format Q&A training data from every page', (y) => {
    y.positional('startUrl', { type: 'string', describe: 'Starting URL, e.g. https://docs.example.com/' })
      .positional('selector', { type: 'string', describe: 'CSS selector for the content root, e.g. "main", "#content", ".article-body"' })
      .positional('maxDepth', { type: 'number', describe: 'Max link-follow depth. Omit for unlimited.' });
  })
  .option('out', { alias: 'o', type: 'string', default: 'output', describe: 'Output directory' })
  .option('concurrency', { type: 'number', default: 3, describe: 'Number of pages processed in parallel' })
  .option('same-origin', { type: 'boolean', default: true, describe: 'Restrict crawl to the start URL origin' })
  .option('include-prefix', { type: 'string', default: null, describe: 'Only follow links whose path starts with this prefix' })
  .option('delay', { type: 'number', default: 0, describe: 'Delay in ms before each navigation (per worker)' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Per-page navigation timeout in ms' })
  .option('wait-for', { type: 'string', default: null, describe: 'Extra selector to wait for, or a number of ms to wait, before extracting' })
  .option('max-pages', { type: 'number', default: 2000, describe: 'Safety cap on total pages visited' })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Crawl and log URLs without writing files or calling AI' })
  .option('skip-existing', { type: 'boolean', default: false, describe: 'Skip a URL if its output file already exists in the output directory' })
  .option('save-failed', { type: 'boolean', default: true, describe: 'Save raw model output for failed AI requests to <out>/failed/ (use --no-save-failed to disable)' })
  .option('merge-only', { type: 'boolean', default: false, describe: 'Skip crawling and only merge the existing JSON files in the output directory' })
  .option('verbose', { type: 'boolean', default: false })
  .option('system-prompt', { type: 'string', default: null, describe: 'Override the default system prompt sent to LM Studio' })
  .strict()
  .check((argv) => {
    if (argv['merge-only']) {
      return true;
    }
    if (!argv.startUrl || !argv.selector) {
      throw new Error('Missing required arguments: <startUrl> and <selector> are required unless running with --merge-only');
    }
    return true;
  })
  .help()
  .parse();

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function sanitizeSegment(seg) {
  const cleaned = decodeURIComponent(seg)
    .replace(/[^a-zA-Z0-9\-_.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'page';
}

/**
 * Convert a URL to a flat filename using dots as directory separators.
 *   https://abc.com/docs/getting-started → docs.getting-started.json
 *   https://abc.com/                     → index.json
 */
function urlToFlatFilename(normalizedUrl) {
  const u = new URL(normalizedUrl);
  const rawSegments = u.pathname.split('/').filter(Boolean);
  let segments = rawSegments.map(sanitizeSegment);

  if (segments.length === 0) {
    let fileName = 'index';
    if (u.search) {
      const q = sanitizeSegment(u.search.replace(/^\?/, ''));
      fileName += `__${q}`;
    }
    return `${fileName}.json`;
  }

  // Strip file extensions from the last segment
  const last = segments[segments.length - 1];
  if (/\.[a-z0-9]+$/i.test(last)) {
    segments[segments.length - 1] = last.replace(/\.[a-z0-9]+$/i, '');
  }

  let fileName = segments.join('.');

  if (u.search) {
    const q = sanitizeSegment(u.search.replace(/^\?/, ''));
    fileName += `__${q}`;
  }

  return `${fileName}.json`;
}

function pathStartsWith(pathname, prefix) {
  const norm = prefix.replace(/\/+$/, '') || '/';
  return pathname === norm || pathname.startsWith(`${norm}/`);
}

function dedupeFilename(filename, usedPaths) {
  if (!usedPaths.has(filename)) return filename;
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let i = 2;
  let candidate;
  do {
    candidate = `${base}-${i}${ext}`;
    i += 1;
  } while (usedPaths.has(candidate));
  return candidate;
}

// ---------------------------------------------------------------------------
// In-browser extraction + cleanup (runs inside the page context)
// ---------------------------------------------------------------------------

function extractAndClean(selector) {
  const REMOVE_TAGS = ['script', 'style', 'noscript', 'template'];
  const STRIP_ATTR_EXACT = new Set(['class', 'id', 'style']);
  const STRIP_ATTR_PREFIX = ['on', 'data-', 'aria-'];

  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => a.href)
    .filter(Boolean);

  const root = document.querySelector(selector);
  if (!root) {
    return { found: false, html: null, text: null, codeBlocks: [], title: document.title, links };
  }

  const clone = root.cloneNode(true);

  REMOVE_TAGS.forEach((tag) => {
    clone.querySelectorAll(tag).forEach((el) => el.remove());
  });

  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments = [];
  let n = walker.nextNode();
  while (n) {
    comments.push(n);
    n = walker.nextNode();
  }
  comments.forEach((c) => c.remove());

  // ---------------------------------------------------------------------------
  // Extract code blocks BEFORE stripping attributes (we need class for language)
  // ---------------------------------------------------------------------------
  const codeBlocks = [];
  clone.querySelectorAll('pre').forEach((pre, idx) => {
    const codeEl = pre.querySelector('code') || pre;
    const code = codeEl.textContent.trim();
    if (!code) return;

    // Try to detect language from class names (e.g. "language-vue", "lang-ts")
    let lang = '';
    const classes = (codeEl.getAttribute('class') || '') + ' ' + (pre.getAttribute('class') || '');
    const langMatch = classes.match(/(?:language|lang)-([\w#+]+)/i);
    if (langMatch) lang = langMatch[1];

    // Try to find a filename hint from nearby elements or data attributes
    let filename = pre.getAttribute('data-filename') || '';
    if (!filename) {
      // Check for a filename in a sibling or parent label
      const parent = pre.parentElement;
      if (parent) {
        const label = parent.querySelector('[class*="filename"], [class*="file-name"], [class*="title"]');
        if (label && label.textContent.length < 100) {
          filename = label.textContent.trim();
        }
      }
    }

    codeBlocks.push({ lang, filename, code, index: idx });

    // Replace the <pre> block with a placeholder so we can reconstruct
    // the content with clear code block markers
    const placeholder = document.createElement('div');
    placeholder.setAttribute('data-code-block-index', String(idx));
    placeholder.textContent = `[CODE_BLOCK_${idx}]`;
    pre.replaceWith(placeholder);
  });

  // Resolve relative href/src to absolute URLs before we lose document context.
  clone.querySelectorAll('[href]').forEach((el) => {
    const abs = el.href;
    if (abs) el.setAttribute('href', abs);
  });
  clone.querySelectorAll('[src]').forEach((el) => {
    const abs = el.src;
    if (abs) el.setAttribute('src', abs);
  });
  clone.querySelectorAll('[srcset]').forEach((el) => el.removeAttribute('srcset'));

  clone.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name === 'href' || name === 'src') return;
      if (STRIP_ATTR_EXACT.has(name) || STRIP_ATTR_PREFIX.some((p) => name.startsWith(p))) {
        el.removeAttribute(attr.name);
      }
    });
  });

  // Get the text content (cleaner for the model than raw HTML)
  const text = clone.innerText || clone.textContent || '';

  return { found: true, html: clone.innerHTML, text, codeBlocks, title: document.title, links };
}

// ---------------------------------------------------------------------------
// Content formatting for model input
// ---------------------------------------------------------------------------

/**
 * Build a structured message that separates prose from code blocks,
 * making it much easier for smaller models to generate Q&A pairs for both.
 */
function formatContentForModel(extracted, url) {
  const { text, codeBlocks, title } = extracted;

  // Clean up the text: remove the [CODE_BLOCK_N] placeholders and collapse whitespace
  let prose = (text || '')
    .replace(/\[CODE_BLOCK_\d+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const parts = [];
  parts.push(`Page: ${url}`);
  if (title) parts.push(`Title: ${title}`);
  parts.push('');
  parts.push('=== PAGE CONTENT ===');
  parts.push(prose);

  if (codeBlocks.length > 0) {
    parts.push('');
    parts.push('=== CODE EXAMPLES ===');
    parts.push(`This page contains ${codeBlocks.length} code example(s). Generate Q&A pairs for each.`);
    parts.push('');

    for (const block of codeBlocks) {
      const label = [
        block.filename ? `File: ${block.filename}` : null,
        block.lang ? `Language: ${block.lang}` : null,
      ].filter(Boolean).join(' | ');

      parts.push(`--- Code Example ${block.index + 1}${label ? ` (${label})` : ''} ---`);
      parts.push('```' + (block.lang || ''));
      parts.push(block.code);
      parts.push('```');
      parts.push('');
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// LM Studio integration
// ---------------------------------------------------------------------------

/**
 * Try to extract a JSON array from messy model output.
 * Uses multiple strategies, from strict to permissive.
 */
function extractJsonArray(raw) {
  const trimmed = raw.trim();

  // Strategy 1: Strip markdown code fences (```json ... ``` or ``` ... ```)
  // Use a greedy match to handle multiple fences — take the largest block.
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let bestFenceContent = null;
  let match;
  while ((match = fenceRe.exec(trimmed)) !== null) {
    const inner = match[1].trim();
    if (inner.startsWith('[') || inner.startsWith('{')) {
      bestFenceContent = inner;
      break; // prefer the first JSON-looking fence
    }
  }

  const candidate = bestFenceContent || trimmed;

  // Strategy 2: Find the outermost [ ... ] bracket pair
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    const slice = candidate.slice(arrayStart, arrayEnd + 1);

    // We try to repair common issues (e.g. duplicate key overwrite issues, bad escapes, object separator transitions)
    // before the first parse to ensure we don't silently lose data.
    let fixed = slice;
    try {
      fixed = tryRepairJsonArrayString(slice);
      fixed = fixed.replace(/,\s*([\]}])/g, '$1');       // trailing commas
    } catch {
      // ignore repair failure, fall back to slice
    }

    try {
      const parsed = JSON.parse(fixed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // If the repaired version fails, try parsing raw slice as fallback
      try {
        const parsed = JSON.parse(slice);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through
      }
    }
  }

  // Strategy 4: Direct parse of the whole candidate
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) return parsed;
    // If the model returned a single object, wrap it
    if (parsed && typeof parsed === 'object' && parsed.instruction) return [parsed];
  } catch {
    // fall through
  }

  // Strategy 5: Truncation repair — model output was cut off mid-JSON
  // Find the start of the array and try to salvage complete objects.
  if (arrayStart !== -1) {
    let truncated = candidate.slice(arrayStart);
    try {
      truncated = tryRepairJsonArrayString(truncated);
    } catch {
      // ignore repair failure, fall back to parsing raw truncated
    }
    const repaired = repairTruncatedJsonArray(truncated);
    if (repaired) return repaired;
  }

  return null; // could not extract
}

/**
 * Attempt to salvage a truncated JSON array by finding all complete objects
 * and discarding any trailing incomplete object.
 */
function repairTruncatedJsonArray(truncated) {
  // Walk through looking for complete top-level objects inside the array
  if (!truncated.startsWith('[')) return null;

  const objects = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;

  for (let i = 1; i < truncated.length; i++) {
    const ch = truncated[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = truncated.slice(objStart, i + 1);
        try {
          const cleanedObjStr = objStr.replace(/,\s*([\]}])/g, '$1');
          const obj = JSON.parse(cleanedObjStr);
          if (obj && typeof obj === 'object') objects.push(obj);
        } catch {
          // malformed object, skip
        }
        objStart = -1;
      }
    }
  }

  return objects.length > 0 ? objects : null;
}

/**
 * Scan a JSON string to escape raw newlines (\n) that appear inside string values.
 * Structural newlines outside string values are left intact.
 */
function escapeNewlinesInStrings(str) {
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      result += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (ch === '\n') {
      if (inString) {
        result += '\\n';
      } else {
        result += ch;
      }
      continue;
    }

    result += ch;
  }

  return result;
}

/**
 * Attempt to repair common formatting errors in JSON arrays from models.
 * Handles invalid escapes (\', \`), unescaped newlines in strings, and malformed object boundaries.
 */
function tryRepairJsonArrayString(slice) {
  // 1. Remove invalid escapes like \' or \` that models generate
  let fixed = slice
    .replace(/\\'/g, "'")
    .replace(/\\`/g, "`");

  // 2. Escape raw newlines inside JSON string values
  fixed = escapeNewlinesInStrings(fixed);

  // 3. Fix missing/extra braces or commas between objects.
  // Transition from "output" string ending to the next "instruction" key name.
  fixed = fixed.replace(/("output"\s*:\s*"(?:[^"\\]|\\.)*")\s*[^"]*?\s*"instruction"\s*:\s*/g, '$1},{"instruction":');

  return fixed;
}

function saveFailedRawOutput(url, attempt, rawContent, ctx) {
  try {
    const failedDir = path.join(ctx.outDir, 'failed');
    fs.mkdirSync(failedDir, { recursive: true });
    const slug = urlToFlatFilename(normalizeUrl(url) || url).replace(/\.json$/, '');
    const filename = `${slug}.try${attempt}.txt`;
    const header = `URL: ${url}\nAttempt: ${attempt}\nTimestamp: ${new Date().toISOString()}\n${'─'.repeat(80)}\n\n`;
    fs.writeFileSync(path.join(failedDir, filename), header + rawContent, 'utf8');
    console.error(`  [failed] raw output saved -> failed/${filename}`);
  } catch (saveErr) {
    console.error(`  [failed] could not save raw output: ${saveErr.message}`);
  }
}

function customFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      signal: options.signal,
    };

    const req = lib.request(url, reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const textContent = buffer.toString('utf8');

        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          text: async () => textContent,
          json: async () => JSON.parse(textContent),
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function getApiConfig() {
  const envUrl = process.env.LM_STUDIO_URL || process.env.OPENAI_BASE_URL;
  let url = envUrl || 'http://localhost:1234/v1/chat/completions';

  if (envUrl) {
    if (!url.includes('/chat/completions')) {
      const trimmed = url.replace(/\/+$/, '');
      if (!trimmed.endsWith('/v1') && !trimmed.includes('/v1/')) {
        url = `${trimmed}/v1/chat/completions`;
      } else {
        url = `${trimmed}/chat/completions`;
      }
    }
  }

  const model = process.env.LM_STUDIO_MODEL || process.env.OPENAI_MODEL || 'qwythos-9b-claude-mythos-5-1m';
  const apiKey = process.env.LM_STUDIO_API_KEY || process.env.OPENAI_API_KEY;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return { url, model, headers };
}

async function generateQAPairs(extracted, url, ctx) {
  const { url: lmUrl, model: lmModel, headers: apiHeaders } = getApiConfig();
  const systemPrompt = ctx.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const fetchTimeout = Number(process.env.LM_FETCH_TIMEOUT) || 6000000000;

  const userMessage = formatContentForModel(extracted, url);

  const MAX_RETRIES = 3;
  let lastRawContent = null; // keep track for retry nudge

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeout);

    try {
      // Build messages — on retries after a bad format, add a nudge
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

      if (attempt > 1 && lastRawContent) {
        messages.push(
          { role: 'assistant', content: lastRawContent },
          {
            role: 'user',
            content:
              'Your previous response was not valid JSON. Please respond with ONLY a JSON array ' +
              'of objects, each with keys "instruction", "input", and "output". ' +
              'No markdown, no explanation, no code fences — just the raw JSON array starting with [ and ending with ].',
          },
        );
      }

      const response = await customFetch(lmUrl, {
        method: 'POST',
        headers: apiHeaders,
        signal: controller.signal,
        body: JSON.stringify({
          model: lmModel,
          messages,
          temperature: attempt === 1 ? 0.3 : 0.1, // lower temp on retries
          max_tokens: 128000,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown');
        lastRawContent = `[HTTP ${response.status}]\n${errText}`;
        throw new Error(`API returned ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content || content.trim().length === 0) {
        // API sometimes returns empty content when overloaded; wait longer before retry
        lastRawContent = lastRawContent || '[empty response from API]';
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        throw new Error('Empty response from API');
      }

      lastRawContent = content;

      const pairs = extractJsonArray(content);

      if (!pairs) {
        // Show a snippet of what the model actually returned
        const preview = content.length > 120 ? content.slice(0, 120) + '…' : content;
        throw new Error(`Model returned non-JSON output: "${preview}"`);
      }

      // Validate each pair has the required fields
      const validated = pairs
        .filter((p) => p && typeof p.instruction === 'string' && typeof p.output === 'string')
        .map((p) => ({
          instruction: p.instruction,
          input: typeof p.input === 'string' ? p.input : '',
          output: p.output,
        }));

      if (validated.length === 0) {
        throw new Error('No valid Q&A pairs found in LM Studio response');
      }

      return validated;
    } catch (err) {
      // Translate AbortError to a clearer message
      let message =
        err.name === 'AbortError'
          ? `LM Studio request timed out after ${fetchTimeout}ms`
          : err.message;

      if (err.cause) {
        const causeMsg = err.cause.message || err.cause.code || String(err.cause);
        message += ` (cause: ${causeMsg})`;
      }

      if (ctx.saveFailed) {
        const toSave = lastRawContent || `[no model output]\nError: ${message}`;
        saveFailedRawOutput(url, attempt, toSave, ctx);
      }

      if (attempt < MAX_RETRIES) {
        console.warn(`  [retry ${attempt}/${MAX_RETRIES}] ${url}: ${message}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } else {
        throw new Error(message);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

async function processUrl(browser, item, ctx) {
  const { url, depth } = item;
  if (ctx.delay) await new Promise((r) => setTimeout(r, ctx.delay));

  const page = await browser.newPage();
  try {
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle2', timeout: ctx.timeout });
    } catch (err) {
      ctx.failed.push({ url, depth, reason: `navigation error: ${err.message}` });
      console.error(`[depth ${depth}] [nav-fail] ${url}: ${err.message}`);
      return;
    }
    if (!response || !response.ok()) {
      ctx.failed.push({ url, depth, reason: `bad response: ${response ? response.status() : 'none'}` });
      console.error(`[depth ${depth}] [nav-fail] ${url}: HTTP ${response ? response.status() : 'no response'}`);
      return;
    }

    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('text/html')) {
      ctx.skipped.push({ url, depth, reason: `non-html content-type: ${contentType}` });
      return;
    }

    if (ctx.waitFor) {
      if (/^\d+$/.test(ctx.waitFor)) {
        await new Promise((r) => setTimeout(r, Number(ctx.waitFor)));
      } else {
        await page.waitForSelector(ctx.waitFor, { timeout: ctx.timeout }).catch(() => { });
      }
    }

    const selectorFound = await page
      .waitForSelector(ctx.selector, { timeout: Math.min(ctx.timeout, 10000) })
      .then(() => true)
      .catch(() => false);

    const extracted = await page.evaluate(extractAndClean, ctx.selector);

    // Enqueue links regardless of whether the target selector was found,
    // since the page still loaded and may lead to pages that have it.
    if (depth < ctx.maxDepth) {
      for (const rawLink of extracted.links) {
        const norm = normalizeUrl(rawLink);
        if (!norm) continue;
        const u = new URL(norm);
        if (!/^https?:$/.test(u.protocol)) continue;
        if (ctx.sameOrigin && u.origin !== ctx.startOrigin) continue;
        if (ctx.includePrefix && !pathStartsWith(u.pathname, ctx.includePrefix)) continue;
        if (ctx.visited.has(norm) || ctx.queued.has(norm)) continue;
        if (ctx.visited.size + ctx.queued.size >= ctx.maxPages) continue;
        ctx.queued.add(norm);
        ctx.queue.push({ url: norm, depth: depth + 1 });
      }
    }

    if (!selectorFound || !extracted.found) {
      ctx.skipped.push({ url, depth, reason: 'selector not found on page' });
      return;
    }

    const normalized = normalizeUrl(url) || url;
    // Compute the raw filename first (before deduplication)
    const rawFilename = urlToFlatFilename(normalized);
    const rawPath = path.join(ctx.outDir, rawFilename);

    // Skip-existing check: compare against the raw (non-deduplicated) filename so
    // that pre-loaded usedPaths entries don't rename it to e.g. foo-2.json and
    // bypass the existsSync check entirely.
    if (ctx.skipExisting && fs.existsSync(rawPath)) {
      // Still register it in usedPaths so deduplication works for other URLs
      ctx.usedPaths.add(rawFilename);
      ctx.skipped.push({ url, depth, reason: 'output file already exists (--skip-existing)' });
      console.log(`[depth ${depth}] skipped (exists): ${url} -> ${rawFilename}`);
      return;
    }

    let filename = dedupeFilename(rawFilename, ctx.usedPaths);
    ctx.usedPaths.add(filename);
    const fullPath = path.join(ctx.outDir, filename);

    ctx.results.set(normalized, { title: extracted.title, depth, filename });

    if (ctx.dryRun) {
      console.log(`[depth ${depth}] would save: ${url} -> ${filename}`);
      return;
    }

    // Send to LM Studio and save the result
    let pairs;
    try {
      pairs = await generateQAPairs(extracted, url, ctx);
    } catch (err) {
      console.error(`[depth ${depth}] AI failed: ${url} (${err.message})`);
      ctx.failed.push({ url, depth, reason: `AI generation failed: ${err.message}` });
      return;
    }

    const jsonData = {
      source_url: url,
      title: extracted.title || '',
      pairs,
    };

    fs.mkdirSync(ctx.outDir, { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(jsonData, null, 2), 'utf8');

    console.log(`[depth ${depth}] saved: ${url} -> ${filename} (${pairs.length} pairs)`);
  } finally {
    await page.close();
  }
}

async function runCrawl(ctx) {
  const browser = await puppeteer.launch({ headless: true });
  try {
    let active = 0;

    async function worker() {
      for (; ;) {
        if (ctx.queue.length === 0) {
          if (active === 0) return;
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        const item = ctx.queue.shift();
        if (!item) continue;
        if (ctx.visited.has(item.url)) continue;
        if (ctx.visited.size >= ctx.maxPages) continue;
        ctx.visited.add(item.url);
        active += 1;
        try {
          await processUrl(browser, item, ctx);
        } catch (err) {
          ctx.failed.push({ url: item.url, depth: item.depth, reason: err.message });
        } finally {
          active -= 1;
        }
      }
    }

    const workers = Array.from({ length: ctx.concurrency }, () => worker());
    await Promise.all(workers);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Post-processing: merge all JSON files into a single Alpaca dataset
// ---------------------------------------------------------------------------

function mergeAlpacaDataset(outDir) {
  const allPairs = [];
  let fileCount = 0;

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json') && f !== '_alpaca_dataset.json');

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(outDir, file), 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.pairs)) {
        allPairs.push(...data.pairs);
        fileCount += 1;
      }
    } catch (err) {
      console.warn(`  [merge] skipped ${file}: ${err.message}`);
    }
  }

  const mergedPath = path.join(outDir, '_alpaca_dataset.json');
  fs.writeFileSync(mergedPath, JSON.stringify(allPairs, null, 2), 'utf8');

  return { fileCount, pairCount: allPairs.length, mergedPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Pre-populate usedPaths with filenames already in the output directory
 * so dedupeFilename() won't collide with existing files.
 */
function preloadExistingFilenames(outDir) {
  const set = new Set();
  try {
    const entries = fs.readdirSync(outDir);
    for (const entry of entries) {
      if (entry.endsWith('.json')) set.add(entry);
    }
  } catch {
    // Directory doesn't exist yet — that's fine
  }
  return set;
}

async function main() {
  if (argv['merge-only']) {
    console.log(`\nRunning in merge-only mode. Skipping crawl...`);
    console.log(`Merging all Q&A pairs in directory: ${argv.out}`);
    const { fileCount, pairCount, mergedPath } = mergeAlpacaDataset(argv.out);
    console.log(`Merged ${pairCount} pairs from ${fileCount} files -> ${path.resolve(mergedPath)}`);
    return;
  }

  const startUrl = normalizeUrl(argv.startUrl);
  if (!startUrl) {
    console.error(`Invalid startUrl: ${argv.startUrl}`);
    process.exit(1);
  }
  const startOrigin = new URL(startUrl).origin;

  // Validate API config (unless dry run)
  if (!argv.dryRun) {
    const { url, model } = getApiConfig();
    console.log(`API Endpoint: ${url} (model: ${model})`);
  }

  const ctx = {
    selector: argv.selector,
    maxDepth: argv.maxDepth === undefined ? Infinity : argv.maxDepth,
    maxPages: argv.maxPages,
    concurrency: Math.max(1, argv.concurrency),
    sameOrigin: argv.sameOrigin,
    includePrefix: argv.includePrefix,
    delay: argv.delay,
    timeout: argv.timeout,
    waitFor: argv.waitFor,
    startOrigin,
    outDir: argv.out,
    dryRun: argv.dryRun,
    skipExisting: argv.skipExisting,
    saveFailed: argv.saveFailed,
    systemPrompt: argv.systemPrompt,
    queue: [{ url: startUrl, depth: 0 }],
    queued: new Set([startUrl]),
    visited: new Set(),
    usedPaths: preloadExistingFilenames(argv.out),
    results: new Map(),
    skipped: [],
    failed: [],
  };

  console.log(`Starting crawl at ${startUrl}`);
  console.log(`Selector: ${ctx.selector} | Max depth: ${ctx.maxDepth === Infinity ? 'unlimited' : ctx.maxDepth} | Concurrency: ${ctx.concurrency} | Save-failed: ${ctx.saveFailed}`);

  await runCrawl(ctx);

  console.log('\nCrawl finished.');
  console.log(`  Saved:   ${ctx.results.size}`);
  console.log(`  Skipped: ${ctx.skipped.length}`);
  console.log(`  Failed:  ${ctx.failed.length}`);

  if (argv.verbose) {
    ctx.skipped.forEach((s) => console.log(`  [skip] ${s.url} (${s.reason})`));
    ctx.failed.forEach((f) => console.log(`  [fail] ${f.url} (${f.reason})`));
  }

  if (ctx.dryRun) {
    console.log('\nDry run — no files written, no AI calls made.');
    return;
  }

  // Merge all individual JSON files into a single Alpaca dataset
  console.log('\nMerging all Q&A pairs into a single dataset...');
  const { fileCount, pairCount, mergedPath } = mergeAlpacaDataset(ctx.outDir);
  console.log(`Merged ${pairCount} pairs from ${fileCount} files -> ${path.resolve(mergedPath)}`);

  console.log(`\nWrote ${ctx.results.size} JSON files + 1 merged dataset to ${path.resolve(ctx.outDir)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
