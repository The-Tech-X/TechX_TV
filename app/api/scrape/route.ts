import { NextResponse } from 'next/server';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return NextResponse.json({ error: 'Valid HTTP/HTTPS URL is required' }, { status: 400 });
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.statusText}`);
    }

    const html = await response.text();
    
    // Parse the HTML using JSDOM
    const doc = new JSDOM(html, { url });
    
    // Extract main article content using Mozilla Readability
    // This perfectly isolates the article body, ignoring sidebars, ads, headers, and footers
    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    const title: string =
      article?.title ||
      doc.window.document.querySelector('title')?.textContent ||
      url;

    // Clean up text content (remove excessive newlines)
    const content = article?.textContent ? article.textContent.replace(/\s+/g, ' ').trim() : 'No main content could be extracted.';

    // Extract domain name for the source
    const domainUrl = new URL(url);
    const source = domainUrl.hostname.replace('www.', '');

    return NextResponse.json({
      title: title.trim(),
      source,
      url,
      content
    });

  } catch (error: any) {
    console.error('Scrape API Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to scrape URL' }, { status: 500 });
  }
}
