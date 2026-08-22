const state = {
  selectedTag: null,
  tags: [],
};
let currentView = 'list';

const listStatus = document.getElementById('listStatus');
const manualStatus = document.getElementById('manualStatus');
const sentenceList = document.getElementById('sentenceList');
const tagListContainer = document.getElementById('tagListContainer');
const tagSearchInput = document.getElementById('tagSearchInput');
const suggestionsBox = document.getElementById('tagSuggestions');
const selectedTagBar = document.getElementById('selectedTagBar');
const selectedTagName = document.getElementById('selectedTagName');

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ============ 태그 목록 + 검색 ============

async function loadTags() {
  listStatus.textContent = '태그 불러오는 중...';
  try {
    const res = await fetch('/api/tags');
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    state.tags = await res.json();
    renderTagList(state.tags);
    listStatus.textContent = `태그 ${state.tags.length}개`;
  } catch (err) {
    listStatus.textContent = `태그를 불러오지 못했습니다: ${err.message}`;
  }
}

function renderTagList(tags) {
  tagListContainer.innerHTML = '';
  for (const t of tags) {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.addEventListener('click', () => selectTag(t.name));

    const name = document.createElement('span');
    name.className = 'tag-row-name';
    name.textContent = `#${t.name}`;

    const count = document.createElement('span');
    count.className = 'tag-row-count';
    count.textContent = `${t.count}회`;

    const related = document.createElement('div');
    related.className = 'tag-row-related';
    for (const r of t.related.slice(0, 6)) {
      const chip = document.createElement('span');
      chip.className = 'related-chip';
      chip.textContent = `${r.name} · ${r.count}`;
      related.appendChild(chip);
    }

    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(related);
    tagListContainer.appendChild(row);
  }
}

tagSearchInput.addEventListener('input', () => {
  const q = tagSearchInput.value.trim().toLowerCase();
  if (!q) {
    suggestionsBox.classList.add('hidden');
    suggestionsBox.innerHTML = '';
    return;
  }
  const matches = state.tags.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 8);
  if (matches.length === 0) {
    suggestionsBox.classList.add('hidden');
    suggestionsBox.innerHTML = '';
    return;
  }
  suggestionsBox.innerHTML = '';
  for (const m of matches) {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.innerHTML = `<span>#${escapeHtml(m.name)}</span><span class="suggestion-count">${m.count}회</span>`;
    item.addEventListener('click', () => {
      suggestionsBox.classList.add('hidden');
      selectTag(m.name);
    });
    suggestionsBox.appendChild(item);
  }
  suggestionsBox.classList.remove('hidden');
});

tagSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = tagSearchInput.value.trim().toLowerCase();
    if (q) {
      const match =
        state.tags.find((t) => t.name.toLowerCase() === q) ||
        state.tags.find((t) => t.name.toLowerCase().includes(q));
      if (match) selectTag(match.name);
    }
    suggestionsBox.classList.add('hidden');
  } else if (e.key === 'Escape') {
    suggestionsBox.classList.add('hidden');
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) suggestionsBox.classList.add('hidden');
});

async function selectTag(name) {
  state.selectedTag = name;
  tagSearchInput.value = name;
  suggestionsBox.classList.add('hidden');
  selectedTagBar.classList.remove('hidden');
  selectedTagName.textContent = `#${name}`;
  tagListContainer.classList.add('hidden');
  sentenceList.classList.remove('hidden');

  await loadSentencesForTag(name);
  if (currentView === 'topology') await fetchTopology();
}

function clearTagSelection() {
  state.selectedTag = null;
  tagSearchInput.value = '';
  selectedTagBar.classList.add('hidden');
  tagListContainer.classList.remove('hidden');
  sentenceList.classList.add('hidden');
  listStatus.textContent = `태그 ${state.tags.length}개`;
  if (currentView === 'topology') fetchTopology();
}

document.getElementById('clearTagBtn').addEventListener('click', clearTagSelection);

// ============ 문장 목록 (태그 선택 시) ============

