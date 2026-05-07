import { readdir, stat, access, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const eventsDir = join(root, 'events');
const entries = await readdir(eventsDir);
const slugs = [];
const embeddedEvents = [];

for (const entry of entries) {
  const dir = join(eventsDir, entry);
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) continue;
    await access(join(dir, 'event.json'));
    const data = JSON.parse(await readFile(join(dir, 'event.json'), 'utf8'));
    slugs.push(entry);
    embeddedEvents.push({ ...data, slug: entry });
  } catch (error) {
    console.warn(`Skipping ${entry}: ${error.message}`);
  }
}

slugs.sort();
embeddedEvents.sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug));

await writeFile(join(eventsDir, 'manifest.json'), JSON.stringify(slugs, null, 2) + '\n');

const embeddedBlock = `var embeddedEventData=${JSON.stringify(embeddedEvents, null, 2)};`;

for (const htmlFile of ['index.html', 'checkout.html']) {
  const htmlPath = join(root, htmlFile);
  let html = await readFile(htmlPath, 'utf8');
  if (htmlFile === 'index.html') {
    html = html.replace(/var embeddedEventData=\[[\s\S]*?\];\nvar loadedUpcomingEvents=\[\];/, `${embeddedBlock}\nvar loadedUpcomingEvents=[];`);
  } else {
    html = html.replace(/var embeddedEventData=\[[\s\S]*?\];\nvar state=/, `${embeddedBlock}\nvar state=`);
  }
  await writeFile(htmlPath, html);
}

console.log(`Generated events/manifest.json and embedded fallback with ${slugs.length} event(s).`);
