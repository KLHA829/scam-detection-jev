// @ts-check
'use strict';

/**
 * Merge the free PhishTank verified-online feed into `data/threat-feed-hosts.json`.
 *
 * Manual/cron use only — the live bot never does network lookups; it matches
 * locally against this snapshot. Rerun periodically (daily/weekly) to refresh:
 *
 *   node scripts/update-threat-feeds.js
 *
 * PhishTank's online-valid.csv needs no auth and is human-verified, which
 * matters here because a malicious-host match auto-blocks unsaved contacts.
 * Entries are capped to the most recent THREAT_FEED_MAX_HOSTS (default 5000);
 * phishing hosts are short-lived, so recency beats volume.
 */

const fs = require('fs');
const path = require('path');

const PHISHTANK_CSV_URL = 'https://data.phishtank.com/data/online-valid.csv';
const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'threat-feed-hosts.json');
const DEFAULT_MAX_HOSTS = 5000;

/**
 * Exact shared-hosting / public-suffix entries are dropped: suffix matching
 * would block every subdomain of the platform. Subdomain entries of these
 * platforms stay — they only match themselves and their own subdomains.
 */
// PhishTank rows are full URLs; the phishing is often the path on an abused
// legitimate service. Blocking the host would block every shortened link,
// cloud document and form in every chat — those hosts are dropped entirely.
const LEGIT_PLATFORM_HOSTS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'cutt.ly',
  'rb.gy',
  'is.gd',
  't.cn',
  'dwz.cn',
  'url.cn',
  'forms.gle',
  'goo.gl',
  'wa.me',
  'whatsapp.com',
  'dropbox.com',
  'www.dropbox.com',
  'drive.google.com',
  'docs.google.com',
  'forms.google.com',
  'sites.google.com',
  'youtube.com',
  'youtu.be',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'linktr.ee',
  'linktree.com',
  'pastebin.com',
  'mega.nz',
  'icloud.com',
  'onedrive.live.com',
  '1drv.ms',
  'box.com',
  'wetransfer.com',
  'smu.gs',
  'share.google',
  'meet.google.com',
  'cse.google.com',
  'sites.google.com',
  'docs.google.com',
  'notifications.googleapis.com',
  'storage.googleapis.com',
  'zoom.us',
  'teams.microsoft.com',
  'webex.com',
  'slack.com',
  'discord.gg',
  'discord.com',
  'sharepoint.com',
  'google.com',
  'www.google.com',
  'google.com.hk',
  'googleusercontent.com',
  'gstatic.com',
  'googleapis.com',
  'microsoft.com',
  'www.microsoft.com',
  'login.microsoftonline.com',
  'office.com',
  'office365.com',
  'apple.com',
  'www.apple.com',
  'amazon.com',
  'aws.amazon.com',
  'paypal.com',
  'www.paypal.com',
  'ebay.com',
  'alibaba.com',
  'taobao.com',
  'tmall.com',
  'jd.com',
  'hsbc.com',
  'hsbc.com.hk',
  'hangseng.com',
  'sf-express.com',
  'hktvmall.com',
  'openrice.com',
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'reddit.com',
  'wikipedia.org',
  'telegram.org',
  't.me',
  'signal.org',
  'wechat.com',
  'qq.com',
  'weixin.qq.com',
  'baidu.com',
  'zhihu.com',
  'weibo.com',
  '163.com',
  '126.com',
  'sina.com.cn',
  'alipay.com',
  'taobao.com',
  'rebrand.ly',
  'shorturl.at',
  'tiny.cc',
  's.id',
  'v.gd',
]);

const SHARED_HOSTS = new Set([
  '000webhostapp.com',
  'github.io',
  'gitlab.io',
  'medium.com',
  'blogspot.com',
  'wordpress.com',
  'weebly.com',
  'wixsite.com',
  'netlify.app',
  'vercel.app',
  'herokuapp.com',
  'firebaseapp.com',
  'web.app',
  'azurewebsites.net',
  'amazonaws.com',
  'cloudfront.net',
  'workers.dev',
  'pages.dev',
  'glitch.me',
  'ngrok.io',
  'ngrok-free.app',
  'duckdns.org',
  'no-ip.com',
  'ddns.net',
  'blogspot.hk',
  'sites.google.com',
  'googleapis.com',
  'sharepoint.com',
  'onedrive.live.com',
]);

function normalizeFeedHost(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\./, '')
    .replace(/\.+$/, '');
}

/** Minimal CSV row parser (quoted fields, escaped quotes). */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function hostFromUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

function hostsFromPhishTank(csv) {
  const rows = [];
  const lines = String(csv).split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 8) continue;
    const [id, url,, submissionTime, verified,, online] = fields;
    if (verified !== 'yes' || online !== 'yes') continue;
    const host = normalizeFeedHost(hostFromUrl(url));
    if (!host || !host.includes('.')) continue;
    if (SHARED_HOSTS.has(host) || LEGIT_PLATFORM_HOSTS.has(host)) continue;
    rows.push({ host, submissionTime, id });
  }
  // Newest first; dedupe keeps the most recent copy of each host.
  rows.sort((a, b) => (a.submissionTime < b.submissionTime ? 1 : -1));
  const seen = new Set();
  const hosts = [];
  for (const row of rows) {
    if (seen.has(row.host)) continue;
    seen.add(row.host);
    hosts.push(row.host);
  }
  return hosts;
}

async function main() {
  const maxHosts = Number(process.env.THREAT_FEED_MAX_HOSTS) || DEFAULT_MAX_HOSTS;
  const outPath = process.argv[2] || process.env.THREAT_FEED_HOSTS_OUT || DEFAULT_OUT;
  const url = process.env.PHISHTANK_CSV_URL || PHISHTANK_CSV_URL;

  process.stdout.write(`fetching ${url}\n`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const csv = await res.text();

  const hosts = hostsFromPhishTank(csv).slice(0, maxHosts);
  if (!hosts.length) throw new Error('feed produced zero hosts; refusing to write');

  const payload = {
    generated_at: new Date().toISOString(),
    source: 'phishtank online-valid.csv (verified=yes, online=yes; newest first)',
    source_url: url,
    count: hosts.length,
    hosts,
  };
  const tmp = `${outPath}.tmp`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 1)}\n`);
  fs.renameSync(tmp, outPath);
  process.stdout.write(`wrote ${hosts.length} hosts to ${outPath}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`update-threat-feeds: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { hostsFromPhishTank, parseCsvLine, normalizeFeedHost, SHARED_HOSTS, LEGIT_PLATFORM_HOSTS };