async function loadSentencesForTag(tag) {
  listStatus.textContent = `#${tag} 관련 문장 불러오는 중...`;
  try {
    const res = await fetch(`/api/sentences?tag=${encodeURIComponent(tag)}`);
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    const data = await res.json();
    renderList(data);
    listStatus.textContent = `#${tag} — 문장 ${data.length}개`;
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
      pill.style.cursor = 'pointer';
      pill.addEventListener('click', () => selectTag(tag));
      meta.appendChild(pill);
    }

    const source = document.createElement('span');
    source.className = 'source-path';
    source.textContent = s.source.type === 'vault' ? s.source.path : `${s.source.title} (붙여넣기)`;
    meta.appendChild(source);

    card.appendChild(meta);
    sentenceList.appendChild(card);
  }
}

// ============ 동기화 / 수동 분석 ============

/** /api/sync를 remaining이 0이 될 때까지 반복 호출한다. 진행 상황은 listStatus에 표시. */
async function runSyncLoop(label) {
  let totalAnalyzed = 0;
  let totalSentences = 0;
  let totalErrors = 0;

  while (true) {
    listStatus.textContent =
      `${label} 중... (지금까지 분석 ${totalAnalyzed}건, 생성된 문장 ${totalSentences}개)`;

    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);

    totalAnalyzed += data.notesAnalyzed;
    totalSentences += data.sentencesCreated;
    totalErrors += data.errors.length;

    if (data.remaining <= 0) {
      listStatus.textContent =
        `완료 — 총 검사 ${data.notesChecked}건 / 분석 ${totalAnalyzed}건 / ` +
        `건너뜀(중복) ${data.notesSkipped}건 / 생성된 문장 ${totalSentences}개` +
        (totalErrors ? ` / 오류 ${totalErrors}건` : '');
      break;
    }
  }

  await loadTags();
  if (state.selectedTag) await loadSentencesForTag(state.selectedTag);
  if (currentView === 'topology') await fetchTopology();
}

document.getElementById('syncBtn').addEventListener('click', async () => {
  try {
    await runSyncLoop('새로/변경된 노트를 분석하는');
  } catch (err) {
    listStatus.textContent = `분석 실행 실패: ${err.message}`;
  }
});

document.getElementById('forceResyncBtn').addEventListener('click', async () => {
  const confirmed = confirm(
    '지금까지 분석된 모든 문장/태그를 지우고, 볼트 전체를 처음부터 다시 분석합니다.\n' +
      'Workers AI 할당량을 많이 소모할 수 있습니다. 계속할까요?'
  );
  if (!confirmed) return;

  try {
    listStatus.textContent = '기존 분석 결과를 삭제하는 중...';
    const wipeRes = await fetch('/api/admin/wipe', { method: 'POST' });
    const wipeData = await wipeRes.json();
    if (!wipeRes.ok) throw new Error(wipeData.error || `서버 오류 (${wipeRes.status})`);

    await runSyncLoop('볼트 전체를 처음부터 재분석하는');
  } catch (err) {
    listStatus.textContent = `전체 재분석 실패: ${err.message}`;
  }
});

// ============ 자동 동기화 on/off ============

const autoSyncToggle = document.getElementById('autoSyncToggle');

async function loadAutoSyncSetting() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    const data = await res.json();
    autoSyncToggle.checked = Boolean(data.autoSyncEnabled);
  } catch (err) {
    listStatus.textContent = `자동 동기화 설정을 불러오지 못했습니다: ${err.message}`;
  }
}

autoSyncToggle.addEventListener('change', async () => {
  const enabled = autoSyncToggle.checked;
  autoSyncToggle.disabled = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoSyncEnabled: enabled }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
    autoSyncToggle.checked = Boolean(data.autoSyncEnabled);
    listStatus.textContent = data.autoSyncEnabled
      ? '자동 동기화를 켰습니다 (10분마다 새/변경된 노트를 분석합니다).'
      : '자동 동기화를 껐습니다.';
  } catch (err) {
    autoSyncToggle.checked = !enabled;
    listStatus.textContent = `자동 동기화 설정 변경 실패: ${err.message}`;
  } finally {
    autoSyncToggle.disabled = false;
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
    await loadTags();
    if (state.selectedTag) await loadSentencesForTag(state.selectedTag);
    if (currentView === 'topology') await fetchTopology();
  } catch (err) {
    manualStatus.textContent = `분석 실패: ${err.message}`;
  }
});

