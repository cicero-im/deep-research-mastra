import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ConsoleLogger } from '@mastra/core/logger';
import * as cheerio from 'cheerio';
import { marked } from 'marked';

const logger = new ConsoleLogger({ name: 'WebScraperTool', level: 'info' });

const DANGEROUS_TAGS = new Set([
  'script', 'style', 'iframe', 'embed', 'object', 'noscript', 'meta', 'link',
  'form', 'input', 'button', 'select', 'textarea', 'frame', 'frameset',
]);

const DANGEROUS_ATTRS = new Set([
  'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseout', 'onkeydown',
  'onkeyup', 'onkeypress', 'onfocus', 'onblur', 'formaction',
]);

function sanitizeHtml(html: string): string {
  const $ = cheerio.load(String(html), { xmlMode: false });
  for (const tag of DANGEROUS_TAGS) $(tag).remove();
  $('*').each((_i, el) => {
    const $el = $(el);
    const attrs = $el.attr();
    if (!attrs) return;
    for (const k of Object.keys(attrs)) {
      if (DANGEROUS_ATTRS.has(k.toLowerCase()) || k.toLowerCase().startsWith('on')) {
        $el.removeAttr(k);
      }
      if (k.toLowerCase() === 'href' && /^javascript:/i.test(attrs[k] ?? '')) {
        $el.attr('href', '#');
      }
    }
  });
  return $.html();
}

function extractTextContent(html: string): string {
  return cheerio.load(html).text().trim();
}

function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(sanitizeHtml(html));
  const out: string[] = [];
  $('body').find('h1,h2,h3,h4,h5,h6,p,a,strong,em,code,pre,ul,ol,li,blockquote,br').each((_i, el) => {
    const $el = $(el);
    const tag = ((el as { tagName?: string }).tagName ?? '').toLowerCase();
    const text = $el.text().trim();
    switch (tag) {
      case 'h1': out.push(`# ${text}\n`); break;
      case 'h2': out.push(`## ${text}\n`); break;
      case 'h3': out.push(`### ${text}\n`); break;
      case 'h4': out.push(`#### ${text}\n`); break;
      case 'h5': out.push(`##### ${text}\n`); break;
      case 'h6': out.push(`###### ${text}\n`); break;
      case 'p': out.push(`${text}\n`); break;
      case 'br': out.push('\n'); break;
      case 'a': {
        const href = $el.attr('href') ?? '';
        out.push(href ? `[${text}](${href})` : text);
        break;
      }
      case 'strong': out.push(`**${text}**`); break;
      case 'em': out.push(`*${text}*`); break;
      case 'code': out.push(`\`${text}\``); break;
      case 'pre': out.push(`\n\`\`\`\n${text}\n\`\`\`\n`); break;
      case 'li': out.push(`- ${text}\n`); break;
      case 'blockquote': out.push(`> ${text}\n`); break;
      default: break;
    }
  });
  return out.join(' ').replace(/\n\s+/g, '\n').replace(/\s{2,}/g, ' ').trim();
}

function sanitizeMarkdown(markdown: string): string {
  // Re-render to HTML, sanitize, then strip back to markdown-ish text.
  const html = marked.parse(markdown) as string;
  return extractTextContent(sanitizeHtml(html));
}

export const HtmlProcessor = {
  DANGEROUS_TAGS,
  DANGEROUS_ATTRS,
  sanitizeHtml,
  extractTextContent,
  htmlToMarkdown,
  sanitizeMarkdown,
};

class ValidationUtils {
  static validateUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return ['http:', 'https:'].includes(u.protocol);
    } catch {
      return false;
    }
  }
  static sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9\-_.]/g, '_');
  }
}

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; deep-research-mastra/1.0; +https://github.com/ssdeanx/deep-research)';

async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': FETCH_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const webScraperInputSchema = z
  .object({
    url: z.string().url().refine((v) => ValidationUtils.validateUrl(v), 'Invalid URL format'),
    selector: z.string().optional().describe("CSS selector for the elements to extract (e.g., 'h1', '.product-title'). If omitted, the entire page is returned."),
    extractAttributes: z.array(z.string()).optional().describe('HTML attributes to extract from selected elements.'),
    saveMarkdown: z.boolean().optional().describe('No-op on Cloudflare Workers (kept for back-compat).'),
    markdownFileName: z.string().optional().describe('No-op on Cloudflare Workers.'),
  })
  .strict();

