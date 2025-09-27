const grid = document.getElementById('grid');
const rangeEl = document.getElementById('range');
const tpl = document.getElementById('card-tpl');
const notice = document.getElementById('notice');

const daysBack = document.getElementById('daysBack');
const platforms = document.getElementById('platforms');
const tags = document.getElementById('tags');
const ordering = document.getElementById('ordering');
const minRating = document.getElementById('minRating');
const hideSeen = document.getElementById('hideSeen');
const fetchBtn = document.getElementById('fetchBtn');
const dailyBtn = document.getElementById('dailyBtn');

const wRating = document.getElementById('wRating');
const wLike = document.getElementById('wLike');
const wSkip = document.getElementById('wSkip');
const wRecency = document.getElementById('wRecency');
const wRatingVal = document.getElementById('wRatingVal');
const wLikeVal = document.getElementById('wLikeVal');
const wSkipVal = document.getElementById('wSkipVal');
const wRecencyVal = document.getElementById('wRecencyVal');
const saveWeights = document.getElementById('saveWeights');

const likesBox = document.getElementById('likes');
const skipsBox = document.getElementById('skips');

function badge(text){
  const span = document.createElement('span');
  span.className = 'px-2 py-0.5 rounded-full border border-slate-300 bg-slate-50';
  span.textContent = text;
  return span;
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadPreferences(){
  const prefs = await fetchJSON('/api/preferences');
  wRating.value = prefs.weights?.rating ?? 0.5;
  wLike.value = prefs.weights?.tagLike ?? 4;
  wSkip.value = prefs.weights?.tagSkip ?? -2;
  wRecency.value = prefs.weights?.recency ?? 0.1;
  wRatingVal.textContent = wRating.value;
  wLikeVal.textContent = wLike.value;
  wSkipVal.textContent = wSkip.value;
  wRecencyVal.textContent = wRecency.value;

  likesBox.innerHTML = '';
  Object.entries(prefs.likes || {}).sort((a,b)=>b[1]-a[1]).slice(0, 24).forEach(([t,c]) => likesBox.appendChild(badge(`${t} (${c})`)));
  skipsBox.innerHTML = '';
  Object.entries(prefs.skips || {}).sort((a,b)=>b[1]-a[1]).slice(0, 24).forEach(([t,c]) => skipsBox.appendChild(badge(`${t} (${c})`)));
}

[wRating, wLike, wSkip, wRecency].forEach(input => {
  input.addEventListener('input', () => {
    wRatingVal.textContent = wRating.value;
    wLikeVal.textContent = wLike.value;
    wSkipVal.textContent = wSkip.value;
    wRecencyVal.textContent = wRecency.value;
  });
});

saveWeights.addEventListener('click', async () => {
  await fetchJSON('/api/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      weights: {
        rating: Number(wRating.value),
        tagLike: Number(wLike.value),
        tagSkip: Number(wSkip.value),
        recency: Number(wRecency.value),
      }
    })
  });
  await loadPreferences();
  await doFetch();
});

function renderGrid(games){
  grid.innerHTML = '';
  if (!games.length){
    const hint = document.createElement('div');
    hint.className = 'text-sm text-slate-700';
    hint.innerHTML = `No games for this query. Try:
      <ul class="list-disc ml-6">
        <li>Clear <b>Platforms</b> to widen the search</li>
        <li>Increase <b>Days Back</b></li>
        <li>Remove <b>Tags</b></li>
        <li>Set <b>Min Rating</b> to 0</li>
      </ul>`;
    grid.appendChild(hint);
    return;
  }
  for (const g of games){
    const node = tpl.content.cloneNode(true);
    const card = node.querySelector('article');
    const hero = node.querySelector('.aspect-video');
    hero.style.backgroundImage = `url(${g.background_image || ''})`;
    node.querySelector('h3').textContent = g.name;
    node.querySelector('span').textContent = `Score ${g._score}`;
    node.querySelector('.rating').textContent = (g.rating ?? 0).toFixed(1);
    node.querySelector('.rc').textContent = g.ratings_count ?? 0;
    node.querySelector('.released').textContent = g.released || '';

    const tagsBox = node.querySelector('.tags');
    const uniqueTags = Array.from(new Set([...(g.genres||[]), ...(g.tags||[])])).slice(0,8);
    uniqueTags.forEach(t => tagsBox.appendChild(badge(t)));

    const plat = node.querySelector('.platforms');
    plat.textContent = (g.platforms || []).join(' • ');

    const likeBtn = node.querySelector('.like');
    const skipBtn = node.querySelector('.skip');
    const link = node.querySelector('a');
    link.href = `https://rawg.io/games/${g.slug}`;

    likeBtn.addEventListener('click', async () => {
      await fetchJSON('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ likeTags: g.tags || [] })
      });
      await fetchJSON('/api/seen', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ slug: g.slug, hide: true })});
      card.style.opacity = 0.4;
      await loadPreferences();
    });

    skipBtn.addEventListener('click', async () => {
      await fetchJSON('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipTags: g.tags || [] })
      });
      await fetchJSON('/api/seen', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ slug: g.slug, hide: true })});
      card.style.opacity = 0.4;
      await loadPreferences();
    });

    grid.appendChild(node);
  }
}

async function doFetch(){
  notice.classList.add('hidden');
  try {
    const url = `/api/games?${new URLSearchParams({
      daysBack: daysBack.value,
      platforms: platforms.value,
      tags: tags.value,
      ordering: ordering.value,
      minRating: minRating.value || '0',
      hideSeen: hideSeen.checked ? 'true' : 'false'
    }).toString()}`;
    const data = await fetchJSON(url);
    rangeEl.textContent = `${data.range.start} → ${data.range.end} • ${data.count} games`;
    // Show debug hint if empty
    if (data.count === 0 && data._debug){
      notice.classList.remove('hidden');
      notice.textContent = `Debug: RAWG query ${JSON.stringify(data._debug.query)}`;
    }
    renderGrid(data.results);
  } catch (e) {
    notice.classList.remove('hidden');
    notice.textContent = 'Error: ' + e.message + ' • Tip: check /api/health';
  }
}

fetchBtn.addEventListener('click', doFetch);
dailyBtn.addEventListener('click', async () => {
  try {
    const payload = {
      daysBack: Number(daysBack.value) || 1,
      platforms: platforms.value,
      tags: tags.value
    };
    const res = await fetchJSON('/api/daily/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    alert(`Daily saved (${res.count}) • top: ${res.top5.map(x=>x.name).join(', ')}`);
  } catch (e) {
    alert('Daily failed: ' + e.message);
  }
});

loadPreferences().then(doFetch).catch(console.error);