// ============ 탭 전환 ============

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

// ============ 토폴로지 뷰 (d3-force + zoom/pan) ============

let zoomBehavior = null;
let currentTopologyData = null;
let gravityStrength = -160;

async function fetchTopology() {
  try {
    const q = state.selectedTag ? `?tag=${encodeURIComponent(state.selectedTag)}` : '';
    const res = await fetch(`/api/topology${q}`);
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    const data = await res.json();
    currentTopologyData = data;
    renderTopology(data);
  } catch (err) {
    console.error('토폴로지 로딩 실패', err);
  }
}

document.getElementById('gravitySlider').addEventListener('input', (e) => {
  gravityStrength = Number(e.target.value);
  if (currentTopologyData) renderTopology(currentTopologyData);
});

function renderTopology(data) {
  const svgEl = document.getElementById('topologySvg');
  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();
  document.getElementById('topologyDetail').classList.add('hidden');

  const width = svgEl.clientWidth || 800;
  const height = svgEl.clientHeight || 720;
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  const g = svg.append('g').attr('class', 'zoom-layer');

  const nodes = data.nodes.map((n) => ({ ...n }));
  const links = data.edges.map((e) => ({ ...e }));

  if (nodes.length === 0) {
    g.append('text')
      .attr('x', width / 2)
      .attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('class', 'node-label')
      .text('표시할 데이터가 없습니다.');
    return;
  }

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      'link',
      d3.forceLink(links).id((d) => d.id).distance(70).strength(0.6)
    )
    .force('charge', d3.forceManyBody().strength(gravityStrength))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide(26))
    .stop();

  // 화면에 뜨자마자 이미 안정된 배치로 보이도록, 애니메이션 없이 미리 여러 틱을 돌려 수렴시킨다.
  const preTicks = Math.min(400, 150 + nodes.length);
  for (let i = 0; i < preTicks; i++) simulation.tick();

  const link = g.append('g').selectAll('line').data(links).join('line').attr('class', 'edge-line');

  const node = g
    .append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('r', (d) => (d.type === 'sentence' ? 6 : 9))
    .attr('class', (d) => `node-${d.type}`)
    .attr('cx', (d) => d.x)
    .attr('cy', (d) => d.y)
    .call(dragBehavior(simulation))
    .on('click', (event, d) => {
      event.stopPropagation();
      onNodeClick(d, nodes, links);
    });

  const label = g
    .append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .attr('class', 'node-label')
    .attr('x', (d) => d.x + 10)
    .attr('y', (d) => d.y + 4)
    .text((d) => (d.label.length > 28 ? d.label.slice(0, 28) + '…' : d.label));

  link
    .attr('x1', (d) => d.source.x)
    .attr('y1', (d) => d.source.y)
    .attr('x2', (d) => d.target.x)
    .attr('y2', (d) => d.target.y);

  simulation.on('tick', () => {
    link
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);
    node.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
    label.attr('x', (d) => d.x + 10).attr('y', (d) => d.y + 4);
  });

  zoomBehavior = d3
    .zoom()
    .scaleExtent([0.1, 6])
    // 마우스 휠 스크롤로는 확대/축소되지 않게 막는다 (버튼/드래그 이동은 그대로 허용).
    .filter((event) => event.type !== 'wheel' && !event.button)
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
  svg.call(zoomBehavior);

  fitToView(svg, nodes, width, height);

  document.getElementById('zoomInBtn').onclick = () => svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.3);
  document.getElementById('zoomOutBtn').onclick = () =>
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 1 / 1.3);
  document.getElementById('zoomResetBtn').onclick = () => fitToView(svg, nodes, width, height);
}

