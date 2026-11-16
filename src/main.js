import * as THREE from 'three';
import { parseDxf } from './dxf.js';

const PAGE_BG = 0xeef1f5;
const TILE_BG = 0xffffff;
const FIT_MARGIN = 1.07;
const LINE_COLOR = 0x1f2937;

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('gl'),
  grid: $('grid'),
  empty: $('empty'),
  emptyTitle: $('empty-title'),
  emptyText: $('empty-text'),
  stats: $('stats'),
  progress: $('progress'),
  progressText: $('progress-text'),
  progressFill: $('progress-fill'),
  pageInfo: $('page-info'),
  prev: $('prev'),
  next: $('next'),
  layout: $('layout'),
  dirInput: $('dir-input'),
  modal: $('modal'),
  modalTitle: $('modal-title'),
  stage: $('stage'),
};

const state = {
  items: [],
  page: 0,
  cols: 2,
  rows: 2,
  modal: null,
  loaded: false,
  loadToken: 0,
};

const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.autoClear = false;

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10);
const material = new THREE.LineBasicMaterial({
  color: LINE_COLOR,
  depthTest: false,
  depthWrite: false,
});

let rafId = 0;

function requestRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    draw();
  });
}

function fitHalfHeight(item, aspect) {
  const w = Math.max(item.width, 1e-6);
  const h = Math.max(item.height, 1e-6);
  return Math.max(h / 2, w / (2 * aspect)) * FIT_MARGIN;
}

function drawItem(item, rect, view) {
  const x = rect.left;
  const y = window.innerHeight - rect.bottom;
  const w = rect.width;
  const h = rect.height;
  if (w < 2 || h < 2) return;

  const aspect = w / h;
  const zoom = view ? view.zoom : 1;
  const halfH = fitHalfHeight(item, aspect) / zoom;
  const halfW = halfH * aspect;
  const cx = view ? view.px : 0;
  const cy = view ? view.py : 0;

  renderer.setScissorTest(true);
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.setClearColor(TILE_BG, 1);
  renderer.clear(true, true, false);

  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.position.set(cx, cy, 5);
  camera.up.set(0, 1, 0);
  camera.lookAt(cx, cy, 0);
  camera.near = 1;
  camera.far = 10;
  camera.updateProjectionMatrix();

  renderer.render(item.mesh, camera);
}

function draw() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  // 弹窗打开时画布浮在弹窗之上，除舞台区域外保持透明，避免遮挡弹窗 UI
  renderer.setClearColor(PAGE_BG, state.modal ? 0 : 1);
  renderer.clear(true, true, false);

  if (state.modal) {
    drawItem(state.modal.item, ui.stage.getBoundingClientRect(), state.modal.view);
  } else {
    const tiles = ui.grid.children;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const item = state.items[Number(tile.dataset.idx)];
      if (!item || !item.mesh) continue;
      drawItem(item, tile.getBoundingClientRect(), null);
    }
  }
  renderer.setScissorTest(false);
}

function buildItem(name, data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.computeBoundingSphere();
  return {
    name,
    geometry,
    mesh: new THREE.LineSegments(geometry, material),
    width: data.width,
    height: data.height,
    segments: data.segments,
  };
}

function showEmpty(title, text) {
  ui.emptyTitle.textContent = title;
  ui.emptyText.textContent = text;
  ui.empty.classList.remove('hidden');
}

// done === null 隐藏进度条；total === 0 表示扫描阶段（总数未知）
let progressHideTimer = 0;

function setProgress(done, total) {
  clearTimeout(progressHideTimer);
  progressHideTimer = 0;
  if (done === null) {
    ui.progress.classList.add('hidden');
    return;
  }
  ui.progress.classList.remove('hidden');
  if (total > 0) {
    ui.progressText.textContent = `解析 ${done} / ${total}`;
    ui.progressFill.classList.remove('indeterminate');
    ui.progressFill.style.width = `${Math.round((done / total) * 100)}%`;
  } else {
    ui.progressText.textContent = '正在扫描目录…';
    ui.progressFill.classList.add('indeterminate');
    ui.progressFill.style.width = '';
  }
}