const webScraperOutputSchema = z
  .object({
    url: z.string().url(),
    extractedData: z.array(z.record(z.string(), z.string())),
    rawContent: z.string().optional(),
    markdownContent: z.string().optional(),
    savedFilePath: z.string().optional(),
    status: z.string(),
    errorMessage: z.string().optional(),
  })
  .strict();

export const webScraperTool = createTool({
  id: 'web-scraper',
  description: 'Fetches a URL and extracts structured data. Workers-compatible (cheerio-based).',
  inputSchema: webScraperInputSchema,
  outputSchema: webScraperOutputSchema,
  execute: async (context: any, __ctx?: any) => {

    try {
      const html = await fetchHtml(context.url);
      const $ = cheerio.load(sanitizeHtml(html));
      const extracted: Array<Record<string, string>> = [];
      if (context.selector) {
        $(context.selector).each((_i, el) => {
          const $el = $(el);
          const row: Record<string, string> = { text: $el.text().trim() };
          for (const attr of context.extractAttributes ?? []) {
            const v = $el.attr(attr);
            if (v != null) row[attr] = v;
          }
          extracted.push(row);
        });
      } else {
        extracted.push({ text: $.text().trim() });
      }
      return {
        url: context.url,
        extractedData: extracted,
        rawContent: context.selector ? undefined : html,
        markdownContent: htmlToMarkdown(html),
        status: 'success',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('webScraperTool failed', { url: context.url, error: message });
      return {
        url: context.url,
        extractedData: [],
        status: 'failed',
        errorMessage: message,
      };
    }
  },
});

const batchWebScraperInputSchema = z
  .object({
    urls: z.array(z.string().url()).min(1).max(20),
    selector: z.string().optional(),
    extractAttributes: z.array(z.string()).optional(),
  })
  .strict();

const batchWebScraperOutputSchema = z
  .object({
    results: z.array(
      z.object({
        url: z.string(),
        extractedData: z.array(z.record(z.string(), z.string())),
        markdownContent: z.string().optional(),
        status: z.string(),
        errorMessage: z.string().optional(),
      }),
    ),
  })
  .strict();

export const batchWebScraperTool = createTool({
  id: 'batch-web-scraper',
  description: 'Scrapes multiple URLs concurrently (max 20). Workers-compatible.',
  inputSchema: batchWebScraperInputSchema,
  outputSchema: batchWebScraperOutputSchema,
  execute: async (context: any, __ctx?: any) => {

    const results = await Promise.all(
      (context.urls as string[]).map(async (url: string) => {
        try {
          const html = await fetchHtml(url);
          const $ = cheerio.load(sanitizeHtml(html));
          const extracted: Array<Record<string, string>> = [];
          if (context.selector) {
            $(context.selector).each((_i, el) => {
              const $el = $(el);
              const row: Record<string, string> = { text: $el.text().trim() };
              for (const attr of context.extractAttributes ?? []) {
                const v = $el.attr(attr);
                if (v != null) row[attr] = v;
              }
              extracted.push(row);
            });
          } else {
            extracted.push({ text: $.text().trim() });
          }
          return { url, extractedData: extracted, markdownContent: htmlToMarkdown(html), status: 'success' as const };
        } catch (err) {
          return {
            url,
            extractedData: [] as Array<Record<string, string>>,
            status: 'failed' as const,
            errorMessage: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }),
    );
    return { results };
  },
});

const siteMapExtractorInputSchema = z
  .object({
    sitemapUrl: z.string().url(),
    maxUrls: z.number().int().positive().max(500).optional().default(100),
  })
  .strict();

const siteMapExtractorOutputSchema = z
  .object({
    sitemapUrl: z.string(),
    urls: z.array(z.string()),
    status: z.string(),
    errorMessage: z.string().optional(),
  })
  .strict();

export const siteMapExtractorTool = createTool({
  id: 'sitemap-extractor',
  description: 'Reads sitemap.xml and returns the list of URLs.',
  inputSchema: siteMapExtractorInputSchema,
  outputSchema: siteMapExtractorOutputSchema,
  execute: async (context: any, __ctx?: any) => {

    try {
      const xml = await fetchHtml(context.sitemapUrl);
      const $ = cheerio.load(xml, { xmlMode: true });
      const urls: string[] = [];
      $('url > loc, sitemap > loc').each((_i, el) => {
        const u = $(el).text().trim();
        if (u) urls.push(u);
      });
      return {
        sitemapUrl: context.sitemapUrl,
        urls: urls.slice(0, context.maxUrls ?? 100),
        status: 'success',
      };
    } catch (err) {
      return {
        sitemapUrl: context.sitemapUrl,
        urls: [],
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  },
});

const linkExtractorInputSchema = z
  .object({
    url: z.string().url(),
    sameOriginOnly: z.boolean().optional().default(false),
  })
  .strict();

const linkExtractorOutputSchema = z
  .object({
    url: z.string(),
    links: z.array(z.object({ href: z.string(), text: z.string() })),
    status: z.string(),
    errorMessage: z.string().optional(),
  })
  .strict();

export const linkExtractorTool = createTool({
  id: 'link-extractor',
  description: 'Returns all <a href> links on a page.',
  inputSchema: linkExtractorInputSchema,
  outputSchema: linkExtractorOutputSchema,
  execute: async (context: any, __ctx?: any) => {

    try {
      const html = await fetchHtml(context.url);
      const $ = cheerio.load(sanitizeHtml(html));
      const base = new URL(context.url);
      const links: Array<{ href: string; text: string }> = [];
      $('a[href]').each((_i, el) => {
        const $el = $(el);
        const raw = $el.attr('href') ?? '';
        try {
          const abs = new URL(raw, base);
          if (context.sameOriginOnly && abs.origin !== base.origin) return;
          links.push({ href: abs.toString(), text: $el.text().trim() });
        } catch {
          /* skip malformed */
        }
      });
      return { url: context.url, links, status: 'success' };
    } catch (err) {
      return {
        url: context.url,
        links: [],
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  },
});

const htmlToMarkdownInputSchema = z
  .object({
    html: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .refine((v) => v.html || v.url, { message: 'Provide either html or url' })
  .pipe(z.object({ html: z.string().optional(), url: z.string().optional() }));

const htmlToMarkdownOutputSchema = z
  .object({
    markdown: z.string(),
    status: z.string(),
    errorMessage: z.string().optional(),
  })
  .strict();

export const htmlToMarkdownTool = createTool({
  id: 'html-to-markdown',
  description: 'Converts an HTML string (or fetched URL) to markdown.',
  inputSchema: htmlToMarkdownInputSchema,
  outputSchema: htmlToMarkdownOutputSchema,
  execute: async (context: any, __ctx?: any) => {

    try {
      const html = context.html ?? (context.url ? await fetchHtml(context.url) : '');
      return { markdown: htmlToMarkdown(html), status: 'success' };
    } catch (err) {
      return {
        markdown: '',
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  },
});

const listScrapedContentInputSchema = z
  .object({
    directory: z.string().optional(),
  })
  .strict();

const listScrapedContentOutputSchema = z
  .object({
    files: z.array(z.string()),
    status: z.string(),
    note: z.string().optional(),
  })
  .strict();

export const listScrapedContentTool = createTool({
  id: 'list-scraped-content',
  description: 'No-op on Cloudflare Workers (no local filesystem). Returns an empty list.',
  inputSchema: listScrapedContentInputSchema,
  outputSchema: listScrapedContentOutputSchema,
  execute: async () => ({
    files: [],
    status: 'success',
    note: 'Local-disk listing is unavailable in the Cloudflare Worker runtime. Persist scraped content via R2/D1 instead.',
  }),
});

const contentCleanerInputSchema = z
  .object({
    content: z.string().min(1),
    format: z.enum(['html', 'markdown']).optional().default('html'),
  })
  .strict();

const contentCleanerOutputSchema = z
  .object({
    cleaned: z.string(),
    status: z.string(),
  })
  .strict();

export const contentCleanerTool = createTool({
  id: 'content-cleaner',
  description: 'Strips dangerous tags/attributes/event-handlers from HTML or markdown.',
  inputSchema: contentCleanerInputSchema,
  outputSchema: contentCleanerOutputSchema,
  execute: async (context: any, __ctx?: any) => {

    const cleaned = context.format === 'markdown' ? sanitizeMarkdown(context.content) : sanitizeHtml(context.content);
    return { cleaned, status: 'success' };
  },
});