function fitToView(svg, nodes, width, height) {
  if (!zoomBehavior || nodes.length === 0) return;
  const padding = 60;
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const boxW = Math.max(maxX - minX, 1);
  const boxH = Math.max(maxY - minY, 1);
  const scale = Math.min((width - padding * 2) / boxW, (height - padding * 2) / boxH, 3);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const transform = d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-cx, -cy);
  svg.transition().duration(300).call(zoomBehavior.transform, transform);
}

function onNodeClick(d, nodes, links) {
  const detail = document.getElementById('topologyDetail');
  detail.classList.remove('hidden');

  if (d.type === 'sentence') {
    detail.innerHTML = `
      <h4>문장</h4>
      <p>${escapeHtml(d.label)}</p>
      <p style="color:var(--text-muted);font-size:11px;font-family:var(--font-mono);margin-bottom:12px;">
        ${d.source.type === 'vault' ? escapeHtml(d.source.path) : escapeHtml(d.source.title)}
      </p>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = '노트 전체 보기';
    btn.addEventListener('click', () => openNoteModal(d.source.id, d.source.title));
    detail.appendChild(btn);
    return;
  }

  // 태그/카테고리 노드: 연결된 문장을 통해 관련 노트 목록을 구성한다.
  const relatedSentenceIds = new Set(
    links.filter((l) => l.target.id === d.id).map((l) => l.source.id)
  );
  const relatedSentenceNodes = nodes.filter((n) => n.type === 'sentence' && relatedSentenceIds.has(n.id));

  const notesById = new Map();
  for (const n of relatedSentenceNodes) {
    if (!notesById.has(n.source.id)) notesById.set(n.source.id, n.source);
  }
  const notes = Array.from(notesById.values());

  detail.innerHTML = `
    <h4>${d.type === 'tag' ? '태그' : '카테고리'}: ${escapeHtml(d.label)}</h4>
    <p style="color:var(--text-muted);font-size:12px;margin-bottom:10px;">관련 노트 ${notes.length}건</p>
  `;

  for (const note of notes) {
    const btn = document.createElement('button');
    btn.className = 'related-note-item';
    btn.textContent = note.type === 'vault' ? note.path : `${note.title} (붙여넣기)`;
    btn.addEventListener('click', () => openNoteModal(note.id, note.title));
    detail.appendChild(btn);
  }
}

function dragBehavior(simulation) {
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

// ============ 노트 전체 내용 모달 ============

async function openNoteModal(sourceId, title) {
  const modal = document.getElementById('noteModal');
  const titleEl = document.getElementById('noteModalTitle');
  const bodyEl = document.getElementById('noteModalBody');

  titleEl.textContent = title || '노트';
  bodyEl.textContent = '불러오는 중...';
  modal.classList.remove('hidden');

  try {
    const res = await fetch(`/api/note-content?sourceId=${sourceId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
    titleEl.textContent = data.title || title;
    bodyEl.textContent = data.content || '(내용 없음)';
  } catch (err) {
    bodyEl.textContent = `불러오기 실패: ${err.message}`;
  }
}

document.getElementById('noteModalClose').addEventListener('click', () => {
  document.getElementById('noteModal').classList.add('hidden');
});
document.getElementById('noteModal').addEventListener('click', (e) => {
  if (e.target.id === 'noteModal') e.currentTarget.classList.add('hidden');
});

// ============ 개별 노트 분석 팝업 ============

document.getElementById('openManualBtn').addEventListener('click', () => {
  document.getElementById('manualModal').classList.remove('hidden');
});
document.getElementById('manualModalClose').addEventListener('click', () => {
  document.getElementById('manualModal').classList.add('hidden');
});
document.getElementById('manualModal').addEventListener('click', (e) => {
  if (e.target.id === 'manualModal') e.currentTarget.classList.add('hidden');
});

// ============ 초기 로드 ============

loadTags();
loadAutoSyncSetting();
