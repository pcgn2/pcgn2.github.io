// Run: node fetch-data.js
// Generates data.json that index.html loads directly (no server needed)

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TARGET = 'https://elamigos.site';
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(GB|MB)/i;

function fetchUrl(url) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function crawlMainPage(html) {
  const sections = {};
  let currentDate = null;

  for (const line of html.split('\n')) {
    const h1Match = line.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (h1Match) {
      const dmy = h1Match[1].match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (dmy) {
        currentDate = `${dmy[1]}.${dmy[2]}.${dmy[3]}`;
        sections[currentDate] = [];
      }
      continue;
    }
    if (!currentDate) continue;

    const h3Match = line.match(/<(h3|h5)[^>]*>(.*?)<\/\1>/i);
    if (h3Match) {
      const tag = h3Match[1].toLowerCase();
      const aMatch = h3Match[2].match(/<a\s+href="([^"]+\.html)"[^>]*>/i);
      if (aMatch) {
        const url = new URL(aMatch[1], TARGET).href;
        const title = h3Match[2].replace(/<[^>]+>/g, '').replace(/DOWNLOAD|ElAmigos|Repack|Update/gi, '').trim();
        if (!sections[currentDate].some(l => l.url === url)) {
          sections[currentDate].push({ url, title, date: currentDate, updated: tag === 'h5' });
        }
      }
    }
  }

  const sorted = Object.keys(sections).sort((a, b) => {
    const [d1, m1, y1] = a.split('.').map(Number);
    const [d2, m2, y2] = b.split('.').map(Number);
    return new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1);
  });

  const links = [];
  for (const date of sorted) links.push(...sections[date]);
  return links.slice(0, 200);
}

function parseDeepPage(body) {
  const sizeMatch = body.match(SIZE_RE);
  const filesize = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null;
  let rapidgator = null, youtube = null;

  // YouTube: look for standalone youtube URLs
  const ytMatch = body.match(/https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
  if (ytMatch) youtube = ytMatch[0];

  // Rapidgator: first link after <h2>RAPIDGATOR</h2>
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/<h2[^>]*>RAPIDGATOR<\/h2>/i.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const m = lines[j].match(/href="([^"]+\.html)"/i);
        if (m) { rapidgator = new URL(m[1], TARGET).href; break; }
      }
      if (rapidgator) break;
    }
  }

  // Fallback to any filecrypt link
  if (!rapidgator) {
    const rgMatch = body.match(/https?:\/\/filecrypt\.cc\/Container\/[^"'\s<>]+/);
    if (rgMatch) rapidgator = rgMatch[0];
  }

  return { filesize, rapidgator, youtube };
}

async function main() {
  // Load existing cache
  let cache = {};
  const cachePath = path.join(__dirname, 'data.json');
  try {
    const existing = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (existing.links) {
      for (const l of existing.links) cache[l.url] = l;
    }
  } catch {}

  console.log('Fetching main page...');
  const { body } = await fetchUrl(TARGET);
  const links = crawlMainPage(body);
  console.log(`Found ${links.length} games`);

  let crawled = 0, skipped = 0;

  for (let i = 0; i < links.length; i++) {
    const url = links[i].url;
    const cached = cache[url];

    if (cached && cached.filesize && cached.rapidgator && !links[i].updated) {
      // Reuse cached data (skip deep crawl unless marked as updated)
      links[i].filesize = cached.filesize;
      links[i].rapidgator = cached.rapidgator;
      links[i].youtube = cached.youtube;
      skipped++;
      continue;
    }

    process.stdout.write(`\rDeep crawl ${++crawled}/${links.length}...`);
    const deep = await parseDeepPage((await fetchUrl(url)).body);
    links[i].filesize = deep.filesize;
    links[i].rapidgator = deep.rapidgator;
    links[i].youtube = deep.youtube;
    // Rate-limit to be gentle
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nCrawled ${crawled}, reused ${skipped}`);
  console.log('Saving data.json...');
  fs.writeFileSync(cachePath, JSON.stringify({ links, fetched: Date.now() }));
  console.log('Done!');
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
