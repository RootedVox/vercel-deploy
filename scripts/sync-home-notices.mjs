import { readFile, writeFile } from 'node:fs/promises';

const notice = await readFile(new URL('../notice.html', import.meta.url), 'utf8');
const path = new URL('../main.html', import.meta.url);
const home = await readFile(path, 'utf8');
const rows = [...notice.matchAll(/<li class="notice-item[^"]*">\s*<h3>([^<]+)<\/h3>([\s\S]*?)<\/li>/g)]
  .slice(0, 3).map(([, title, body]) => {
    const date = body.match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0] || '最新';
    return `<a class="notice-row" href="/notice"><span class="notice-date">${date}</span><span class="notice-title">${title}</span><span aria-hidden="true">→</span></a>`;
  });
if (!rows.length) throw new Error('No notice headings found');
const updated = home.replace(/(id="latestNotices">)[\s\S]*?(<\/div><\/section>)/, '$1' + rows.join('') + '$2');
if (process.argv.includes('--check')) {
  if (updated !== home) throw new Error('Run node scripts/sync-home-notices.mjs after editing notice.html');
} else {
  await writeFile(path, updated);
}
