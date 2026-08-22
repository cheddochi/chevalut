const listStatus = document.getElementById('listStatus');
const manualStatus = document.getElementById('manualStatus');
const sentenceList = document.getElementById('sentenceList');

async function fetchSentences() {
  listStatus.textContent = '불러오는 중...';
  try {
    const res = await fetch('/api/sentences');
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    const data = await res.json();
    renderList(data);
    listStatus.textContent = `${data.length}개의 문장`;
  } catch (err) {
    listStatus.textContent = `목록을 불러오지 못했습니다: ${err.message}`;
  }
}

function renderList(sentences) {
  sentenceList.innerHTML = '';
  for (const s of sentences) {
    const card = document.createElement('div');
    card.className = 'sentence-card';

    const text = document.createElement('p');
    text.className = 'sentence-text';
    text.textContent = s.text;
    card.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'sentence-meta';

    const category = document.createElement('span');
    category.className = 'badge-category';
    category.textContent = s.category;
    meta.appendChild(category);

    for (const tag of s.tags) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = `#${tag}`;
      meta.appendChild(pill);
    }

    const source = document.createElement('span');
    source.className = 'source-path';
    source.textContent = s.source.type === 'db' ? s.source.path : `${s.source.title} (붙여넣기)`;
    meta.appendChild(source);

    card.appendChild(meta);
    sentenceList.appendChild(card);
  }
}

document.getElementById('syncBtn').addEventListener('click', async () => {
  listStatus.textContent = '동기화된 노트를 분석하는 중... (노트 수에 따라 시간이 걸릴 수 있습니다)';
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
    listStatus.textContent =
      `검사 ${data.notesChecked}건 / 분석 ${data.notesAnalyzed}건 / 건너뜀(중복) ${data.notesSkipped}건 / ` +
      `생성된 문장 ${data.sentencesCreated}개` +
      (data.errors.length ? ` / 오류 ${data.errors.length}건` : '');
    await fetchSentences();
    if (currentView === 'topology') await fetchTopology();
  } catch (err) {
    listStatus.textContent = `분석 실행 실패: ${err.message}`;
  }
});

document.getElementById('manualBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('fileInput');
  const pasteInput = document.getElementById('pasteInput');
  manualStatus.textContent = '분석 중...';

  try {
    let res;
    if (fileInput.files.length > 0) {
      const form = new FormData();
      form.append('file', fileInput.files[0]);
      res = await fetch('/api/manual', { method: 'POST', body: form });
    } else {
      const content = pasteInput.value;
      res = await fetch('/api/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);

    manualStatus.textContent = `문장 ${data.sentenceCount}개 생성 완료`;
    fileInput.value = '';
    pasteInput.value = '';
    await fetchSentences();
    if (currentView === 'topology') await fetchTopology();
  } catch (err) {
    manualStatus.textContent = `분석 실패: ${err.message}`;
  }
});

// --- 탭 전환 ---
let currentView = 'list';
const tabButtons = document.querySelectorAll('.tab-btn');
const listView = document.getElementById('listView');
const topologyView = document.getElementById('topologyView');

tabButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;

    if (currentView === 'list') {
      listView.classList.remove('hidden');
      topologyView.classList.add('hidden');
    } else {
      listView.classList.add('hidden');
      topologyView.classList.remove('hidden');
      await fetchTopology();
    }
  });
});

// --- 토폴로지 뷰 (d3-force) ---
async function fetchTopology() {
  try {
    const res = await fetch('/api/topology');
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    const data = await res.json();
    renderTopology(data);
  } catch (err) {
    console.error('토폴로지 로딩 실패', err);
  }
}

function renderTopology(data) {
  const svg = d3.select('#topologySvg');
  svg.selectAll('*').remove();

  const width = svg.node().clientWidth || 800;
  const height = svg.node().clientHeight || 640;

  const nodes = data.nodes.map((n) => ({ ...n }));
  const links = data.edges.map((e) => ({ ...e }));

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      'link',
      d3
        .forceLink(links)
        .id((d) => d.id)
        .distance(60)
    )
    .force('charge', d3.forceManyBody().strength(-120))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide(18));

  const link = svg
    .append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('class', 'edge-line');

  const node = svg
    .append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('r', (d) => (d.type === 'sentence' ? 6 : 9))
    .attr('class', (d) => `node-${d.type}`)
    .call(drag(simulation))
    .on('click', (_event, d) => showDetail(d));

  const label = svg
    .append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .attr('class', 'node-label')
    .text((d) => (d.label.length > 20 ? d.label.slice(0, 20) + '…' : d.label));

  simulation.on('tick', () => {
    link
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);

    node.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
    label.attr('x', (d) => d.x + 10).attr('y', (d) => d.y + 4);
  });
}

function showDetail(d) {
  const detail = document.getElementById('topologyDetail');
  detail.classList.remove('hidden');
  if (d.type === 'sentence') {
    detail.innerHTML = `<strong>문장</strong><p>${escapeHtml(d.label)}</p>
      <p style="color:var(--text-muted);font-size:11px;font-family:var(--font-mono);">
        ${d.source ? (d.source.type === 'db' ? escapeHtml(d.source.path) : escapeHtml(d.source.title)) : ''}
      </p>`;
  } else {
    detail.innerHTML = `<strong>${d.type === 'tag' ? '태그' : '카테고리'}</strong><p>${escapeHtml(d.label)}</p>`;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function drag(simulation) {
  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }
  return d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended);
}

fetchSentences();