function renderPage() {
  const per = state.cols * state.rows;
  const total = state.items.length;
  const pageCount = Math.max(1, Math.ceil(total / per));
  if (state.page > pageCount - 1) state.page = pageCount - 1;

  const start = state.page * per;
  const slice = state.items.slice(start, start + per);

  ui.grid.style.gridTemplateColumns = `repeat(${state.cols}, minmax(0, 1fr))`;
  ui.grid.style.gridTemplateRows = `repeat(${state.rows}, minmax(0, 1fr))`;

  const frag = document.createDocumentFragment();
  slice.forEach((item, i) => {
    const index = start + i;
    const tile = document.createElement('div');
    tile.className = item.error ? 'tile broken' : 'tile';
    tile.dataset.idx = String(index);

    const label = document.createElement('div');
    label.className = 'tile-label';
    const num = document.createElement('span');
    num.className = 'tile-num';
    num.textContent = String(index + 1);
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = item.name;
    label.append(num, name);
    tile.append(label);

    if (item.error) {
      const msg = document.createElement('div');
      msg.className = 'tile-error';
      msg.textContent = item.error;
      tile.append(msg);
    } else {
      tile.addEventListener('click', () => openModal(index));
    }
    frag.append(tile);
  });
  ui.grid.replaceChildren(frag);

  const failed = state.items.reduce((n, item) => n + (item.error ? 1 : 0), 0);
  ui.stats.textContent = total
    ? `共 ${total} 张 DXF${failed ? ` · ${failed} 张解析失败` : ''}`
    : state.loaded
      ? '没有 DXF 文件'
      : '未选择目录';
  ui.pageInfo.textContent = `${total ? state.page + 1 : 0} / ${pageCount}`;
  ui.prev.disabled = state.page <= 0;
  ui.next.disabled = total === 0 || state.page >= pageCount - 1;

  requestRender();
}

// 清空旧内容，为新一轮加载做准备（先隐藏旧卡片，再显示进度条）
function resetForLoad() {
  state.items = [];
  state.page = 0;
  closeModal();
  ui.grid.replaceChildren();
  ui.empty.classList.add('hidden');
  ui.stats.textContent = '解析中…';
  requestRender();
}

async function loadFiles(files, token = ++state.loadToken) {
  if (token !== state.loadToken) return;
  resetForLoad();

  if (!files.length) {
    setProgress(null);
    ui.stats.textContent = '没有 DXF 文件';
    showEmpty('该目录下没有 DXF 文件', '请换一个包含 .dxf 文件的目录重试。');
    return;
  }

  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    if (token !== state.loadToken) return;
    const file = files[i];
    setProgress(i, files.length);

    let item;
    try {
      item = buildItem(file.name, parseDxf(await file.read()));
    } catch (err) {
      failed++;
      console.warn('[DXF] 解析失败：', file.name, err);
      item = { name: file.name, error: '解析失败' };
    }
    // await 之后必须复查令牌，否则旧目录的加载循环会污染新目录的数据
    if (token !== state.loadToken) return;
    state.items.push(item);

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (token !== state.loadToken) return;
  if (failed === files.length) {
    showEmpty('全部文件解析失败', '这些 DXF 可能使用了二进制格式或无法识别的内容。');
  }
  // 全部处理完后满进度短暂停留，再一次性显示卡片
  setProgress(files.length, files.length);
  progressHideTimer = setTimeout(() => {
    if (token !== state.loadToken) return;
    setProgress(null);
    renderPage();
  }, 600);
}

async function pickDirectory() {
  if (!window.showDirectoryPicker) {
    ui.dirInput.click();
    return;
  }

  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err && err.name !== 'AbortError') console.warn(err);
    return;
  }

  // 从扫描阶段就持有令牌，防止旧目录的扫描/解析串扰新目录
  const token = ++state.loadToken;
  resetForLoad();
  setProgress(0, 0);

  const files = [];
  // 递归扫描子目录，文件名带上相对路径
  const scan = async (handle, prefix) => {
    for await (const entry of handle.values()) {
      if (token !== state.loadToken) return;
      if (entry.kind === 'file' && /\.dxf$/i.test(entry.name)) {
        files.push({
          name: prefix + entry.name,
          read: async () => (await entry.getFile()).text(),
        });
        ui.progressText.textContent = `正在扫描目录…（已找到 ${files.length} 个 DXF）`;
      } else if (entry.kind === 'directory') {
        await scan(entry, `${prefix}${entry.name}/`);
      }
    }
  };
  await scan(dir, '');
  if (token !== state.loadToken) return;
  files.sort(sortByName);
  state.loaded = true;
  loadFiles(files, token);
}

