// Runs in GitHub Actions. Reads TMDB_KEY from env (GitHub secret) and writes data/tmdb.json.
// The key is never written to any file that gets deployed.
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.TMDB_KEY;
if (!KEY) { console.error('TMDB_KEY missing'); process.exit(1); }

const data = JSON.parse(await readFile('data/mcu.json', 'utf8'));
const get = async p => {
  const r = await fetch(`https://api.themoviedb.org/3${p}${p.includes('?') ? '&' : '?'}api_key=${KEY}`);
  if (!r.ok) throw new Error(`${p} ${r.status}`);
  return r.json();
};
const byTitle = Object.fromEntries(data.movies.map(m => [m.title, m]));

const movies = {};
await Promise.all(data.movies.map(async m => {
  try { const d = await get(`/movie/${m.tmdbId}`); movies[m.tmdbId] = { poster: d.poster_path, backdrop: d.backdrop_path }; }
  catch (e) { console.warn(e.message); }
}));

// Find the actor via credits, then collect their tagged images from this character's MCU films.
const cands = {}, people = {};
await Promise.all(data.characters.map(async c => {
  const ids = c.films.map(t => byTitle[t].tmdbId);
  for (const mid of [...ids].reverse()) {
    try {
      const cr = await get(`/movie/${mid}/credits`);
      const hit = cr.cast.find(x => (x.character || '').toLowerCase().includes(c.match));
      if (hit) { people[c.name] = { personId: hit.id, role: hit.character }; break; }
    } catch {}
  }
  const all = [];
  if (people[c.name]) {
    for (let page = 1; page <= 8; page++) {
      try { const t = await get(`/person/${people[c.name].personId}/tagged_images?page=${page}`); all.push(...t.results); if (page >= t.total_pages) break; }
      catch { break; }
    }
  }
  cands[c.name] = all.filter(x => x.media_type === 'movie' && ids.includes(x.media?.id));
}));

// Images shared by many characters are group posters — penalise them so every card is character-specific.
const freq = {};
Object.values(cands).flat().forEach(x => { freq[x.file_path] = (freq[x.file_path] || 0) + 1; });
const used = new Set();
const characters = {};
for (const c of data.characters) {
  const base = people[c.name] || {};
  if (c.imageOverride) { characters[c.name] = { ...base, image: c.imageOverride, type: 'override', film: c.sceneFilm }; continue; }
  const solo = x => { const m = data.movies.find(m => m.tmdbId === x.media.id); return m && m.heroes.length <= 2 && m.heroes.some(h => h.toLowerCase().includes(c.match)); };
  const score = x => -freq[x.file_path] * 6 + (solo(x) ? 6 : 0) + (x.image_type === 'poster' ? 2 : 0) + (x.vote_average || 0) * 0.3;
  const pick = cands[c.name].filter(x => !used.has(x.file_path) && freq[x.file_path] <= 3).sort((a, b) => score(b) - score(a))[0];
  if (pick) {
    used.add(pick.file_path);
    characters[c.name] = { ...base, image: pick.file_path, type: pick.image_type, film: pick.media.title };
  } else {
    const m = byTitle[c.sceneFilm];
    characters[c.name] = { ...base, image: movies[m.tmdbId]?.backdrop || null, type: 'backdrop', film: c.sceneFilm };
  }
}

await writeFile('data/tmdb.json', JSON.stringify({ generated: new Date().toISOString(), movies, characters }, null, 1));
console.log('Wrote data/tmdb.json');
