import { readFile, writeFile } from 'node:fs/promises';

const notice = await readFile(new URL('../notice.html', import.meta.url), 'utf8');
// Each notice carries data-date="YYYY-MM-DD"; the home pages show it next to the title.
const rows = [...notice.matchAll(/<li class="notice-item[^"]*"([^>]*)>\s*<h3>([^<]+)<\/h3>/g)]
  .slice(0, 3).map(([, attributes, title]) => {
    const date = attributes.match(/\sdata-date="(20\d{2}-\d{2}-\d{2})"/)?.[1];
    if (!date) throw new Error(`Add data-date="YYYY-MM-DD" to the notice "${title}" in notice.html`);
    return `<a class="notice-row" href="/notice"><time class="notice-date" datetime="${date}">${date}</time><span class="notice-title">${title}</span><span aria-hidden="true">→</span></a>`;
  });
if (!rows.length) throw new Error('No notice headings found');
// "/" serves index.html and signed-in visitors land on main.html; keep both home pages current.
for (const page of ['index.html', 'main.html']) {
  const path = new URL(`../${page}`, import.meta.url);
  const home = await readFile(path, 'utf8');
  const updated = home.replace(/(id="latestNotices">)[\s\S]*?(<\/div><\/section>)/, '$1' + rows.join('') + '$2');
  if (process.argv.includes('--check')) {
    if (updated !== home) throw new Error(`Run node scripts/sync-home-notices.mjs after editing notice.html (${page} is out of date)`);
  } else {
    await writeFile(path, updated);
  }
}