function sortByName(a, b) {
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function turnPage(delta) {
  const per = state.cols * state.rows;
  const pageCount = Math.max(1, Math.ceil(state.items.length / per));
  const next = Math.min(Math.max(state.page + delta, 0), pageCount - 1);
  if (next === state.page) return false;
  state.page = next;
  renderPage();
  return true;
}

function openModal(index) {
  const item = state.items[index];
  if (!item || !item.mesh) return;
  state.modal = { item, view: { zoom: 1, px: 0, py: 0 } };
  ui.modalTitle.textContent = item.name;
  ui.modal.classList.remove('hidden');
  ui.canvas.classList.add('over-modal');
  requestRender();
}

function closeModal() {
  if (!state.modal) return;
  state.modal = null;
  ui.modal.classList.add('hidden');
  ui.canvas.classList.remove('over-modal');
  requestRender();
}

function bindModalStage() {
  let drag = null;

  ui.stage.addEventListener('pointerdown', (ev) => {
    if (!state.modal || ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY };
    ui.stage.setPointerCapture(ev.pointerId);
    ui.stage.classList.add('dragging');
  });

  ui.stage.addEventListener('pointermove', (ev) => {
    if (!drag || !state.modal) return;
    const rect = ui.stage.getBoundingClientRect();
    if (rect.height < 2) return;
    const view = state.modal.view;
    const halfH = fitHalfHeight(state.modal.item, rect.width / rect.height) / view.zoom;
    const worldPerPx = (2 * halfH) / rect.height;
    view.px -= (ev.clientX - drag.x) * worldPerPx;
    view.py += (ev.clientY - drag.y) * worldPerPx;
    drag = { x: ev.clientX, y: ev.clientY };
    requestRender();
  });

  const endDrag = (ev) => {
    if (!drag) return;
    drag = null;
    if (ui.stage.hasPointerCapture(ev.pointerId)) ui.stage.releasePointerCapture(ev.pointerId);
    ui.stage.classList.remove('dragging');
  };
  ui.stage.addEventListener('pointerup', endDrag);
  ui.stage.addEventListener('pointercancel', endDrag);

  ui.stage.addEventListener(
    'wheel',
    (ev) => {
      if (!state.modal || ev.ctrlKey) return;
      const rect = ui.stage.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      ev.preventDefault();

      const view = state.modal.view;
      const aspect = rect.width / rect.height;
      const nx = (ev.clientX - rect.left) / rect.width - 0.5;
      const ny = 0.5 - (ev.clientY - rect.top) / rect.height;

      const halfH0 = fitHalfHeight(state.modal.item, aspect) / view.zoom;
      const halfW0 = halfH0 * aspect;
      const wx = view.px + nx * 2 * halfW0;
      const wy = view.py + ny * 2 * halfH0;

      const zoom = Math.min(400, Math.max(0.2, view.zoom * Math.exp(-ev.deltaY * 0.0015)));
      const halfH1 = fitHalfHeight(state.modal.item, aspect) / zoom;
      const halfW1 = halfH1 * aspect;

      view.zoom = zoom;
      view.px = wx - nx * 2 * halfW1;
      view.py = wy - ny * 2 * halfH1;
      requestRender();
    },
    { passive: false }
  );

  ui.stage.addEventListener('dblclick', () => {
    if (!state.modal) return;
    state.modal.view = { zoom: 1, px: 0, py: 0 };
    requestRender();
  });
}

function bindUI() {
  $('pick').addEventListener('click', pickDirectory);
  $('pick-empty').addEventListener('click', pickDirectory);

  ui.dirInput.addEventListener('change', () => {
    const files = Array.from(ui.dirInput.files || [])
      .filter((file) => /\.dxf$/i.test(file.name))
      .map((file) => ({ name: file.webkitRelativePath || file.name, read: () => file.text() }));
    files.sort(sortByName);
    ui.dirInput.value = '';
    state.loaded = true;
    loadFiles(files);
  });

  ui.layout.addEventListener('change', () => {
    const [cols, rows] = ui.layout.value.split('x').map(Number);
    state.cols = cols;
    state.rows = rows;
    state.page = 0;
    renderPage();
  });

  ui.prev.addEventListener('click', () => turnPage(-1));
  ui.next.addEventListener('click', () => turnPage(1));

  // 滚轮上下翻页（弹窗内滚轮是缩放，不触发翻页）
  let wheelLock = 0;
  ui.grid.addEventListener(
    'wheel',
    (ev) => {
      if (state.modal || ev.ctrlKey || !ev.deltaY) return;
      const now = performance.now();
      if (now < wheelLock) return;
      // 一次滚轮手势只翻一页
      if (turnPage(ev.deltaY > 0 ? 1 : -1)) wheelLock = now + 500;
    },
    { passive: true }
  );

  $('modal-close').addEventListener('click', closeModal);
  $('modal-fit').addEventListener('click', () => {
    if (!state.modal) return;
    state.modal.view = { zoom: 1, px: 0, py: 0 };
    requestRender();
  });
  ui.modal.addEventListener('click', (ev) => {
    if (ev.target === ui.modal) closeModal();
  });

  document.addEventListener('keydown', (ev) => {
    if (state.modal) {
      if (ev.key === 'Escape') closeModal();
      return;
    }
    if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') {
      ev.preventDefault();
      turnPage(-1);
    } else if (ev.key === 'ArrowRight' || ev.key === 'PageDown') {
      ev.preventDefault();
      turnPage(1);
    }
  });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    requestRender();
  });

  bindModalStage();
}

renderer.setSize(window.innerWidth, window.innerHeight);
bindUI();
renderPage();
