const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[char]);
const timecode = value => {
  if (!Number.isFinite(value)) return '未知';
  const seconds = Math.max(0, Math.floor(value));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
};
const preciseTimecode = seconds => {
  const milliseconds = Math.max(0,Math.round(seconds*1000));
  return timecode(Math.floor(milliseconds/1000)) + '.' + String(milliseconds%1000).padStart(3,'0');
};
const sizeText = bytes => bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB' : (bytes / 1e6).toFixed(1) + ' MB';
const pages = ['导入', '转码', '色彩转换', '字幕', '导出', '任务中心'];
const tasksPageIndex = pages.length - 1;
const sampleRows = [
  {start:0, end:4, speaker:'采访者', text:'你当时为什么选择这个方向？', confirmed:true},
  {start:4, end:8, speaker:'示例说话人 B', text:'这是用于检查字幕布局的示例文本。', confirmed:false},
  {start:8, end:12, speaker:'示例说话人 B', text:'时间码和说话人可以在这里对照。', confirmed:false}
];
const defaults = {preset:'ProRes 422', quality:'标准', bitrate:'', audio:'PCM 24-bit', container:'自动', threads:'auto', transcode:true, subtitleMode:'none', captionStyle:'box',
  transform:false, inputGamut:'未知', inputGamma:'未知', inputRange:'未知', inputMatrix:'未知', outputGamut:'Rec.709', outputGamma:'Rec.709',
  delivery:'SRT 字幕', destination:'', model:'Large-v3-turbo', language:'自动检测'};
const sampleClips = [
  {id:1, name:'示例采访片段.mp4', duration:13, bytes:455352, url:'review-sample.mp4', sample:true,
   resolution:'960 × 540', fps:'25', codec:'H.264', depth:'8-bit', chroma:'4:2:0', audio:'无音轨（画面样片）',
   rows:structuredClone(sampleRows), selected:true, cursor:0, row:0, track:0, overrides:{}},
  {id:2, name:'CAM_B_001.MOV', duration:84, bytes:923000000, sample:true, resolution:'3840 × 2160',
   fps:'25', codec:'HEVC', depth:'10-bit', chroma:'4:2:2', audio:'2 条音轨（示例）', rows:[], selected:true, cursor:0, row:0, track:0, overrides:{}},
  {id:3, name:'FIELD_AUDIO_02.wav', duration:144, bytes:42000000, sample:true, codec:'PCM',
   audio:'1 条立体声音轨（示例）', rows:[], selected:false, cursor:0, row:0, track:0, overrides:{}}
];
const clips = [];
const groups = [];
const emptyClip = {name:'未导入素材', rows:[], overrides:{}, cursor:0, row:0, track:0};
const queue = [];
let exportJobs = [];
let exportJobsError = '';
let exportConfig = {destination:'', template:'{name}_{profile}', collision:'number', kind:'video', audioFormat:'WAV', muxSubtitles:'省略', muxAudio:'selected'};
const newProfiles = {
  'H.266 / VVC':['MP4','10-bit 4:2:0'], 'AV2':['IVF','10-bit 4:2:0'],
  'H.266 / VVC 8-bit':['MP4','8-bit 4:2:0'], 'AV2 8-bit':['IVF','8-bit 4:2:0'],
  'DNxHR SQ':['MOV','MXF','8-bit 4:2:2'], 'DNxHR HQX':['MOV','MXF','10-bit 4:2:2'],
  'ProRes 4444':['MOV','4:4:4 / 可保留 Alpha'], 'ProRes 4444 XQ':['MOV','4:4:4 / 可保留 Alpha'],
  'FFV1':['MKV','沿用源像素格式'], 'AV1 8-bit':['MP4','MKV','8-bit 4:2:0'],
  'AV1 10-bit':['MP4','MKV','10-bit 4:2:0'], 'AV1 10-bit 4:2:2':['MP4','MKV','10-bit 4:2:2'], 'VP9':['WebM','8-bit 4:2:0'],
  'H.265 10-bit 4:2:0':['MP4','MOV','10-bit 4:2:0']
};
let exportSpace = null;
let studioId = 'default';
let deliveryPresets = [];
let repairDelivery = null;
let page = 0;
let libraryExpanded = false;
let active = emptyClip;
let scope = 'clip';
let serial = sampleClips.length;
let batchSerial = 0;
let toastTimer;
let limits = {jobs:'', threads:''};
let reduceMotion = false;
let isMacPlatform = /Mac|Macintosh|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
let defaultCaptionFontName = isMacPlatform ? 'PingFang SC' : 'Microsoft YaHei';
let showWorkspaceArt = false;
let themeMode = 'auto';
const systemDarkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
let darkMode = systemDarkQuery ? systemDarkQuery.matches : true;
try {
  const savedTheme = localStorage.getItem('local-post-theme-mode');
  if (savedTheme === 'auto' || savedTheme === 'dark' || savedTheme === 'light') themeMode = savedTheme;
  showWorkspaceArt = localStorage.getItem('local-post-show-art') === 'true';
} catch (_) {}
const themeIcons = {
  auto: '<svg class="btn-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M8 2a6 6 0 0 1 0 12V2Z" fill="currentColor"/></svg>',
  dark: '<svg class="btn-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2 9.8A5.6 5.6 0 0 1 6.2 2.8a5.8 5.8 0 1 0 7 7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  light: '<svg class="btn-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
};
function updateThemeButton() {
  const button = byId('theme-toggle');
  if (!button) return;
  const label = themeMode === 'auto' ? '自动' : themeMode === 'dark' ? '深色' : '浅色';
  button.innerHTML = (themeIcons[themeMode] || '') + '<span>' + translate(label) + '</span>';
  button.dataset.themeMode = themeMode;
}
function applyTheme() {
  darkMode = themeMode === 'auto' ? (systemDarkQuery ? systemDarkQuery.matches : true) : themeMode === 'dark';
  document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
  document.documentElement.dataset.themeMode = themeMode;
  updateThemeButton();
  window.localPost?.setAppearance?.(themeMode);
}
systemDarkQuery?.addEventListener?.('change', () => { if (themeMode === 'auto') applyTheme(); });
try { reduceMotion = localStorage.getItem('local-post-reduce-motion') === 'true'; } catch (_) {}
document.body.classList.toggle('reduce-motion', reduceMotion);
document.body.classList.toggle('hide-art', !showWorkspaceArt);
document.body.classList.toggle('macos-desktop', Boolean(window.localPost?.isMacDesktop));
function chooseNativeDirectory() {
  if (window.localPost?.chooseOutputDirectory) return window.localPost.chooseOutputDirectory();
  return api('choose-directory', {}).then(res => res?.path || null);
}
function openNativeDirectory(directory) {
  if (window.localPost?.openOutputDirectory) return window.localPost.openOutputDirectory(directory);
  return api('open-directory', {directory}).then(() => '').catch(error => error.message);
}
applyTheme();
const visibleClips = () => clips.filter(clip => !clip.removed);
const selectedClips = () => visibleClips().filter(clip => clip.selected);
const effective = clip => ({...defaults, ...clip.overrides});
let colorPresets = [];
const colorKeys = ['transform','inputGamut','inputGamma','inputRange','inputMatrix','outputGamut','outputGamma',
  'colorDirection','viewColor','logColor'];
const config = () => scope === 'batch' ? defaults : effective(active);
const value = id => byId(id)?.value ?? '';
const check = id => Boolean(byId(id)?.checked);

function toast(message) {
  const node = byId('toast');
  node.textContent = translate(message);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

function renderLibrary() {
  if (floatingMenuAnchor) closeFloatingMenu();
  const order = value('sort');
  const search = value('search').toLowerCase();
  const visible = visibleClips().filter(clip => clip.name.toLowerCase().includes(search));
  if (order === 'name') visible.sort((a,b) => a.name.localeCompare(b.name));
  if (order === 'size') visible.sort((a,b) => b.bytes - a.bytes);
  const item = clip => `
    <div class="item ${clip === active ? 'active' : ''} ${clip.selected ? 'selected' : ''}" data-clip-item="${clip.id}" draggable="true">
      <input type="checkbox" data-pick="${clip.id}" aria-label="选中 ${escapeHtml(clip.name)}" ${clip.selected ? 'checked' : ''}>
      <button type="button" data-clip="${clip.id}" title="${escapeHtml(clip.name)}" aria-current="${clip === active}">
        ${libraryExpanded ? `<span class="clip-thumbnail"><span class="thumbnail-placeholder" aria-hidden="true">${clip.resolution ? '▧' : '♫'}</span>${clip.mediaId && clip.status === '已就绪' && clip.resolution ? `<img loading="lazy" alt="" src="/api/thumbnail?id=${encodeURIComponent(clip.mediaId)}&amp;token=${encodeURIComponent(token)}">` : ''}<span class="thumbnail-duration mono">${timecode(clip.duration)}</span></span>` : ''}
        <span class="clip-name" data-verbatim>${escapeHtml(clip.name)}</span>
        <span class="clip-meta mono">${escapeHtml(clip.codec || '编码未知')} · ${timecode(clip.duration)} · ${sizeText(clip.bytes)}</span>
        <span class="clip-meta">${clip.sample ? '示例' : clip.status}${Object.keys(clip.overrides).length ? ' · 单素材覆盖' : ''}</span>
      </button>
      <button type="button" class="item-menu" data-organize="${clip.id}" aria-label="素材操作" title="素材操作" aria-haspopup="menu" aria-expanded="false">⋯</button>
    </div>`;
  const section = (title, items, group = null) => {
    if (!items.length && !group) return '';
    const hidden = group?.collapsed && !search;
    return `<section class="library-group" ${group ? `data-drop-group="${escapeHtml(group.id)}"` : ''}><div class="group-head">${group ? `<button data-toggle-group="${escapeHtml(group.id)}" aria-expanded="${!hidden}">${hidden ? '▸' : '▾'} <span data-verbatim>${escapeHtml(title)}</span> <small>${items.length}</small></button><button data-group-menu="${escapeHtml(group.id)}" aria-label="文件夹操作" aria-haspopup="menu" aria-expanded="false">⋯</button>` : `<span>${title} <small>${items.length}</small></span>`}</div>${hidden ? '' : `<div class="group-items">${items.map(item).join('')}</div>`}</section>`;
  };
  const pinned = visible.filter(clip => clip.pinned);
  const unpinned = visible.filter(clip => !clip.pinned);
  const ungrouped = unpinned.filter(clip => !groups.some(group => group.id === clip.groupId));
  byId('media-list').innerHTML = section('置顶', pinned) + groups.map(group => section(group.name, unpinned.filter(clip => clip.groupId === group.id), group)).join('') + section('未分组', ungrouped) ||
    (visibleClips().length ? '<p class="muted">未找到匹配素材</p>' : '<p class="muted library-empty">暂无素材</p>');
  const picked = selectedClips();
  const count = visibleClips().length;
  byId('select-all').disabled = !count;
  byId('select-all').checked = count > 0 && picked.length === count;
  byId('select-all').indeterminate = picked.length > 0 && picked.length < count;
  const totalDuration = picked.every(clip => Number.isFinite(clip.duration))
    ? picked.reduce((sum, clip) => sum + clip.duration, 0) : NaN;
  byId('batch').textContent = count + ' 项素材 · 已选 ' + picked.length + ' 项 · ' +
    timecode(totalDuration) + ' · ' + sizeText(picked.reduce((sum, clip) => sum + clip.bytes, 0));
  localize(byId('media-list'));
  localize(byId('batch'));
}

function field(label, key, options, current = config()[key]) {
  const unavailable = current && !options.includes(current) ? `<option value="${escapeHtml(current)}" selected disabled>请重新选择（${escapeHtml(current)}）</option>` : '';
  return `<label>${label}<select data-field="${key}">${unavailable}${options.map(option =>
    `<option value="${escapeHtml(option)}" ${option === current ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
}
function textField(label, key) {
  return `<label>${label}<input data-field="${key}" value="${escapeHtml(config()[key])}"></label>`;
}
function panel(title, body, extra = '') {
  return `<article class="panel"><div class="panel-head"><h2>${title}</h2></div><div class="panel-body stack">${body}</div>${extra}</article>`;
}
function header(title, subtitle, action = '') {
  return `<div class="workspace-head"><div><h1>${title}</h1><p class="muted">${subtitle}</p></div>${action}</div>`;
}
function stageControls(label, enabled, controls) {
  return `<section class="stage-controls" data-enabled="${enabled}" aria-label="${label}">
    <div class="stage-heading"><strong>${label}</strong><span class="stage-status">${enabled ? '已启用' : '已关闭'}</span></div>
    <div class="stage-actions">${controls}</div>
  </section>`;
}
function stageSwitch(key, label, enabled) {
  return `<input class="stage-switch" type="checkbox" role="switch" data-field="${key}" aria-label="${label}" ${enabled ? 'checked' : ''}>`;
}
function scopePicker() {
  return `<div class="toolbar"><span class="muted">设置范围</span><select id="scope" aria-label="设置范围">
    <option value="clip" ${scope === 'clip' ? 'selected' : ''}>当前素材</option>
    <option value="batch" ${scope === 'batch' ? 'selected' : ''}>批次默认 · 已选 ${selectedClips().length} 项</option>
    </select>${scope === 'batch' ? '<button data-action="apply">应用至选中项</button>' : '<button data-action="inherit">恢复批次默认</button>'}</div>`;
}
const hiddenPreviewCaptions = new Set();
const captionStyles = {box:'黑底白字', outline:'白字描边', shadow:'白字柔影', amber:'暖金描边'};
const defaultCaptionPosition = [.5,.91];
const captionSize = settings => Number.isInteger(settings.captionSize) && settings.captionSize >= 50 && settings.captionSize <= 175
  ? settings.captionSize : 100;
const captionMeasure = document.createElement('canvas').getContext('2d');
const captionGraphemes = new Intl.Segmenter(undefined, {granularity:'grapheme'});
const captionPages = new WeakMap();
const captionFontFamily = settings =>
  JSON.stringify(settings.captionFont || defaultCaptionFontName) + ', ' + JSON.stringify(defaultCaptionFontName) + ', -apple-system, BlinkMacSystemFont, sans-serif';
const captionWidthRatio = x => Math.min(.88,2*Math.min(x,1-x)-.04);

function wrapCaption(text, width) {
  const lines = [];
  const cjk = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
  for (const paragraph of text.split(/\r?\n/)) {
    const chars = Array.from(captionGraphemes.segment(paragraph.trim()), entry => entry.segment);
    let first = 0;
    while (first < chars.length) {
      let line = '', fit = first, word = first, phrase = first;
      for (; fit < chars.length; fit++) {
        line += chars[fit];
        const length = captionMeasure.measureText(line.trimEnd()).width;
        if (length > width) break;
        const next = chars[fit+1] || '';
        const here = chars[fit];
        if (/\s/u.test(next) || ((cjk.test(here) || cjk.test(next)) &&
            !/[（《「『【(]/u.test(here) && !/[，。！？；：、）》」』】]/u.test(next))) word = fit+1;
        if (length >= width*.72 && /[.!?。！？；;，,]/u.test(here) && word === fit+1) phrase = fit+1;
      }
      const end = fit === chars.length ? fit : Math.max(first+1,phrase > first ? phrase : word > first ? word : fit);
      const part = chars.slice(first,end).join('').trim();
      if (part) lines.push(part);
      first = end;
      while (first < chars.length && /\s/u.test(chars[first])) first++;
    }
  }
  return lines;
}

function subtitleDisplayPages(clip, row, withSpeaker = false) {
  const speaker = withSpeaker && row.speaker?.trim();
  const text = row.text?.trim();
  if (!text || row.start >= row.end) return [];
  const settings = effective(clip);
  const video = clip.sourceInfo?.video;
  const dimensions = clip.resolution?.match(/(\d+)\s*[×x]\s*(\d+)/);
  const aspect = video?.width && video?.height ? video.width/video.height :
    dimensions ? Number(dimensions[1])/Number(dimensions[2]) : 16/9;
  const fontSize = 16*captionSize(settings)/100;
  const width = 288*aspect*captionWidthRatio((settings.captionPosition || defaultCaptionPosition)[0])*.96-fontSize;
  const font = fontSize + 'px ' + captionFontFamily(settings);
  const content = speaker ? speaker + '：' + text : text;
  const signature = JSON.stringify([content,row.start,row.end,width,font]);
  const cached = captionPages.get(row);
  if (cached?.signature === signature) return cached.pages;
  captionMeasure.font = font;
  const lines = wrapCaption(content,width);
  const chunks = [];
  for (let i = 0; i < lines.length;) {
    const remaining = lines.length-i;
    const count = remaining === 3 && /[.!?。！？]/u.test(lines[i].slice(-1)) ? 1 : 2;
    chunks.push(lines.slice(i,i+count).join('\n'));
    i += count;
  }
  let pages = [{start:row.start,end:row.end,text:content}];
  if (chunks.length && (chunks.length === 1 || row.end-row.start >= chunks.length*.01)) {
    const weights = chunks.map(chunk => Array.from(chunk.replace(/\s/gu,'')).length);
    let weightLeft = weights.reduce((total,weight) => total+weight,0);
    let start = row.start;
    pages = chunks.map((chunk,index) => {
      const left = chunks.length-index-1;
      const end = left ? Math.min(row.end-left*.01,
        start+Math.max(.01,(row.end-start)*weights[index]/weightLeft)) : row.end;
      const page = {start,end,text:chunk};
      start = end;
      weightLeft -= weights[index];
      return page;
    });
  }
  captionPages.set(row,{signature,pages});
  return pages;
}
let captionFontsRequest;
function captionLook(settings) {
  return Object.hasOwn(captionStyles, settings.captionStyle) ? settings.captionStyle : 'box';
}
function captionVideoBounds(video) {
  const viewer = video.parentElement;
  const scale = Math.min(viewer.clientWidth / video.videoWidth, viewer.clientHeight / video.videoHeight);
  const width = video.videoWidth * scale, height = video.videoHeight * scale;
  return {width, height, left:(viewer.clientWidth-width)/2, top:(viewer.clientHeight-height)/2};
}
function layoutPreviewCaption(caption, video) {
  if (!video.videoWidth) return;
  const settings = effective(active);
  const [x,y] = settings.captionPosition || defaultCaptionPosition;
  const bounds = captionVideoBounds(video);
  caption.style.left = bounds.left + x*bounds.width + 'px';
  caption.style.top = bounds.top + y*bounds.height + 'px';
  caption.style.maxWidth = bounds.width * captionWidthRatio(x) + 'px';
  caption.style.fontSize = bounds.height * (16/288) * captionSize(settings)/100 + 'px';
  caption.style.fontFamily = captionFontFamily(settings);
}
function bindCaptionPosition(video, clip, signal) {
  const caption = byId('preview-caption');
  if (!caption) return;
  const layout = () => layoutPreviewCaption(caption, video);
  const viewer = video.parentElement;
  const guides = page === 3 ? document.createElement('div') : null;
  if (guides) {
    guides.className = 'caption-guides';
    guides.hidden = true;
    guides.setAttribute('aria-hidden','true');
    guides.innerHTML = '<span data-guide="x"></span><span data-guide="y"></span><span data-guide="baseline"></span>';
    viewer.insertBefore(guides,caption);
  }
  const layoutGuides = () => {
    if (!guides || guides.hidden || !video.videoWidth) return;
    const {left,top,width,height} = captionVideoBounds(video);
    Object.assign(guides.style, {left:left+'px',top:top+'px',width:width+'px',height:height+'px'});
    guides.style.setProperty('--caption-baseline',defaultCaptionPosition[1]*100+'%');
  };
  const observer = new ResizeObserver(() => { layout(); layoutGuides(); });
  observer.observe(viewer);
  signal.addEventListener('abort', () => observer.disconnect(), {once:true});
  if (!guides) return;
  let drag = null;
  const snapDistance = 9;
  const set = (x,y,snap = false) => {
    const {width,height} = captionVideoBounds(video);
    const snapX = snap && Math.abs(x-.5)*width <= snapDistance;
    if (snapX) x = .5;
    const boundedY = Math.max(.12,Math.min(.98,y));
    const position = [Math.max(.1,Math.min(.9,x)), boundedY];
    clip.overrides.captionPosition = position;
    layout();
    const captionHeight = caption.getBoundingClientRect().height;
    let horizontal = '';
    if (snap && height) {
      const centered = .5 + captionHeight/(2*height);
      const centerDistance = centered <= .98 ? Math.abs(y-centered)*height : Infinity;
      const baselineDistance = Math.abs(y-defaultCaptionPosition[1])*height;
      if (Math.min(centerDistance,baselineDistance) <= snapDistance) {
        horizontal = centerDistance <= baselineDistance ? 'y' : 'baseline';
        position[1] = horizontal === 'y' ? centered : defaultCaptionPosition[1];
      }
    }
    if (height && position[1]*height < captionHeight + 2) {
      position[1] = Math.min(.98,(captionHeight+2)/height);
      horizontal = '';
    }
    if (position[1] !== boundedY) layout();
    guides.dataset.snapX = String(snapX);
    guides.dataset.snapY = horizontal;
  };
  caption.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !video.videoWidth) return;
    event.preventDefault();
    caption.setPointerCapture(event.pointerId);
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY,
      original:clip.overrides.captionPosition, position:effective(clip).captionPosition || defaultCaptionPosition};
    guides.dataset.snapX = 'false';
    guides.dataset.snapY = '';
    guides.hidden = false;
    layoutGuides();
  }, {signal});
  caption.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const {width,height} = captionVideoBounds(video);
    if (width && height) set(drag.position[0]+(event.clientX-drag.x)/width, drag.position[1]+(event.clientY-drag.y)/height,true);
  }, {signal});
  caption.addEventListener('lostpointercapture', event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    guides.hidden = true;
    scheduleSave();
  }, {signal});
  caption.addEventListener('pointercancel', event => {
    if (drag?.id !== event.pointerId) return;
    if (drag.original) clip.overrides.captionPosition = drag.original;
    else delete clip.overrides.captionPosition;
    drag = null;
    guides.hidden = true;
    layout();
  }, {signal});
  caption.addEventListener('keydown', event => {
    const moves = {ArrowLeft:[-.01,0], ArrowRight:[.01,0], ArrowUp:[0,-.01], ArrowDown:[0,.01]};
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const [x,y] = effective(clip).captionPosition || defaultCaptionPosition;
    set(x+move[0],y+move[1]);
    scheduleSave();
  }, {signal});
}
function setupCaptionFontPicker() {
  const picker = byId('caption-font'), status = byId('caption-font-status');
  if (!picker || active === emptyClip) return;
  const clip = active, selected = effective(clip).captionFont || '';
  const populate = names => {
    if (!picker.isConnected) return;
    for (const name of new Set([...names, ...(selected ? [selected] : [])])) {
      picker.add(new Option(name,name,false,name === selected));
    }
    picker.disabled = false;
    status.textContent = '';
  };
  captionFontsRequest ||= api('caption-fonts').catch(error => { captionFontsRequest = null; throw error; });
  captionFontsRequest.then(populate).catch(() => {
    if (!picker.isConnected) return;
    populate([]);
    status.textContent = translate('无法读取本机字体');
  });
  picker.onchange = () => {
    clip.overrides.captionFont = picker.value || null;
    updatePreviewCaption();
    scheduleSave();
  };
}
function captionStylePicker() {
  const settings = effective(active);
  const selected = captionLook(settings), size = captionSize(settings);
  return panel('字幕样式', `<div class="caption-style-grid" id="caption-styles">${Object.entries(captionStyles).map(([look, label]) =>
    `<button class="caption-style-card" data-caption-style="${look}" aria-pressed="${look === selected}" ${active === emptyClip ? 'disabled' : ''}>
      <span class="caption-style-swatch" aria-hidden="true"><span class="caption-appearance" data-caption-look="${look}">字幕示例</span></span>
      <span>${label}</span></button>`).join('')}</div>
    <div class="caption-layout-toolbar">
      <label>本机字体 <select id="caption-font" disabled><option value="">默认字体</option></select></label>
      <label class="caption-size">字幕字号 <input id="caption-size" type="range" min="50" max="175" step="5" value="${size}" aria-valuetext="${size}%" ${active === emptyClip ? 'disabled' : ''}><output id="caption-size-value" for="caption-size">${size}%</output></label>
      <button data-action="reset-caption-position" ${active === emptyClip ? 'disabled' : ''}>重置字幕位置</button>
    </div><p class="muted caption-layout-note">拖动画面中的字幕可移动位置。</p><p class="muted" id="caption-font-status" aria-live="polite"></p>`);
}
function updatePreviewCaption() {
  const caption = byId('preview-caption'), video = byId('player');
  if (!caption || !video) return;
  const time = video.currentTime;
  const text = hiddenPreviewCaptions.has(active.id) || !video.videoWidth ? '' : active.rows
    .filter(row => row.start <= time && time < row.end && row.text?.trim())
    .flatMap(row => subtitleDisplayPages(active,row))
    .filter(cue => cue.start <= time && time < cue.end)
    .map(cue => cue.text).join('\n');
  if (caption.textContent !== text) caption.textContent = text;
  caption.hidden = !text;
  if (text) layoutPreviewCaption(caption, video);
}
function player() {
  if (!active.url) {
    const empty = active === emptyClip;
    const message = empty ? '尚未导入素材' : active.status === '缺失' ? '素材文件缺失' :
      ['复制中','排队中'].includes(active.status) ? '正在准备素材' : '此素材暂无可播放画面';
    return `<div class="panel viewer-panel"><div class="panel-head"><h2>素材预览</h2><span class="viewer-badge">${empty ? '待导入' : '本地文件'}</span></div>
      <div class="viewer empty-viewer"><div class="empty-caption">${empty
        ? `<div class="empty-drop-card">
            <div class="empty-icon" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2.6" stroke="currentColor" stroke-width="1.6"/><path d="M7 5v14M17 5v14M3 9.5h4M17 9.5h4M3 14.5h4M17 14.5h4M10.5 9.8l4 2.2-4 2.2V9.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
            </div>
            <strong>${message}</strong>
            <span class="empty-sub">支持 MOV、MP4、MKV、MXF、ProRes 及主流相机 Log 素材</span>
            <button class="primary" data-action="import">导入素材</button>
          </div>`
        : `<span>${message}</span>`}</div></div></div>`;
  }
  const preview = `<video id="player" playsinline preload="${[2,3].includes(page) ? 'auto' : 'metadata'}" ${active.sample ? 'poster="review-still.jpg"' : ''} src="${escapeHtml(active.url)}"></video>`;
    return `<div class="panel viewer-panel"><div class="panel-head"><h2>素材预览</h2><span class="viewer-badge">${active.sample ? '示例素材' : '本地文件'}</span></div>
    <div class="viewer preview-viewer${active.sample ? ' sample-viewer' : ''}">${preview}
    <div id="preview-unavailable" class="empty-caption" hidden><span>${active.sourceInfo && !active.sourceInfo.video ? '此素材只有音频' : '此素材暂无可播放画面'}</span></div>
    ${page === 2 ? '<canvas id="transformed-view" class="transformed-view" hidden></canvas><p id="color-preview-status" class="preview-status" hidden></p>' : ''}
    <div id="preview-caption" class="preview-caption caption-appearance" data-caption-look="${captionLook(effective(active))}" ${page === 3 ? 'tabindex="0" aria-label="拖动画面中的字幕可移动位置。"' : ''} hidden></div></div>
    <div class="player-tools"><button data-action="play" aria-label="播放或暂停" ${active.url ? '' : 'disabled'}>播放</button>
    <input id="seek" type="range" min="0" max="${active.duration || 1}" step=".05" value="${active.cursor}" aria-label="播放位置" ${active.url ? '' : 'disabled'}>
    <time id="clock">${timecode(active.cursor)}</time><span class="muted mono">/ ${timecode(active.duration)}</span>
    ${active.rows.length ? `<button data-action="preview-captions" aria-pressed="${!hiddenPreviewCaptions.has(active.id)}">显示字幕</button>` : ''}
    ${page === 2 ? `<div class="toolbar color-preview-views" role="group" aria-label="预览信号">
      <button id="color-preview-original" aria-pressed="true">原片</button>
      <button id="color-preview-toggle" aria-pressed="false" aria-describedby="color-preview-quality">转换后</button></div>
      <label class="preview-resolution">预览分辨率 <select id="color-preview-resolution">
        <option value="auto">自动</option><option value="360">360p</option><option value="720">720p</option>
        <option value="1080">1080p</option><option value="source">原分辨率</option>
      </select></label>` : ''}</div>
    ${page === 2 ? '<p id="color-preview-quality" class="preview-quality muted" hidden></p>' : ''}</div>`;
}
function previewLayout(details, belowPreview = '') {
  return '<div class="split preview-layout"><div class="stack">' + player() +
    (belowPreview ? '<div class="stack workspace-change">' + belowPreview + '</div>' : '') +
    '</div><div class="stack workspace-change">' + details + '</div></div>';
}
function motionEnabled() {
  return !reduceMotion && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function facts() {
  const details = [
    ['文件名', active.name], ['时长', timecode(active.duration)], ['文件大小', active.bytes == null ? '未知' : sizeText(active.bytes)],
    ['编码', active.codec], ['分辨率', active.resolution], ['帧率', active.fps],
    ['位深／色度', active.depth && active.chroma ? active.depth + ' / ' + active.chroma : null],
    ['音轨', active.audio], ['色域／Gamma', '需人工确认'], ['位置', active.mediaId ? '开发版项目副本' : '未知']
  ];
  return '<dl class="facts">' + details.map(([label, data]) => '<dt>' + label + '</dt><dd' + (label === '文件名' && active !== emptyClip ? ' data-verbatim' : '') + '>' +
    escapeHtml(data || '未知') + '</dd>').join('') + '</dl>';
}
function importPage() {
  return header('导入', '选择素材、检查属性，并为后续处理选择批次。', active === emptyClip ? '' : '<button class="primary" data-action="import">导入素材</button>') +
    previewLayout(panel('素材属性', facts() +
      `<label>试听与识别音轨 <select id="track" ${(active.tracks || []).length ? '' : 'disabled'}>
      ${(active.tracks || []).map(track => `<option value="${track.index}">音轨 ${track.index + 1} · ${escapeHtml(track.codec || '')} ${escapeHtml(track.language || '')}</option>`).join('') || '<option value="0">未发现音轨</option>'}</select></label>
      <p class="notice">素材复制到本地项目库，原文件保持不变。</p>`)) + mediaBatch();
}
function progressMeter(key, value, label, style = '') {
  const known = Number.isFinite(value);
  const amount = known ? Math.max(0,Math.min(100,value)) : 0;
  return `<div class="meter ${style}" role="progressbar" data-meter="${escapeHtml(key)}" aria-label="${escapeHtml(translate(label))}"
    ${known ? `aria-valuenow="${amount}"` : ''}><span style="--progress:${amount/100}"></span></div>`;
}
function previousProgress(root) {
  return new Map([...root.querySelectorAll('[data-meter][aria-valuenow]')].map(el => {
    const fill = el.firstElementChild;
    const displayed = fill.getAnimations().length ? new DOMMatrix(getComputedStyle(fill).transform).a * 100 : +el.getAttribute('aria-valuenow');
    return [el.dataset.meter,displayed];
  }));
}
function animateProgress(root, previous) {
  if (!motionEnabled()) return;
  for (const el of root.querySelectorAll('[data-meter][aria-valuenow]')) {
    const start = previous.get(el.dataset.meter), end = +el.getAttribute('aria-valuenow');
    if (start === undefined || start === end) continue;
    el.firstElementChild.animate([{transform:`scaleX(${start/100})`},{transform:`scaleX(${end/100})`}],
      {duration:230,easing:'ease-out'});
  }
}
function mediaBatch() {
  const items = visibleClips().filter(clip => clip.batch === active.batch);
  const sample = Boolean(active.sample);
  const demoStates = [
    ['已完成', 100, 'done'], ['处理中', 63, 'running'], ['排队中', 0, 'waiting']
  ];
  const states = items.map((clip, index) => {
    if (sample) return demoStates[index];
    if (clip.status === '已就绪') return ['已就绪', 100, 'done'];
    if (['失败','分析失败','已中断','缺失'].includes(clip.status)) return [clip.status, 0, 'failed'];
    return [clip.status || '排队中', clip.progress ?? null, 'running'];
  });
  const done = states.filter(([, , style]) => style === 'done').length;
  const counters = [[items.length, '已导入'], [done, sample ? '已完成' : '已就绪'],
                    [items.length - done, sample ? '待处理' : '未就绪']];
  const rows = items.map((clip, index) => {
    const [status, progress, style] = states[index];
    return `<div class="batch-row"><div class="batch-row-head">
      <button data-clip="${clip.id}" aria-label="${escapeHtml('查看素材 ' + clip.name)}" title="${escapeHtml(clip.name)}" data-verbatim>${escapeHtml(clip.name)}</button>
      <span class="batch-status ${style}">${status}</span>${progress !== null ? `<span class="mono">${progress}%</span>` : ''}
      ${['失败','已中断','缺失'].includes(clip.status) ? `<button data-retry="${clip.id}">重新选择文件</button>` : ''}
      ${clip.status === '分析失败' ? `<button data-probe="${clip.id}">重新分析</button>` : ''}
      ${['排队中','复制中'].includes(clip.status) ? `<button data-cancel="${clip.id}">取消</button>` : ''}
    </div>${progressMeter('import-'+clip.id,progress,status,style)}</div>`;
  }).join('');
  const number = active.batch ? ' <span class="mono">· ' + String(active.batch).padStart(3, '0') + '</span>' : '';
  return `<section class="panel media-batch" id="media-batch">
    <div class="panel-head"><h2>媒体批次${number}</h2><span class="muted">${sample ? '示例处理状态' : '媒体读取状态'}</span></div>
    <div class="panel-body">
      <dl class="batch-metrics">${counters.map(([count, label]) =>
        `<div><dt>${label}</dt><dd class="mono">${count}</dd></div>`).join('')}</dl>
      <div class="batch-items">${rows || '<p class="muted">导入一组素材后，可在这里查看批次状态。</p>'}</div>
      ${sample ? '<p class="muted batch-note">示例进度仅用于预览界面。</p>' : ''}
    </div>
  </section>`;
}

function updateBatch() {
  const batch = byId('media-batch');
  if (!batch) return;
  const previous = previousProgress(batch);
  batch.outerHTML = mediaBatch();
  const updated = byId('media-batch');
  animateProgress(updated,previous);
  localize(updated);
}
function needsVideoEncoding(settings) {
  return settings.transcode || settings.transform || settings.subtitleMode === 'burn';
}
function colorSelection(settings) {
  const reverse = settings.colorDirection === 'to_log';
  const sdr = {'Rec.709':'709','Gamma 2.2':'709-22','Gamma 2.4':'709-24'};
  const legacy = reverse ? {
    input_id:sdr[settings.inputGamma] || '', output_id:'canon3',
    range:settings.inputRange || '未知', matrix:'BT.709'
  } : {
    input_id:settings.inputGamut === 'Canon Cinema Gamut' && settings.inputGamma === 'Canon Log 3' ? 'canon3' : '',
    output_id:sdr[settings.outputGamma] || '709',
    range:settings.inputRange || '未知', matrix:settings.inputMatrix || '未知'
  };
  const saved = settings[reverse ? 'logColor' : 'viewColor'] || {};
  const selection = {strategy:'clip',highlight:'off',ootf:'off',
    white_adapt:'on',input_peak:400,output_peak:100,output_range:'auto',output_matrix:'auto', ...legacy, ...saved};
  // Old projects use “未知” for input settings that were never confirmed.
  if (!selection.range || selection.range === '未知') selection.range = '完整';
  if (!selection.matrix || selection.matrix === '未知') selection.matrix = 'BT.709';
  const input = colorEndpoint(selection.input_id), output = colorEndpoint(selection.output_id);
  if (reverse || input?.fixed_output || (output && output.group !== 'sdr')) {
    selection.tone = 'none';
  } else {
    selection.tone ??= saved.highlight === 'shoulder' ? 'legacy' : 'freeman';
  }
  return selection;
}
function colorEndpoint(id) {
  return colorPresets.find(item => item.id === id);
}
function colorLabel(settings) {
  const state = colorSelection(settings), target = colorEndpoint(state.output_id);
  return target ? target.gamut + ' / ' + target.curve : '未知';
}
function colorDescription(settings) {
  const state = colorSelection(settings), source = colorEndpoint(state.input_id);
  return (source ? source.gamut + ' / ' + source.curve : '未知') + ' → ' + colorLabel(settings) +
    ' · ' + state.range + ' / ' + state.matrix + ' · ' + translate(source?.fixed_output ? '厂商 LUT' :
      state.strategy === 'compress' ? '向中性轴压缩' : '按通道裁切') +
    (state.highlight === 'shoulder' ? ' · ' + translate('柔和滚降') : '');
}
function setColorSelection(key, value) {
  const current = config();
  const target = scope === 'batch' ? defaults : active.overrides;
  const slot = current.colorDirection === 'to_log' ? 'logColor' : 'viewColor';
  const savedTone = current[slot]?.tone;
  target[slot] = {...colorSelection(current), [key]:value};
  const fixedOutput = key === 'input_id' && colorEndpoint(value)?.fixed_output;
  if (fixedOutput) target[slot].output_id = fixedOutput;
  const next = target[slot];
  const source = colorEndpoint(next.input_id), output = colorEndpoint(next.output_id);
  if (key !== 'tone') {
    if (savedTone == null) delete next.tone;
    else next.tone = savedTone;
  }
  if (source?.fixed_output || (output && output.group !== 'sdr')) { next.strategy = 'clip'; next.highlight = 'off'; }
  if (source?.fixed_output) next.ootf = 'off';
  scheduleSave();
}
function switchColorDirection(direction) {
  const current = config();
  const target = scope === 'batch' ? defaults : active.overrides;
  const reverse = current.colorDirection === 'to_log';
  const previousSlot = reverse ? 'logColor' : 'viewColor';
  if (!current[previousSlot]) {
    const previous = colorSelection(current);
    delete previous.tone;
    target[previousSlot] = previous;
  }
  const slot = direction === 'to_log' ? 'logColor' : 'viewColor';
  if (!current[slot]) {
    target[slot] = direction === 'to_log' ?
      {input_id:'',output_id:'canon3',range:'未知',matrix:'未知',strategy:'clip'} :
      {input_id:'',output_id:'709',range:'未知',matrix:'未知',strategy:'clip'};
  }
  target.colorDirection = direction;
  scheduleSave();
  render();
}
function videoAudioLabel(settings) {
  if (settings.audio === '不输出音频') return settings.audio;
  return {MP4:'AAC',WebM:'Opus',MXF:'PCM 24-bit / 48 kHz'}[containerFor(settings)] || settings.audio;
}

const encoderEngines = {cpu:'CPU 软件编码',videotoolbox:'Apple VideoToolbox',qsv:'Intel Quick Sync',nvenc:'NVIDIA NVENC',amf:'AMD AMF',none:'无需重新编码'};
const encoderModes = {auto:'自动',cpu:'CPU',gpu:'GPU'};
const encoderChecks = new Map();
function encoderSelection(clip, payload) {
  if (payload.kind !== 'video' || !(payload.transcode || payload.transform || payload.subtitle_mode === 'burn')) {
    return {engine:'none'};
  }
  if (experimentalProfiles.includes(payload.profile)) return modernCodecs[payload.profile] ?
    {engine:payload.encoder_mode === 'gpu' ? null : 'cpu',reason:'此档位仅支持 CPU'} :
    {engine:null,reason:'本机缺少该编码器'};
  if (payload.encoder_mode === 'cpu') return {engine:'cpu'};
  if (payload.target_size_mb !== null && payload.target_size_mb !== undefined) {
    return {engine:payload.encoder_mode === 'gpu' ? null : 'cpu',reason:'按目标体积需使用 CPU 编码'};
  }
  if (!clip.mediaId || clip.status !== '已就绪') return null;
  if (payload.transform && (!colorEndpoint(payload.color.input_id)?.input || !colorEndpoint(payload.color.output_id)?.output ||
      !payload.color.range || !payload.color.matrix)) return null;
  const movie = clip.sourceInfo?.video;
  const key = JSON.stringify([payload.encoder_mode,payload.profile,payload.transform ? payload.color :
    movie ? [movie.primaries,movie.transfer,movie.matrix,movie.range] : clip.mediaId]);
  if (encoderChecks.has(key)) return encoderChecks.get(key);
  encoderChecks.set(key,null);
  api('export-encoder',{media_id:payload.media_id,profile:payload.profile,encoder_mode:payload.encoder_mode,
      kind:payload.kind,transcode:payload.transcode,transform:payload.transform,color:payload.color,subtitle_mode:payload.subtitle_mode})
    .then(result => encoderChecks.set(key,result))
    .catch(() => encoderChecks.set(key,{engine:payload.encoder_mode === 'gpu' ? null : 'cpu',reason:'无法检查本机硬件编码'}))
    .finally(() => { if (page === 4) refreshDeliveryConfirmation(); else if (page === 1) updateEncoderPath(); });
  return null;
}
function encoderLabel(selection) {
  if (!selection) return translate('正在检查编码路径');
  const engine = selection.engine ? translate(encoderEngines[selection.engine]) : '';
  return [engine,selection.reason && translate(selection.reason)].filter(Boolean).join(' · ');
}
function updateEncoderPath() {
  const result = byId('encoder-path');
  if (!result) return;
  const settings = config();
  const selection = encoderSelection(active,{media_id:active.mediaId,kind:'video',profile:settings.preset,
    encoder_mode:settings.encoderMode || 'auto',transcode:settings.transcode,transform:settings.transform,
    subtitle_mode:settings.subtitleMode,color:colorRequestSettings(settings),
    target_size_mb:settings.targetSize === '' || settings.targetSize == null || !sizeProfile(settings.preset) ? null : +settings.targetSize});
  result.textContent = active === emptyClip ? translate('等待素材') : encoderLabel(selection);
}
function audioSettings() {
  const fixed = {MP4:'AAC',WebM:'Opus',MXF:'PCM 24-bit / 48 kHz'}[containerFor(config())];
  if (!fixed) return field('音频编码','audio',['PCM 24-bit','PCM 16-bit','PCM 32-bit','不输出音频']);
  return `<label>音频编码<select data-field="audio"><option value="PCM 24-bit" ${config().audio !== '不输出音频' ? 'selected' : ''}>${fixed}</option><option value="不输出音频" ${config().audio === '不输出音频' ? 'selected' : ''}>不输出音频</option></select></label>`;
}

function deliveryIssues(clip, settings, options, payload, name) {
  const {kind} = options;
  const issues = [];
  if (kind === 'video' && payload.profile.startsWith('AV2') && (!payload.transcode || payload.transform || payload.subtitle_mode !== 'none' || payload.audio !== '不输出音频')) {
    issues.push([1,'AV2 IVF 当前只支持视频：启用转码、关闭色彩转换和字幕，并选择不输出音频。','#codec-change']);
  }
  const dimensions = [payload.output_width,payload.output_height];
  if (dimensions.some(n=>n !== null) && !dimensions.every(n=>Number.isInteger(n) && n >= 2 && n <= 8192 && n % 2 === 0)) {
    issues.push([1,'请填写 2 到 8192 的偶数宽度和高度。','[data-field="outputWidth"]']);
  }
  if (!clip.mediaId || (kind !== 'subtitles' && clip.status !== '已就绪')) {
    issues.push([0,'素材尚未就绪','[data-action="import"]']);
  }
  const hasVideo = kind === 'video' || kind === 'remux';
  const source = clip.sourceInfo;
  const sourceCodec = source?.video?.codec || clip.codec;
  if (hasVideo && source && !source.video) issues.push([0,'素材没有可导出的视频轨']);
  if (kind === 'audio' && !(source?.audio || clip.tracks)?.length) {
    issues.push([0,'素材没有可导出的音轨']);
  }
  if (kind === 'remux' && !['h264','hevc'].includes(sourceCodec)) {
    issues.push([4,'MKV 直接封装目前支持 H.264 和 H.265','[data-export-setting="kind"]']);
  }
  if (kind === 'remux' && settings.subtitleMode === 'burn') {
    issues.push([3,'仅换容器不能烧录字幕','[data-field="subtitleMode"]']);
  }
  if (payload.transform) {
    const state = payload.color, sourcePreset = colorEndpoint(state.input_id), target = colorEndpoint(state.output_id);
    const reverse = state.direction === 'to_log';
    if (!sourcePreset?.input || (reverse && sourcePreset.group !== 'sdr')) {
      issues.push([2,'请选择有效的输入色彩预设','[data-color-pick="input_id"]']);
    }
    if (!target?.output || (reverse ? target.group !== 'log' : !['sdr','hdr'].includes(target.group)) ||
        (sourcePreset?.fixed_output && sourcePreset.fixed_output !== state.output_id)) {
      issues.push([2,'请选择有效的输出色彩预设','[data-color-pick="output_id"]']);
    }
    if (!state.range) issues.push([2,'请确认输入电平','[data-color-setting="range"]']);
    if (!state.matrix) issues.push([2,'请确认输入 YCbCr 矩阵','[data-color-setting="matrix"]']);
    if (!validTonePeaks(state)) issues.push([2,tonePeakHint(state.tone),'[data-color-control="input_peak"]']);
    if (reverse && (!settings.preset.startsWith('ProRes') || payload.container !== 'mov')) {
      issues.push([1,'转为 Log 请选择 ProRes MOV','#codec-change']);
    }
    if (target?.profiles && !target.profiles.includes(settings.preset)) {
      issues.push([1,'HDR 请选择 10-bit H.265 或 AV1','#codec-change']);
    }
  }
  if ((kind === 'subtitles' || payload.subtitle_mode !== 'none') && !payload.subtitles.length) {
    issues.push([3,'当前素材没有可用字幕','[data-action="import-srt"]']);
  }
  if (payload.container === 'mxf' && payload.subtitle_mode === 'soft') {
    issues.push([3,'MXF 不支持此软字幕交付方式','[data-field="subtitleMode"]']);
  }
  if (kind === 'video' && !needsVideoEncoding(settings)) {
    const compatible = {mp4:['h264','hevc','av1','mpeg4'],webm:['vp8','vp9','av1'],mxf:['dnxhd']}[payload.container];
    if (compatible && sourceCodec && !compatible.includes(sourceCodec)) {
      issues.push([1,'源编码与所选容器不兼容，请启用转码','[data-field="transcode"]']);
    }
  }
  if (!options.destination.trim()) issues.push([4,'请先选择输出文件夹','#export-destination']);
  else if (exportDirectoryError) issues.push([4,exportDirectoryError,'#export-destination']);
  if (name === null) issues.push([4,'文件名或模板无效','[data-export-setting="template"]']);
  if (payload.target_size_mb !== null && (!Number.isFinite(payload.target_size_mb) || payload.target_size_mb <= 0)) {
    issues.push([1,'请输入有效的目标体积','[data-field="targetSize"]']);
  } else if (payload.target_size_mb !== null && !needsVideoEncoding(settings)) {
    issues.push([1,'按目标体积需要启用转码','[data-field="transcode"]']);
  }
  return issues;
}
const sizeProfile = profile => /^(H\.26[45]|AV1)/.test(profile);
const transcodeProfiles = ['ProRes 422 Proxy','ProRes 422 LT','ProRes 422','ProRes 422 HQ',
  'H.264 8-bit 4:2:0','H.264 10-bit 4:2:2','H.265 8-bit 4:2:0','H.265 10-bit 4:2:2', ...Object.keys(newProfiles)];
const transcodeKeys = ['preset','quality','bitrate','audio','container','threads','transcode','proresSpeed','encoderMode','targetSize','outputWidth','outputHeight','outputFps'];
const transcodeNumber = (label,key,max) => `<label>${label}<input data-field="${key}" type="number" min="2" max="${max}" step="2" placeholder="保持原值" value="${escapeHtml(config()[key] ?? '')}"></label>`;
const resolutionPresets = {'8K':[7680,4320],'6K':[6144,3456],'4K UHD':[3840,2160],'1080p':[1920,1080],
  '720p':[1280,720],'480p':[854,480],'360p':[640,360]};
const aspectPresets = {'16:9':[16,9],'16:10':[16,10],'3:2':[3,2],'4:3':[4,3],'1:1':[1,1],
  '9:16':[9,16],'4:5':[4,5],'21:9':[21,9]};
function resolutionPicker(settings) {
  return `<div class="resolution-presets"><label>分辨率预设<select id="resolution-preset"><option value="">请选择</option>
    <option value="source">保持原值</option>${Object.entries(resolutionPresets).map(([key,[w,h]])=>
    `<option value="${key}" ${+settings.outputWidth === w && +settings.outputHeight === h ? 'selected' : ''}>${key} · ${w} × ${h}</option>`).join('')}</select></label>
    <label>画幅比例<select id="aspect-preset"><option value="">按当前宽度计算</option>
    ${Object.keys(aspectPresets).map(key=>`<option value="${key}">${key}</option>`).join('')}</select></label></div>`;
}
function applyResolutionPreset(control) {
  if (!control.value) return;
  const target = scope === 'batch' ? defaults : active.overrides;
  if (control.id === 'resolution-preset') {
    [target.outputWidth,target.outputHeight] = resolutionPresets[control.value] || ['', ''];
  } else {
    const [x,y] = aspectPresets[control.value], settings = config();
    const width = Number(settings.outputWidth) || active.sourceInfo?.video?.width || Number.parseInt(active.resolution,10) || 1920;
    const even = n => Math.max(2,Math.min(8192,Math.round(n/2)*2));
    const fitted = Math.min(width,8192,8192*x/y);
    target.outputWidth = even(fitted);
    target.outputHeight = even(fitted*y/x);
  }
  scheduleSave();
  render();
  byId(control.id)?.focus();
}
const outputFpsOptions = ['保持原值','24000/1001','24','25','30000/1001','30','50','60000/1001','60','120'];
const experimentalProfiles = ['H.266 / VVC','H.266 / VVC 8-bit','AV2','AV2 8-bit'];
const codecTitle = name => ({'H.266 / VVC':'H.266 / VVC 10-bit 4:2:0','H.266 / VVC 8-bit':'H.266 / VVC 8-bit 4:2:0',
  'AV2':'AV2 10-bit 4:2:0','AV2 8-bit':'AV2 8-bit 4:2:0','AV1 8-bit':'AV1 8-bit 4:2:0',
  'AV1 10-bit':'AV1 10-bit 4:2:0','VP9':'VP9 8-bit 4:2:0'}[name] || name);
let modernCodecs = {};
const codecFamily = name => ({'H.264':'H.264 / AVC','H.265':'H.265 / HEVC','H.266':'H.266 / VVC'}[name.split(' ')[0]] || name.split(' ')[0]);
const byCodecUse = {
  '剪辑交付': name => /^(ProRes|DNxHR)|4:2:2$/.test(name),
  '兼容分享': name => /^H\.26[45] 8-bit/.test(name),
  '体积优先': name => /^(H\.26[56]|AV[12]|VP9)/.test(name),
  '无损归档': name => name === 'FFV1',
  '仅换容器': () => false,
  '仅导音频': () => false
};
const pixelsFor = name => newProfiles[name]?.at(-1) || name.match(/\d+-bit 4:\d:\d/)?.[0] ||
  (name.startsWith('ProRes 422') ? '10-bit 4:2:2' : '未知');
const sourceSpec = clip => [clip.depth,clip.chroma].filter(Boolean).join(' / ') || '未知';
function compareSpecifications(rows, labels) {
  return `<table class="spec-compare"><thead><tr>${labels.map(x=>`<th scope="col">${escapeHtml(x)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([key,source,target])=>`<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(source || '未知')}</td><td>${escapeHtml(target || '未知')}</td></tr>`).join('')}</tbody></table>`;
}

let codecBrowseMode = 'use';
function openCodecPicker(opener) {
  const dialog = byId('modal');
  const target = scope === 'batch' ? defaults : active.overrides;
  let draft = config().preset, group;
  const names = transcodeProfiles;
  const families = [...new Set(names.map(codecFamily))];
  const defaultGroup = () => codecBrowseMode === 'family' ? codecFamily(draft) :
    Object.keys(byCodecUse).find(key=>byCodecUse[key](draft)) || '体积优先';
  group = defaultGroup();
  modal('更换编码', `<div class="codec-library">
    <div class="toolbar codec-tools"><div id="codec-modes" class="toolbar" role="group" aria-label="分类方式">
    <button type="button" data-mode="use">按用途</button><button type="button" data-mode="family">按编码类型</button></div>
    <input id="codec-search" type="search" aria-label="搜索编码或档位" placeholder="搜索编码或档位"></div>
    <div class="codec-chooser" tabindex="0" role="region" aria-label="编码与档位">
    <section><h3 id="codec-step"></h3><div id="codec-groups" class="toolbar"></div></section>
    <section><h3>02　选择编码与档位</h3><div id="codec-options" class="codec-options"></div></section>
    </div>
    <div class="toolbar codec-actions"><div><span class="muted">待应用</span> <strong id="codec-draft" aria-live="polite"></strong></div><div class="toolbar">
    <button type="button" id="codec-cancel">取消</button><button type="button" id="codec-apply" class="primary">应用方案</button></div></div>
    </div>`, 'codec-library');
  const search = byId('codec-search');
  function renderChoices() {
    const query = search.value.trim().toLowerCase();
    const use = codecBrowseMode === 'use';
    byId('codec-modes').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',button.dataset.mode === codecBrowseMode));
    byId('codec-step').textContent = use ? '01　选择用途' : '01　选择编码家族';
    const groups = use ? Object.keys(byCodecUse) : families;
    byId('codec-groups').innerHTML = groups.map((name,i)=>`<button type="button" data-group="${i}" aria-pressed="${name === group}">${escapeHtml(name)}</button>`).join('');
    byId('codec-groups').onclick = event => {
      const button = event.target.closest('[data-group]');
      if (!button) return;
      group = groups[+button.dataset.group]; search.value = ''; renderChoices();
      byId('codec-groups').querySelector('[aria-pressed=true]')?.focus();
    };
    const results = names.filter(name=>query ? (name+' '+pixelsFor(name)+' '+allowedContainers({preset:name,transcode:true}).join(' ')).toLowerCase().includes(query) :
      use ? byCodecUse[group]?.(name) : codecFamily(name) === group);
    if (use && group === '体积优先') results.sort((a,b) => Number(pixelsFor(b) === '8-bit 4:2:0') - Number(pixelsFor(a) === '8-bit 4:2:0'));
    const exportOnly = !query && use && ['仅换容器','仅导音频'].includes(group);
    byId('codec-options').innerHTML = results.map((name,i) => {
      const pending = experimentalProfiles.includes(name) && !modernCodecs[name];
      return `<button type="button" class="codec-card" data-codec="${i}" aria-pressed="${name === draft}" ${pending ? 'disabled' : ''}>
        <strong>${escapeHtml(codecTitle(name))}</strong><span class="muted">${pending ? '实验 · 缺少编码器' :
          escapeHtml(pixelsFor(name) + ' · ' + allowedContainers({preset:name,transcode:true}).join(' / '))}</span></button>`;
    }).join('') || (exportOnly ? `<div class="stack"><p class="muted">${group === '仅换容器' ?
      '在导出页选择仅换容器，可将兼容的视频流封装到 MKV。' : '在导出页选择仅音频，并选择 WAV、FLAC 或 MP3。'}</p>
      <button type="button" id="codec-export">前往导出设置</button></div>` : '<p class="muted">没有匹配的编码或档位。</p>');
    const exportButton = byId('codec-export');
    if (exportButton) exportButton.onclick = () => {
      dialog.close(); page = 4; render(); byId('workspace').scrollTop = 0;
      byId('workspace').querySelector('[data-export-setting="kind"]')?.focus();
    };
    byId('codec-options').onclick = event => {
      const button = event.target.closest('[data-codec]');
      if (!button || button.disabled) return;
      draft = results[+button.dataset.codec]; renderChoices();
      byId('codec-options').querySelector('[aria-pressed=true]')?.focus();
    };
    byId('codec-draft').textContent = codecTitle(draft);
    byId('codec-apply').disabled = exportOnly || !transcodeProfiles.includes(draft) || experimentalProfiles.includes(draft) && !modernCodecs[draft];
    localize(dialog);
  }
  byId('codec-modes').onclick = event => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    codecBrowseMode = button.dataset.mode; group = defaultGroup(); renderChoices();
  };
  search.oninput = renderChoices;
  byId('codec-cancel').onclick = () => dialog.close();
  byId('codec-apply').onclick = () => {
    if (byId('codec-apply').disabled) return;
    if (draft !== config().preset) { target.preset = draft; scheduleSave(); render(); }
    dialog.close();
  };
  dialog.addEventListener('close', () => {
    if (opener.isConnected) opener.focus();
    else byId('codec-change')?.focus();
  }, {once:true});
  renderChoices();
  search.focus();
}

function transcodePage() {
  const current = effective(active);
  const enabled = config().transcode, source = active.sourceInfo?.video;
  const encode = needsVideoEncoding(current), container = containerFor(current);
  const outputCodec = encode ? current.preset : '复制视频流';
  const outputPixels = encode ? pixelsFor(current.preset) : sourceSpec(active);
  const subsampling = format => /4:[024]:[024]/.exec(format)?.[0] ||
    ({420:'4:2:0',422:'4:2:2',444:'4:4:4'})[/[yuv](420|422|444)/.exec(format)?.[1]];
  const chromaLoss = ['4:2:2','4:4:4'].includes(subsampling(sourceSpec(active))) && subsampling(outputPixels) === '4:2:0';
  const overrides = transcodeKeys.some(key=>Object.hasOwn(active.overrides,key));
  const audio = active.tracks?.length ? videoAudioLabel(current) : '无音轨或未知';
  const track = active.tracks?.length ? '音轨 ' + ((active.track || 0) + 1) : '无音轨或未知';
  const notices = [chromaLoss ? '输出会将源色度采样降为 4:2:0。' : '',
    !current.transcode && encode ? '已跳过转码设置；色彩转换或烧录字幕仍要求重新编码。' : '',
    active.tracks?.length > 1 ? '视频导出只带所选音轨；如需保留更多原轨，请核对导出方式。' : '',
    '源素材不会被覆盖。'];
  const codecNotice = config().preset.startsWith('AV2') ? 'AV2 的 IVF 只输出视频。请关闭音频、字幕与色彩转换；常用播放器可能打不开。' :
    config().preset.startsWith('H.266') ? 'H.266 MP4 是有损编码，使用 CPU。请先确认对方的播放器支持 VVC。' :
    config().preset === 'FFV1' ? 'FFV1 是无损视频编码。文件可能较大，播放支持取决于接收端。' :
    config().preset.startsWith('AV1') ? 'AV1 是有损编码。这里支持导出音轨；请确认对方的播放器支持 AV1。' :
    '此编码会重新压缩画面。位深和色度采样以所选档位为准。';
  const plan = panel('当前转码方案', `<div class="transcode-route">
    <div><small>输入</small><strong>原始素材</strong></div><span aria-hidden="true">→</span>
    <div><small>视频</small><strong>${escapeHtml(outputCodec)}</strong></div><span aria-hidden="true">→</span>
    <div><small>容器</small><strong>${escapeHtml(container)}</strong></div></div>
    <p class="muted">${escapeHtml(sourceSpec(active))} → ${escapeHtml(outputPixels)}</p>`);
  const advanced = panel('高级设置', '<div class="fields"><h3>视频质量</h3>' +
      (config().preset.startsWith('ProRes') ? field('ProRes 速度','proresSpeed',['标准','快速（固定量化）'], config().proresSpeed || '标准') : '') +
      (sizeProfile(config().preset) ? `<label>目标体积（MB）<input data-field="targetSize" type="number" min="0.1" step="any"
        value="${escapeHtml(config().targetSize ?? '')}" placeholder="留空按质量编码"></label>
        <p class="muted">填写预计成片大小，例如 2000 MB ≈ 2 GB。程序根据时长和音轨估算视频码率，实际大小会有浮动。留空则按质量编码。</p>` : '') +
      (!config().preset.startsWith('ProRes') && !sizeProfile(config().preset) ? '<p class="muted">使用所选编码档位。</p>' : '') +
      resolutionPicker(config()) +
      '<div class="spec-fields">' + transcodeNumber('输出宽度','outputWidth',8192) + transcodeNumber('输出高度','outputHeight',8192) + '</div>' +
      '<p class="muted">宽高都留空时保持原分辨率。画幅不同时保留完整画面，空白处补黑边。</p>' +
      field('输出帧率','outputFps',outputFpsOptions,config().outputFps || '保持原值') +
      '<h3>音频</h3>' + audioSettings() +
      (active.tracks?.length ? `<label>输出音轨（当前素材）<select id="transcode-track">${active.tracks.map((_,i)=>`<option value="${i}" ${i === (active.track || 0) ? 'selected' : ''}>音轨 ${i+1}</option>`).join('')}</select></label>` :
        '<p class="muted">无音轨或未知</p>') + '</div>');
  const performance = panel('性能', `<div class="fields"><label>解码与编码线程上限<select data-field="threads"><option value="auto" ${config().threads === 'auto' ? 'selected' : ''}>自动（按逻辑处理器调整，最多 10）</option>${[1,2,3,4,6,8,10,12,16,24,32,48,64].map(n => `<option value="${n}" ${String(config().threads) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}</select></label><p class="muted">同一上限分别用于解码器和编码器，并非总 CPU 核心数限制。</p>
      <label>编码路径<select data-field="encoderMode">${Object.entries(encoderModes).map(([value,label]) => `<option value="${value}" ${(config().encoderMode || 'auto') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><p id="encoder-path" class="muted" aria-live="polite"></p></div>`);
  const details = panel('当前素材生效设置', `<div class="toolbar spec-heading"><strong data-verbatim>${escapeHtml(active.name)}</strong>
    <span class="muted">${overrides ? '单素材覆盖' : '继承批次默认'}</span></div>` +
    compareSpecifications([
      ['编码',active.codec,outputCodec],['容器',active.sourceInfo?.container,container],
      ['分辨率',active.resolution,current.transcode && current.outputWidth && current.outputHeight ? current.outputWidth+' × '+current.outputHeight : active.resolution],
      ['帧率',active.fps,current.transcode && current.outputFps && current.outputFps !== '保持原值' ? current.outputFps : active.fps],
      ['位深／采样',sourceSpec(active),outputPixels],
      ['色彩',source ? [source.primaries,source.transfer,source.matrix,source.range].map(x=>x || '未知').join(' / ') : '未知',
       current.transform ? colorLabel(current) : '不转换'],
      ['音频',active.audio,audio === '不输出音频' || audio === track ? audio : [audio,track].join(' · ')],
      ['线程上限','—',current.threads === 'auto' ? '自动' : current.threads]
    ],['属性','源素材','计划输出']) +
    `<p class="notice">${notices.filter(Boolean).join(' ')}</p>`);
  return header('转码', '为剪辑、分享或节省空间选择编码方案。', scopePicker()) +
    stageControls('启用转码', enabled, stageSwitch('transcode', '启用转码', enabled)) +
    previewLayout(panel('编码设置', `<div class="codec-current"><div><small class="muted">视频编码</small>
      <strong>${escapeHtml(codecTitle(config().preset))}</strong><span class="muted">${escapeHtml(pixelsFor(config().preset))}</span></div>
      <button id="codec-change" data-action="codec-change" ${scope === 'clip' && active === emptyClip ? 'disabled' : ''}>更换</button></div>
      <p class="notice">${codecNotice}</p>
      <div class="fields">${field('容器','container',['自动', ...allowedContainers(config())])}</div>`) + details + performance, plan + advanced);
}
function containerFor(settings) {
  const options = allowedContainers(settings);
  return options.includes(settings.container) ? settings.container : options[0];
}
function allowedContainers(settings) {
  if (newProfiles[settings.preset]) return newProfiles[settings.preset].slice(0,-1);
  return settings.preset.startsWith('H.26') ? ['MP4','MOV'] :
    needsVideoEncoding(settings) ? ['MOV'] : ['MOV','MP4'];
}
function deliveryContainer(settings, options) {
  if (options.kind === 'subtitles') return 'SRT';
  if (options.kind === 'audio') return options.audioFormat;
  return options.kind === 'remux' ? 'MKV' : containerFor(settings);
}
function estimateProres(clip, settings) {
  const video = clip.sourceInfo?.video, duration = clip.sourceInfo?.duration;
  const numerator = {'ProRes 422 Proxy':45,'ProRes 422 LT':102,'ProRes 422':147,'ProRes 422 HQ':220}[settings.preset];
  const parts = String(video?.frame_rate || '').split('/').map(Number);
  const fps = parts.length === 2 ? parts[0] / parts[1] : parts[0];
  if (!numerator || !video?.width || !video?.height || !duration || !Number.isFinite(fps) || fps <= 0) return null;
  const videoBits = numerator * 1e6 * video.width * video.height / (1920 * 1080) * fps / 30;
  const track = clip.sourceInfo?.audio?.[clip.track || 0];
  const bits = {'PCM 16-bit':16,'PCM 24-bit':24,'PCM 32-bit':32}[settings.audio] || 0;
  const audioBits = track ? (track.sample_rate || 48000) * (track.channels || 2) * bits : 0;
  return (videoBits + audioBits) * duration / 8;
}
function outputNamePreview(clip, payload) {
  const template = payload.template || '{name}_{profile}';
  if (template.length > 160 || /[{}]/.test(template.replaceAll('{name}','').replaceAll('{profile}',''))) return null;
  const dot = clip.name.lastIndexOf('.');
  const original = dot > 0 ? clip.name.slice(0,dot) : clip.name;
  const profile = (payload.kind === 'video' ? payload.profile : payload.kind === 'remux' ? 'Copy' : payload.container.toUpperCase())
    .replaceAll(' ','_');
  const base = template.replaceAll('{name}',() => original).replaceAll('{profile}',() => profile)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0,180);
  if (!base || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) return null;
  return base + '.' + payload.container;
}
function deliveryPlan(clip, options) {
  const settings = effective(clip);
  const {kind} = options;
  const video = kind === 'video', copy = kind === 'remux' || (video && !needsVideoEncoding(settings));
  const subtitleMode = kind === 'audio' || kind === 'subtitles' ? 'none' : settings.subtitleMode;
  const payload = {
    media_id:clip.mediaId, profile:settings.preset, audio:settings.audio, track:clip.track || 0,
    output_width:video && settings.transcode && settings.outputWidth ? +settings.outputWidth : null,
    output_height:video && settings.transcode && settings.outputHeight ? +settings.outputHeight : null,
    output_fps:video && settings.transcode && settings.outputFps && settings.outputFps !== '保持原值' ? settings.outputFps : null,
    threads:settings.threads === 'auto' ? 'auto' : Number(settings.threads),
    encoder_mode:settings.encoderMode || 'auto',
    target_size_mb:video && sizeProfile(settings.preset) && settings.targetSize !== '' && settings.targetSize != null ? +settings.targetSize : null,
    kind, mux_audio:options.muxAudio, copy_subtitles:kind === 'remux' && options.muxSubtitles === '保留',
    studio_id:studioId,
    prores_speed:settings.proresSpeed === '快速（固定量化）' ? 'fixed' : 'standard',
    transcode:video && settings.transcode, container:deliveryContainer(settings,options).toLowerCase(),
    subtitle_mode:subtitleMode, subtitles:kind === 'subtitles' || subtitleMode !== 'none' ?
      clip.rows.flatMap(row => subtitleDisplayPages(clip,row)) : [],
    caption_style:captionLook(settings), caption_font:settings.captionFont || null,
    caption_position:settings.captionPosition || null, caption_size:captionSize(settings),
    transform:video && settings.transform, color:colorRequestSettings(settings),
    destination:options.destination.trim(), template:options.template, collision:options.collision
  };
  const name = outputNamePreview(clip,payload);
  const issues = deliveryIssues(clip,settings,options,payload,name);
  const encoder = encoderSelection(clip,payload);
  if (!issues.length && (!encoder || !encoder.engine)) {
    issues.push([1,encoder?.reason || '正在检查编码路径','[data-field="encoderMode"]']);
  }
  return {clip, settings, payload, name, copy, encoder, encode:video && !copy, issues};
}
function currentDeliveryPlans() {
  const options = {...exportConfig};
  return (repairDelivery ? [repairDelivery] : selectedClips()).map(clip => deliveryPlan(clip,options))
    .sort((a,b) => Number(!a.issues.length)-Number(!b.issues.length));
}
function colorPage() {
  const enabled = config().transform;
  const reverse = config().colorDirection === 'to_log';
  const state = colorSelection(config());
  const source = active.sourceInfo?.video;
  const range = {1:'有限',2:'完整'}[source?.range] || '未知';
  const matrix = {1:'BT.709',9:'BT.2020 NCL'}[source?.matrix] || '未知';
  const actual = colorSelection(effective(active));
  const input = colorEndpoint(actual.input_id), output = colorEndpoint(actual.output_id);
  const actualEnabled = effective(active).transform;
  const editableMapping = !!colorEndpoint(state.input_id)?.input && !colorEndpoint(state.input_id)?.fixed_output && colorEndpoint(state.output_id)?.group === 'sdr';
  const editableAdvanced = !!colorEndpoint(state.input_id)?.input && !colorEndpoint(state.input_id)?.fixed_output && !!colorEndpoint(state.output_id);
  const peaks = editableMapping && ['simple','luminance','freeman'].includes(state.tone);
  const peakField = (label,key) => `<label>${label}<input type="number" min="1" max="10000" step="any" data-color-control="${key}" value="${escapeHtml(state[key])}" ${peaks ? '' : 'disabled'}></label>`;
  const toneOptions = {none:'无',clip:'裁切',simple:'简易滚降',luminance:'亮度映射',freeman:'Freeman 曲线（Adaptation 9）',...(state.tone === 'legacy' ? {legacy:'柔和滚降（旧项目）'} : {})};
  const colorSelect = (label,key,items,disabled = false) => `<label>${label}<select data-color-control="${key}" ${disabled ? 'disabled' : ''}>
    ${Object.entries(items).map(([id,name])=>`<option value="${id}" ${state[key] === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`;
  const tag = (known, code) => known[code] || (code && ![0,2].includes(Number(code)) ? String(code) : '未知');
  return header('色彩转换', '确认源信号，再核对技术转换的输出目标。', scopePicker()) +
    stageControls('启用色彩转换', enabled, stageSwitch('transform', '启用色彩转换', enabled)) +
    previewLayout(panel('转换设置', `<div class="color-modes" role="group" aria-label="${translate('转换方向')}">
      <button data-color-direction="to_709" aria-pressed="${!reverse}">转为观看格式</button>
      <button data-color-direction="to_log" aria-pressed="${reverse}">转为 Log 供后续调色</button></div>
      <div class="color-endpoints">${colorCard('输入','input_id',state.input_id, state.range)}${colorCard('输出','output_id',state.output_id)}</div>`) +
      panel('色调映射', `<div class="fields">
      ${colorSelect('色调映射方式','tone',toneOptions,!editableMapping)}
      <div class="spec-fields">${peakField('输入峰值（尼特）','input_peak')}${peakField('输出峰值（尼特）','output_peak')}</div>
      <p class="muted">简易滚降按最大 RGB 通道压高光。亮度映射按线性亮度压高光。峰值决定滚降比例。</p>
      ${state.tone === 'freeman' ? '<p class="muted">Thatcher Freeman 的第三方近似，逐 RGB 通道映射，适配值固定为 9。</p>' : ''}
      ${validTonePeaks(colorRequestSettings(config())) ? '' : `<p class="notice">${tonePeakHint(state.tone)}</p>`}</div>`) +
      panel('色域映射', `<div class="fields">${colorSelect('色域映射方式','strategy',{clip:'无（输出时裁切）',compress:'饱和度压缩'},!editableMapping)}</div>`) +
      panel('高级设置', `<div class="color-advanced color-advanced-compact">
      ${colorChoices('输入电平','range',state.range,['未知','有限','完整'])}
      ${colorChoices('输入 YCbCr 矩阵','matrix',state.matrix,['未知','BT.709','BT.2020 NCL'])}
      <div class="spec-fields fields">
      ${colorSelect('OOTF','ootf',{off:'关闭',auto:'自动',forward:'正向',inverse:'反向'},!editableAdvanced)}
      ${colorSelect('白点自适应','white_adapt',{on:'开启',off:'关闭'},!editableAdvanced)}
      ${colorSelect('输出电平','output_range',{auto:'自动（有限）',limited:'有限',full:'完整'})}
      ${colorSelect('输出 YCbCr 矩阵','output_matrix',{auto:'自动（随输出色域）',bt709:'BT.709',bt2020:'BT.2020 NCL'})}</div>
      <p class="muted">当前预设白点均为 D65，白点自适应对这些组合无影响。</p>
      ${editableMapping ? '' : '<p class="muted">色调和色域映射适用于计算转换到 SDR。</p>'}</div>`) +
      panel('信号详情与提醒', compareSpecifications([
        ['色域',tag({1:'BT.709',9:'BT.2020',12:'P3-D65'},source?.primaries),input?.gamut],
        ['曲线',tag({1:'BT.709',4:'Gamma 2.2',13:'sRGB',14:'BT.2020 (10-bit)',16:'PQ',18:'HLG'},source?.transfer),input?.curve],
        ['电平',range,actual.range],['YCbCr 矩阵',matrix,actual.matrix],
        ['输出目标','—',actualEnabled ? output && [output.gamut,output.curve].join(' / ') : '不转换'],
        ['输出电平','—',actualEnabled ? actual.output_range === 'full' ? '完整' : '有限' : '—'],
        ['输出矩阵','—',actualEnabled ? actual.output_matrix === 'bt2020' || actual.output_matrix === 'auto' && output?.gamut === 'BT.2020' ? 'BT.2020 NCL' : 'BT.709' : '—']
      ],['参数','源文件标记','采用设置／目标']) +
      `<p class="notice">${!actualEnabled ? '已跳过色彩转换，保留当前设置。' :
        !input || !output || !['有限','完整'].includes(actual.range) || !['BT.709','BT.2020 NCL'].includes(actual.matrix) ? '确认输入和输出色彩参数后预览。未知的源标记不会被自动猜测。' :
        effective(active).colorDirection === 'to_log' ? '使用 ProRes MOV。转换后的 Log 无法恢复原片已经丢失的细节。' :
        '示波器读取预览画面。最终电平、矩阵及色彩标记以导出文件为准。'}</p>`),
      waveformPanel());
}
function colorCard(label, key, id, range) {
  const entry = colorEndpoint(id);
  return `<article class="panel color-card"><span class="color-card-label"><span class="picker-eyebrow" aria-hidden="true">${key === 'input_id' ? 'INPUT' : 'OUTPUT'}</span><span class="muted">${label}</span></span>
    <strong>${entry ? escapeHtml(entry.gamut) : '未知'}</strong>
    <span class="muted">${entry ? escapeHtml(entry.curve) : '请选择色彩预设'}${range ? ' · ' + translate('输入电平') + ' ' + translate(range) : ''}</span>
    <button data-color-pick="${key}" ${colorPresets.length ? '' : 'disabled'}>更换</button></article>`;
}
function colorChoices(label, key, current, choices) {
  return `<div><p class="muted">${label}</p><div class="toolbar">${choices.map(value =>
    `<button data-color-setting="${key}" data-color-value="${value}" aria-pressed="${value === current}">${value}</button>`
  ).join('')}</div></div>`;
}
const scopeViews = {luma:'亮度波形',rgb:'RGB 分量波形',vector:'矢量图'};
let scopeView = 'luma', scopeSignal = 'follow';
function waveformPanel() {
  return panel('示波器', `<div class="toolbar scope-controls">
    <div class="toolbar" role="group" aria-label="示波器类型">${Object.entries(scopeViews).map(([mode,label])=>
      `<button type="button" data-scope-view="${mode}" aria-pressed="${scopeView === mode}">${label}</button>`).join('')}</div>
    <label>信号 <select id="scope-signal" ${active.url ? '' : 'disabled'}>
      ${Object.entries({follow:'跟随预览',source:'原片',output:'转换后'}).map(([key,label])=>
       `<option value="${key}" ${scopeSignal === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    <div class="waveform" aria-label="示波器">
    <div id="scope-scale" class="waveform-scale mono" style="visibility:${scopeView === 'vector' ? 'hidden' : 'visible'}" aria-hidden="true"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
    <div class="waveform-plot" data-scope-kind="${scopeView}"><canvas id="waveform" width="384" height="145" role="img" aria-label="${scopeViews[scopeView]}"></canvas>
      <p id="waveform-status" class="muted">${active.url ? '等待视频画面' : '导入视频后显示波形'}</p>
    </div></div><p id="scope-legend" class="waveform-note muted">预览帧 · 非源文件码值</p>`);
}

let stopWaveform, redrawScope;
function attachWaveform(video) {
  const plot = byId('waveform'), status = byId('waveform-status');
  const context = plot.getContext('2d');
  const sample = document.createElement('canvas');
  sample.width = plot.width;
  sample.height = 96;
  const reader = sample.getContext('2d', {willReadFrequently:true});
  const counts = new Uint8Array(plot.width * plot.height);
  const trace = context.createImageData(plot.width, plot.height);
  const events = new AbortController();
  let frame = null, lastDraw = -Infinity;

  const clear = label => {
    context.clearRect(0,0,plot.width,plot.height);
    status.hidden = false;
    status.textContent = translate(label);
  };
  const draw = () => {
    if (video.readyState < 2 || video.seeking) {
      byId('scope-legend').textContent = translate('预览帧 · 非源文件码值');
      clear('等待视频画面'); return;
    }
    if (!video.videoWidth) { clear('此素材没有视频画面'); return; }
    const converted = byId('transformed-view');
    const target = scopeSignal === 'output' || (scopeSignal === 'follow' && converted && !converted.hidden);
    const legend = byId('scope-legend');
    if (target && (!converted || converted.hidden)) {
      legend.textContent = translate('转换后 · 暂无可用画面');
      clear('转换后 · 暂无可用画面'); return;
    }
    legend.textContent = translate(target ? '转换后' : '原片') + ' · ' +
      translate({luma:'相对亮度',rgb:'红／绿／蓝 · 相对值',vector:'近似色度分布'}[scopeView]) + ' · ' + translate('非源文件码值');
    let pixels;
    try {
      reader.drawImage(target ? converted : video,0,0,sample.width,sample.height);
      pixels = reader.getImageData(0,0,sample.width,sample.height).data;
    } catch {
      clear('无法读取当前预览画面');
      return;
    }
    // Sample the rendered RGB preview and accumulate brightness per image column.
    counts.fill(0);
    const {width,height} = plot;
    const third = width / 3;
    const increment = (x,y) => {
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const index = y*width+x;
        if (counts[index] < 255) ++counts[index];
      }
    };
    const row = value => height-1-Math.round(value*(height-1)/255);
    for (let i = 0; i < pixels.length; i += 4) {
      const brightness = .2126*pixels[i] + .7152*pixels[i+1] + .0722*pixels[i+2];
      const x = (i/4) % width;
      if (scopeView === 'rgb') {
        for (let c=0;c<3;c++) increment(Math.floor(x/3+c*third),row(pixels[i+c]));
      } else if (scopeView === 'vector') {
        const cb = (pixels[i+2]-brightness)/1.8556, cr = (pixels[i]-brightness)/1.5748;
        increment(Math.round(width/2+cb*height/286), Math.round(height/2-cr*height/286));
      } else increment(x,row(brightness));
    }
    const rgb = [[243,142,134],[155,224,165],[146,190,247]], neutral = [202,225,231];
    for (let i = 0; i < counts.length; ++i) {
      const pixel = 4*i;
      const color = scopeView === 'rgb' ? rgb[Math.floor((i%width)/third)] : neutral;
      trace.data[pixel] = color[0];
      trace.data[pixel+1] = color[1];
      trace.data[pixel+2] = color[2];
      trace.data[pixel+3] = counts[i] ? Math.min(255, 36 + 45*Math.sqrt(counts[i])) : 0;
    }
    context.putImageData(trace,0,0);
    context.strokeStyle = '#b5bdc353';
    context.beginPath();
    if (scopeView === 'vector') {
      const cx=width/2, cy=height/2, radius=height*.45;
      context.moveTo(cx-radius,cy); context.lineTo(cx+radius,cy);
      context.moveTo(cx,cy-radius); context.lineTo(cx,cy+radius);
      for (const scale of [.5,1]) { context.moveTo(cx+radius*scale,cy); context.arc(cx,cy,radius*scale,0,Math.PI*2); }
    } else if (scopeView === 'rgb') {
      for (const x of [third,third*2]) { context.moveTo(x,0); context.lineTo(x,height); }
    }
    context.stroke();
    status.hidden = true;
  };
  const tick = now => {
    frame = null;
    if (now - lastDraw >= 125) { draw(); lastDraw = now; }
    if (!video.paused && !video.ended) queueFrame();
  };
  const queueFrame = () => {
    if (frame === null && video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(tick);
  };
  const cancelFrame = () => {
    if (frame === null) return;
    video.cancelVideoFrameCallback(frame);
    frame = null;
  };
  const listen = (event, handler) => video.addEventListener(event, handler, {signal:events.signal});
  for (const event of ['loadeddata','seeking','seeked']) listen(event, draw);
  for (const event of ['pause','ended']) listen(event, () => { cancelFrame(); draw(); });
  listen('playing', queueFrame);
  if (!video.requestVideoFrameCallback) listen('timeupdate', () => tick(performance.now()));
  listen('error', () => { cancelFrame(); clear('当前预览不可用'); });
  draw();
  return {draw,stop:() => { events.abort(); cancelFrame(); }};
}
function openColorPicker(key) {
  const settings = config();
  const state = colorSelection(settings);
  const reverse = settings.colorDirection === 'to_log';
  const input = key === 'input_id';
  const standardOnly = input === reverse;
  const fixedOutput = !input && colorEndpoint(state.input_id)?.fixed_output;
  const getChoices = () => colorPresets.filter(p => {
    if (fixedOutput) return p.id === fixedOutput;
    if (standardOnly) return p.group === 'sdr' || (!input && p.group === 'hdr');
    return input ? p.input || p.import_lut : p.group === 'log' && p.output;
  });
  const standards = {'709':'SDR 常用','709-22':'SDR 常用','709-24':'SDR 常用','2020':'SDR 广色域','p3':'SDR 广色域','hlg':'HDR','pq':'HDR'};
  const brandOrder = ['Canon','Sony','Nikon','LUMIX','Fujifilm','DJI','Insta360','GoPro','Apple','SDR 常用','SDR 广色域','HDR'];
  const category = p => p.brand || standards[p.id];
  const gamut = p => p.fixed_output ? '按机型选择' : p.gamut;
  const curves = entries => [...new Set(entries.map(p => p.curve))];
  const dialog = byId('color-picker'), search = byId('color-search'), options = byId('color-options');
  const draft = byId('color-draft'), apply = byId('color-apply'), back = byId('color-back');
  const opener = document.activeElement;
  const session = new AbortController();
  let step = 0, brand = '', family = '', selected = null;
  const tile = (title, details, action) => {
    const button = document.createElement('button');
    button.className = 'color-option';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const note = document.createElement('small');
    note.textContent = details || '';
    note.hidden = !details;
    button.append(heading, note);
    button.onclick = action;
    return button;
  };
  const presetTile = (entry, searchResult = false) => {
    const row = document.createElement('div');
    row.className = 'color-option-group';
    const label = entry.fixed_output ? entry.gamut : entry.curve;
    const details = entry.fixed_output
      ? entry.curve + ' · ' + translate(entry.import_lut ? '需导入 LUT' : '厂商 LUT → Rec.709')
    : [searchResult && entry.brand,entry.gamut,!searchResult && translate(entry.note || '')].filter(Boolean).join(' · ');
    const button = tile(label, details, () => {
      selected = entry;
      for (const item of options.querySelectorAll('[data-preset-id]')) {
        item.setAttribute('aria-pressed', String(item === button));
      }
      showDraft();
    });
    button.dataset.presetId = entry.id;
    button.setAttribute('aria-pressed', String(selected?.id === entry.id));
    row.append(button);
    if (input && entry.import_lut) {
      const install = document.createElement('button');
      install.textContent = translate('导入官方 CUBE');
      install.onclick = () => {
        const file = document.createElement('input');
        file.type = 'file';
        file.accept = '.cube';
        file.onchange = async () => {
          try {
            const selectedFile = file.files[0];
            if (!selectedFile) return;
            if (selectedFile.size > 8 * 1024 * 1024) throw Error(translate('LUT 文件过大'));
            colorPresets = await api('color-lut', {id:entry.id, content:await selectedFile.text()});
            if (!session.signal.aborted) {
              selected = colorEndpoint(entry.id);
              showOptions();
            }
            toast('官方 LUT 已导入');
          } catch (error) { toast(error.message); }
        };
        file.click();
      };
      row.append(install);
    }
    return row;
  };
  const showDraft = () => {
    const current = selected || colorEndpoint(state[key]);
    const title = document.createElement('strong'), note = document.createElement('small');
    title.textContent = current ? current.gamut + ' / ' + current.curve : translate('尚未选择预设');
    note.textContent = translate(selected?.import_lut ? '需导入 LUT' : selected ? '待应用' : '当前预设');
    draft.replaceChildren(title,note);
    apply.disabled = !selected?.[input ? 'input' : 'output'];
    back.hidden = !step && !search.value;
  };
  const go = next => {
    const direction = Math.sign(next-step);
    step = next;
    if (!step) brand = '';
    if (step < 2) family = '';
    selected = null;
    search.value = '';
    showOptions();
    if (direction && motionEnabled()) {
      options.lastElementChild.animate([{opacity:.48,transform:`translateX(${direction*9}px)`},
        {opacity:1,transform:'translateX(0)'}],{duration:155,easing:'ease-out'});
    }
    options.querySelector('h3')?.focus({preventScroll:true});
  };
  const showOptions = () => {
    const records = getChoices();
    const categoryTitle = standardOnly ? '用途' : '品牌';
    const term = search.value.trim().toLowerCase();
    const crumbs = byId('color-steps');
    crumbs.replaceChildren();
    [brand || categoryTitle, family || '色域', family === '按机型选择' ? '机型与曲线' : '曲线'].forEach((label, index) => {
      if (index) {
        const separator = document.createElement('span');
        separator.textContent = '›';
        separator.setAttribute('aria-hidden','true');
        crumbs.append(separator);
      }
      const button = document.createElement('button');
      button.textContent = translate(label);
      button.disabled = index > step || !!term;
      if (index === step && !term) button.setAttribute('aria-current','step');
      button.onclick = () => go(index);
      crumbs.append(button);
    });
    const title = document.createElement('h3'), grid = document.createElement('div');
    title.tabIndex = -1;
    grid.className = 'color-options';
    if (term) {
      const matches = records.filter(p => [p.brand,p.gamut,p.curve,p.id,category(p)].join(' ').toLowerCase().includes(term));
      title.textContent = translate(matches.length ? '搜索结果' : '没有匹配的预设');
      grid.append(...matches.map(p => presetTile(p,true)));
    } else if (!step && fixedOutput) {
      title.textContent = translate('厂商 LUT → Rec.709');
      grid.append(...records.map(p => presetTile(p)));
    } else if (step === 0) {
      title.textContent = translate(standardOnly ? '选择用途' : '选择品牌');
      grid.classList.add('color-brand-grid');
      const brands = [...new Set(records.map(category))].sort((a,b) => brandOrder.indexOf(a) - brandOrder.indexOf(b));
      for (const name of brands) {
        const names = curves(records.filter(p => category(p) === name));
        const label = names.slice(0,2).join(' · ') + (names.length > 2 ? ' …' : '');
        grid.append(tile(translate(name), label, () => { brand = name; go(1); }));
      }
    } else {
      const subset = records.filter(p => category(p) === brand);
      if (step === 1) {
        title.textContent = translate('选择色域或机型');
        for (const name of new Set(subset.map(gamut))) {
          const caption = name === '按机型选择' ? translate('使用与机型匹配的厂商 LUT') :
            curves(subset.filter(p => gamut(p) === name)).join(' · ');
          grid.append(tile(translate(name), caption, () => { family = name; go(2); }));
        }
      } else {
        title.textContent = translate(family === '按机型选择' ? '选择机型与曲线' : '选择曲线');
        grid.append(...subset.filter(p => gamut(p) === family).map(p => presetTile(p)));
      }
    }
    options.replaceChildren(title,grid);
    options.scrollTop = 0;
    showDraft();
  };

  byId('color-picker-title').textContent = input ? '选择输入预设' : '选择输出预设';
  byId('color-picker-eyebrow').textContent = (reverse ? 'TO LOG' : 'TO DISPLAY') + ' / ' + (input ? 'INPUT' : 'OUTPUT');
  byId('color-cancel').onclick = () => dialog.close();
  search.oninput = () => { selected = null; showOptions(); };
  search.onkeydown = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dialog.close();
  };
  back.onclick = () => go(search.value ? step : step-1);
  apply.onclick = () => {
    if (apply.disabled) return;
    setColorSelection(key, selected.id);
    dialog.close();
    render();
    byId('workspace').querySelector('[data-color-pick="' + key + '"]')?.focus();
  };
  dialog.addEventListener('close', () => {
    session.abort();
    if (opener?.isConnected) opener.focus();
  }, {once:true});
  localize(dialog);
  go(0);
  dialog.showModal();
  search.focus();
}

let npuRecognitionReady = false;
const subtitleTimelineView = new WeakMap();
let subtitleTimeline;

function subtitleTimelinePanel() {
  if (active === emptyClip) return '';
  return `<section class="panel subtitle-timeline" id="subtitle-timeline" hidden>
    <div class="panel-head"><h2>字幕时间轴</h2><div class="toolbar">
      <button id="subtitle-timeline-play" class="timeline-play" data-action="play" aria-label="播放或暂停" aria-keyshortcuts="Space" ${active.url ? '' : 'disabled'}>播放</button>
      <button data-action="insert-subtitle" aria-keyshortcuts="Alt+N" ${active.url ? '' : 'disabled'}>在播放处加字幕</button>
      <output class="mono" id="subtitle-timeline-clock" aria-label="播放位置"></output>
      <label>显示范围 <select id="subtitle-timeline-zoom">
        <option value="0">全部</option><option value="60">60 s</option><option value="15" selected>15 s</option>
        <option value="5">5 s</option><option value="2">2 s</option>
      </select></label>
      <button id="subtitle-timeline-center">定位播放头</button>
    </div></div>
    <div class="subtitle-timeline-scroll">
      <div id="subtitle-timeline-track" class="subtitle-timeline-track" role="group" tabindex="0" aria-label="字幕时间轴">
        <div class="subtitle-timeline-ticks" aria-hidden="true"></div>
        <div class="subtitle-timeline-items"></div>
        <span class="subtitle-timeline-head" aria-hidden="true"></span>
      </div>
    </div>
    <input id="subtitle-timeline-pan" type="range" min="0" step="0.001" aria-label="移动时间轴视图">
    <p class="muted subtitle-timeline-note">拖两端裁切，拖中间移动。选中手柄后用方向键微调，按住 Shift 可按 1 毫秒调整。</p>
    <p class="muted subtitle-timeline-note">${isMacPlatform
      ? '空格播放或暂停 · ← / → 跳 15 秒（手柄上加 ⌘）· ⌥N 补字幕 · ⌘C / ⌘V 复制和粘贴字幕'
      : '空格播放或暂停 · ← / → 跳 15 秒（手柄上加 Ctrl）· Alt+N 补字幕 · Ctrl+C / Ctrl+V 复制和粘贴字幕'}</p>
  </section>`;
}

function moveSubtitleRange(start, end, mode, delta, duration) {
  const limit = Math.floor(duration*1000);
  const clamp = (value, min, max) => Math.min(max,Math.max(min,value));
  const first = clamp(Math.round(start*1000),0,limit-1);
  const last = clamp(Math.round(end*1000),first+1,limit);
  if (mode === 'start') return [clamp(first+delta,0,last-1)/1000,last/1000];
  if (mode === 'end') return [first/1000,clamp(last+delta,first+1,limit)/1000];
  const shift = clamp(delta,-first,limit-last);
  return [(first+shift)/1000,(last+shift)/1000];
}

function refreshSubtitleTiming(index) {
  const row = active.rows[index], workspace = byId('workspace');
  row.confirmed = false;
  if (active.candidate?.row === index) delete active.candidate;
  localRecognitionJobs.delete(row);
  workspace.querySelector('[data-confirm="'+index+'"]').checked = false;
  workspace.querySelector('[data-segment="'+index+'"]').textContent = preciseTimecode(row.start) + ' – ' + preciseTimecode(row.end);
  for (const input of workspace.querySelectorAll('[data-caption-index="'+index+'"]')) {
    input.value = row[input.dataset.captionTime];
  }
  updatePreviewCaption();
  scheduleSave();
}

function bindSubtitleTimeline(clip, video, signal) {
  const panel = byId('subtitle-timeline');
  if (!panel) return;
  const track = byId('subtitle-timeline-track'), zoom = byId('subtitle-timeline-zoom');
  const pan = byId('subtitle-timeline-pan'), clock = byId('subtitle-timeline-clock');
  const items = track.querySelector('.subtitle-timeline-items');
  const ruler = track.querySelector('.subtitle-timeline-ticks'), head = track.querySelector('.subtitle-timeline-head');
  const view = subtitleTimelineView.get(clip) || {start:0,zoom:'15'};
  subtitleTimelineView.set(clip,view);
  zoom.value = view.zoom;
  let duration, span, drag, scrub;
  const position = time => (time-view.start)/span*100;
  const currentTime = () => video?.readyState >= 1 ? video.currentTime : clip.cursor;
  const rangeLabel = (start,end) => preciseTimecode(start)+' – '+preciseTimecode(end);
  const showClock = () => {
    const time = currentTime();
    head.hidden = time < view.start || time > view.start+span;
    if (!head.hidden) head.style.left = position(time)+'%';
    if (!drag) clock.textContent = preciseTimecode(time);
  };
  const place = (element,start,end) => {
    element.style.left = position(start)+'%';
    element.style.width = (end-start)/span*100+'%';
  };
  const redraw = () => {
    duration = video?.readyState >= 1 && Number.isFinite(video.duration) ? video.duration : clip.duration;
    panel.hidden = !Number.isFinite(duration) || duration < .001;
    if (panel.hidden) return;
    span = Math.min(+zoom.value || duration,duration);
    view.start = Math.max(0,Math.min(view.start,duration-span));
    pan.max = duration-span;
    pan.value = view.start;
    pan.hidden = duration <= span;
    const scale = 10**Math.floor(Math.log10(span/7));
    const step = [1,2,5,10].map(n=>n*scale).find(n=>n>=span/7);
    ruler.innerHTML = '';
    for (let i = Math.ceil(view.start/step); i*step < view.start+span-step*.18; i++) {
      const tick = document.createElement('time');
      tick.style.left = Math.max(0,position(i*step))+'%';
      tick.textContent = preciseTimecode(i*step);
      ruler.append(tick);
    }
    const lanes = [];
    items.innerHTML = '';
    const visible = clip.rows.map((row,index)=>({row,index})).filter(({row})=>
      row.end > view.start && row.start < view.start+span && row.end > row.start).sort((a,b)=>a.row.start-b.row.start);
    for (const {row,index} of visible) {
      let lane = lanes.findIndex(end => end <= row.start);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = row.end;
      const block = document.createElement('div');
      block.className = 'subtitle-timeline-block';
      block.dataset.timelineRow = index;
      block.dataset.selected = index === clip.row;
      block.style.top = lane*34+'px';
      place(block,row.start,row.end);
      for (const [mode,label] of [['start','拖动句首'],['move','移动整句'],['end','拖动句尾']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.timelineMode = mode;
        button.setAttribute('aria-label',translate(label)+' '+rangeLabel(row.start,row.end));
        if (mode === 'move') {
          button.textContent = row.text;
          button.title = rangeLabel(row.start,row.end)+'\n'+row.text;
        } else {
          const edge = mode === 'start' ? row.start : row.end;
          button.hidden = edge < view.start || edge > view.start+span;
        }
        block.append(button);
      }
      items.append(block);
    }
    items.style.height = Math.max(1,lanes.length)*34+'px';
    showClock();
  };
  const center = time => { view.start = time-span/2; redraw(); };
  const select = index => {
    clip.row = index;
    for (const row of byId('workspace').querySelectorAll('[data-row]')) {
      row.classList.toggle('active',+row.dataset.row === index);
    }
    for (const block of items.children) block.dataset.selected = +block.dataset.timelineRow === index;
  };
  const seek = time => {
    if (byId('loop')) byId('loop').checked = false;
    clip.cursor = Math.max(0,Math.min(duration,time));
    video?.pause();
    if (video?.readyState >= 1) video.currentTime = clip.cursor;
    showClock();
  };
  const commit = (index,mode,start,end) => {
    select(index);
    const row = clip.rows[index];
    if (row.start !== start || row.end !== end) {
      Object.assign(row,{start,end});
      refreshSubtitleTiming(index);
    }
    seek(mode === 'end' ? end : start);
    if (clip.cursor < view.start || clip.cursor > view.start+span) center(clip.cursor);
    else redraw();
  };
  const findControl = target => {
    const button = target.closest('[data-timeline-mode]');
    return button && {button,index:+button.parentElement.dataset.timelineRow,mode:button.dataset.timelineMode};
  };
  const scrubTo = event => {
    const rect = track.getBoundingClientRect();
    seek(view.start+(event.clientX-rect.left)/rect.width*span);
  };
  track.onpointerdown = event => {
    if (event.button !== 0 || drag || scrub !== undefined) return;
    const control = findControl(event.target);
    if (!control) {
      track.focus({preventScroll:true});
      scrub = event.pointerId;
      track.setPointerCapture(event.pointerId);
      scrubTo(event);
      return;
    }
    const {button,index,mode} = control, row = clip.rows[index];
    select(index);
    video?.pause();
    button.focus({preventScroll:true});
    track.setPointerCapture(event.pointerId);
    drag = {pointer:event.pointerId,index,mode,block:button.parentElement,x:event.clientX,
      start:row.start,end:row.end,range:[row.start,row.end]};
    clock.textContent = rangeLabel(row.start,row.end);
  };
  track.onpointermove = event => {
    if (scrub === event.pointerId) scrubTo(event);
    if (drag?.pointer !== event.pointerId) return;
    const delta = Math.round((event.clientX-drag.x)/track.clientWidth*span*1000);
    drag.range = delta ? moveSubtitleRange(drag.start,drag.end,drag.mode,delta,duration) : [drag.start,drag.end];
    place(drag.block,...drag.range);
    clock.textContent = rangeLabel(...drag.range);
  };
  track.onpointerup = event => {
    if (scrub === event.pointerId) {
      scrub = undefined;
      scrubTo(event);
    }
    if (drag?.pointer !== event.pointerId) return;
    const {index,mode,range} = drag;
    drag = null;
    commit(index,mode,...range);
    items.querySelector('[data-timeline-row="'+index+'"] [data-timeline-mode="'+mode+'"]')?.focus({preventScroll:true});
  };
  track.onlostpointercapture = event => {
    if (scrub === event.pointerId) scrub = undefined;
    if (!drag) return;
    drag = null;
    redraw();
  };
  track.onkeydown = event => {
    const control = findControl(event.target);
    if (!control || event.ctrlKey || event.metaKey || event.altKey || !['ArrowLeft','ArrowRight','Enter'].includes(event.key)) return;
    event.preventDefault();
    const {index,mode} = control, row = clip.rows[index];
    const delta = (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0)*(event.shiftKey ? 1 : 10);
    const range = delta ? moveSubtitleRange(row.start,row.end,mode,delta,duration) : [row.start,row.end];
    commit(index,mode,...range);
    items.querySelector('[data-timeline-row="'+index+'"] [data-timeline-mode="'+mode+'"]')?.focus({preventScroll:true});
  };
  pan.oninput = () => { view.start = pan.valueAsNumber; redraw(); };
  zoom.onchange = () => {
    view.zoom = zoom.value;
    span = Math.min(+view.zoom || duration,duration);
    center(currentTime());
  };
  byId('subtitle-timeline-center').onclick = () => center(currentTime());
  video?.addEventListener('loadedmetadata',() => { redraw(); center(currentTime()); },{signal});
  video?.addEventListener('timeupdate',showClock,{signal});
  redraw();
  if (currentTime() < view.start || currentTime() > view.start+span) center(currentTime());
  const follow = time => {
    if (time < view.start || time > view.start+span) center(time);
    else showClock();
  };
  return {redraw,follow,updateLabel(index) {
    const button = items.querySelector('[data-timeline-row="'+index+'"] [data-timeline-mode=move]');
    if (!button) return;
    const row = clip.rows[index];
    button.textContent = row.text;
    button.title = rangeLabel(row.start,row.end)+'\n'+row.text;
  },showRow(index) {
    select(index);
    follow(clip.rows[index].start);
  }};
}

function subtitlesPage() {
  const subtitleMode = effective(active).subtitleMode;
  const rows = active.rows.map((row, index) => `<div class="subtitle-row ${index === active.row ? 'active' : ''}" data-row="${index}">
    <div class="toolbar"><button class="mono" data-segment="${index}">${preciseTimecode(row.start)} – ${preciseTimecode(row.end)}</button>
    <input type="text" data-speaker="${index}" aria-label="第 ${index+1} 句说话人" placeholder="说话人" value="${escapeHtml(row.speaker)}">
    <label><input type="checkbox" data-confirm="${index}" ${row.confirmed ? 'checked' : ''}> 已确认</label>
    <details class="caption-timing"><summary>时间码</summary><div class="toolbar">
      <label>开始（秒）<input type="number" min="0" step="0.001" data-caption-time="start" data-caption-index="${index}" value="${row.start}"></label>
      <label>结束（秒）<input type="number" min="0" step="0.001" data-caption-time="end" data-caption-index="${index}" value="${row.end}"></label>
    </div></details></div>
    <textarea aria-label="第 ${index+1} 句字幕" data-text="${index}">${escapeHtml(row.text)}</textarea></div>`).join('');
  return header('字幕', '在当前素材中定位、复听和校对。', '<button data-action="original"' + (active.original?.length ? '' : ' disabled') + '>查看原始识别稿</button>') +
    subtitleTimelinePanel() + previewLayout(stageControls('视频字幕', subtitleMode !== 'none', `<select data-field="subtitleMode" aria-label="视频字幕">
      <option value="none" ${subtitleMode === 'none' ? 'selected' : ''}>不应用</option>
      <option value="soft" ${subtitleMode === 'soft' ? 'selected' : ''}>软字幕</option>
      <option value="burn" ${subtitleMode === 'burn' ? 'selected' : ''}>烧录字幕</option>
    </select><button data-action="apply-subtitle">应用至选中素材</button>`) +
    '<div class="panel"><div class="panel-head"><h2>校对稿</h2><span class="muted">' +
    (active.rows.length ? `${active.rows.length} 段` : '未开始识别') + '</span></div><div class="subtitle-list">' +
    (rows || '<p class="panel-body muted">此素材暂无字幕。</p>') +
    '</div><div class="settings-inline"><button data-action="subtitle-search"' + (active.rows.length ? '' : ' disabled') + '>查找与替换</button><button data-action="srt"' + (active.rows.length ? '' : ' disabled') + '>导出 SRT</button><button data-action="txt"' +
    (active.rows.length ? '' : ' disabled') + '>导出 TXT</button><label><input id="speakers" type="checkbox"> 包含说话人</label></div></div>',
    captionStylePicker() + '<div class="panel settings-inline"><label><input id="loop" type="checkbox"> 循环选中句</label>' +
    field('模型','model',['Base','Medium.en','Large-v3-turbo'],effective(active).model) +
    (isMacPlatform && !npuRecognitionReady ? '' : `<label>识别设备<select data-field="recognitionBackend">
      <option value="cpu">CPU</option><option value="npu" ${!npuRecognitionReady || effective(active).model !== 'Base' ? 'disabled' : ''}
      ${npuRecognitionReady && effective(active).model === 'Base' && effective(active).recognitionBackend === 'npu' ? 'selected' : ''}>Intel NPU（实验）</option></select></label>
      <span class="muted">NPU 实验仅支持 Whisper Base。</span>`) +
    '<button data-action="candidate"' + (active.rows.length ? '' : ' disabled') + '>局部重识别与对比</button></div>' +
    '<div class="panel settings-inline">' + field('识别语言','language',effective(active).model === 'Medium.en' ? ['英语'] : ['自动检测','中文','英语'],effective(active).language) +
    '<button data-action="transcribe-real"' + (!active.mediaId || active.status !== '已就绪' ? ' disabled' : '') + '>生成初稿</button>' +
    (active.pendingResult ? '<button data-action="review-full">查看新识别稿</button>' : '') +
    '<button data-action="import-srt"' + (active === emptyClip ? ' disabled' : '') + '>导入 SRT</button></div>');
}
function deliveryConfirmation(plans) {
  const ready = plans.filter(plan => !plan.issues.length).length;
  const line = value => '<span data-verbatim>' + escapeHtml(value) + '</span>';
  const entries = plans.map((plan,index) => {
    const {clip,settings,payload,name,copy,encode,encoder,issues} = plan;
    const {kind} = payload;
    const action = kind === 'subtitles' ? '仅导字幕' : kind === 'audio' ? '仅音频' : kind === 'remux' ? '仅换容器' : copy ? '复制视频流' : '重新编码';
    const encoding = kind === 'subtitles' ? 'SRT' : kind === 'audio' ? payload.container.toUpperCase() : encode ? payload.profile : (clip.codec || '未知');
    const pixel = encode && (newProfiles[payload.profile]?.at(-1) ||
      (payload.profile.includes('4444') ? '10-bit 4:4:4' : payload.profile.includes('8-bit') ? '8-bit 4:2:0' : '10-bit 4:2:2'));
    const track = clip.sourceInfo?.audio?.[payload.track] || clip.tracks?.[payload.track];
    const audio = kind === 'subtitles' || kind === 'audio' ? (kind === 'audio' ? '音轨 ' + (payload.track+1) : '') :
      kind === 'remux' ? {all:'复制全部音轨',selected:track ? '复制所选音轨' : '无音轨',none:'不输出音频'}[payload.mux_audio] :
      track ? videoAudioLabel(settings) : '无音轨';
    const caption = kind === 'subtitles' ? '独立 SRT' : payload.subtitle_mode === 'burn' ? '烧录字幕' :
      payload.subtitle_mode === 'soft' ? '软字幕' : '无字幕';
    const outputColor = payload.transform ? colorEndpoint(payload.color.output_id) : null;
    const color = payload.transform ? line(outputColor ? outputColor.gamut+' / '+outputColor.curve : translate('未知')) :
      kind === 'video' || kind === 'remux' ? '<span>保留原色彩</span>' : '—';
    const estimated = encode ? estimateProres(clip,settings) : null;
    const notes = encode ? [pixel, payload.target_size_mb > 0 ? translate('目标体积')+' '+payload.target_size_mb+' MB' : '',
      payload.prores_speed === 'fixed' && payload.profile.startsWith('ProRes') ? translate('快速（固定量化）') : '',
      payload.threads === 'auto' ? translate('自动线程') : payload.threads+' '+translate('线程'), estimated ? '≈ '+sizeText(estimated) : ''].filter(Boolean).join(' · ') : '';
    return `<tr class="${issues.length ? 'delivery-incomplete' : ''}">
      <td><strong data-verbatim>${escapeHtml(clip.name)}</strong><small class="delivery-file muted" data-verbatim>${escapeHtml(name || '—')}</small></td>
      <td><strong>${action}</strong><small>${line(encoding+' / '+payload.container.toUpperCase())}</small>${notes ? `<small class="muted" data-verbatim>${escapeHtml(notes)}</small>` : ''}
      ${encode ? `<small class="muted" data-verbatim>${escapeHtml(encoderLabel(encoder))}</small>` : ''}</td>
      <td>${color}${audio ? `<small>${escapeHtml(audio)}</small>` : ''}</td>
      <td>${caption}${payload.copy_subtitles ? '<small>保留兼容的源字幕轨</small>' : ''}</td>
      <td>${issues.length ? issues.map(([target,message],issueIndex) => `<div class="delivery-issue">
        <span>${escapeHtml(message)}</span><button data-delivery-fix="${index}:${issueIndex}">${pages[target]}</button></div>`).join('') : '<span class="delivery-ready">可导出</span>'}</td></tr>`;
  }).join('');
  return `<div class="panel-head"><div><p class="review-label" aria-hidden="true">EXPORT / REVIEW</p><h2>导出确认</h2>
    <p class="muted">${repairDelivery ? '<span>仅重新提交此素材</span> · ' : ''}<span>${ready}</span> <span>可导出</span> · <span>${plans.length-ready}</span> <span>需处理</span></p></div>
    ${repairDelivery ? '<button data-action="cancel-repair">返回批量导出</button>' : ''}
    <button class="primary" data-action="start-exports" ${ready && !exportSubmitting ? '' : 'disabled'}>开始导出</button></div>
    <div class="table-wrap"><table class="delivery-table"><thead><tr><th>素材 / 目标文件</th><th>处理方式 / 编码</th>
      <th>色彩 / 音轨</th><th>字幕</th><th>检查</th></tr></thead><tbody>${entries || '<tr><td colspan="5">请选择要导出的素材</td></tr>'}</tbody></table></div>`;
}
function refreshDeliveryConfirmation() {
  const confirmation = byId('delivery-confirm-list');
  if (confirmation) {
    confirmation.innerHTML = deliveryConfirmation(currentDeliveryPlans());
    localize(confirmation);
  }
}
let exportDirectoryError = '';
let exportSubmitting = false;
async function checkDeliveryDirectory() {
  const destination = exportConfig.destination.trim();
  if (!destination) return false;
  let free = null, error = '';
  try { free = (await api('export-space',{destination})).free; }
  catch (_) { error = '请选择存在的输出文件夹'; }
  if (destination !== exportConfig.destination.trim()) return false;
  exportSpace = free;
  exportDirectoryError = error;
  const message = byId('export-space-status');
  if (message) message.textContent = free === null ? translate('剩余空间未检查') : translate('输出磁盘可用空间') + ' · ' + sizeText(free);
  refreshDeliveryConfirmation();
  return !error;
}
function exportPage() {
  return header('导出', '确认每个素材实际采用的设置。') +
    '<div class="stack">' + previewLayout(panel('交付设置', `<div class="fields">
      <div class="toolbar"><button data-action="delivery-presets">常用导出预设</button></div>
      <label>交付类型 <select data-export-setting="kind"><option value="video" ${exportConfig.kind === 'video' ? 'selected' : ''}>视频</option><option value="remux" ${exportConfig.kind === 'remux' ? 'selected' : ''}>仅换容器（MKV）</option><option value="subtitles" ${exportConfig.kind === 'subtitles' ? 'selected' : ''}>仅导字幕（SRT）</option><option value="audio" ${exportConfig.kind === 'audio' ? 'selected' : ''}>仅音频</option></select></label>
      ${exportConfig.kind === 'audio' ? `<label>音频格式 <select data-export-setting="audioFormat">${['WAV','FLAC','MP3'].map(value => `<option ${value === exportConfig.audioFormat ? 'selected' : ''}>${value}</option>`).join('')}</select></label>` : ''}
      ${exportConfig.kind === 'remux' ? `<label>音轨 <select data-export-setting="muxAudio">
        ${Object.entries({selected:'复制所选音轨',all:'复制全部音轨',none:'不输出音频'}).map(([value,label]) => `<option value="${value}" ${exportConfig.muxAudio === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label><label>源字幕轨 <select data-export-setting="muxSubtitles"><option ${exportConfig.muxSubtitles === '省略' ? 'selected' : ''}>省略</option><option ${exportConfig.muxSubtitles === '保留' ? 'selected' : ''}>保留</option></select></label><p class="muted">保留源字幕轨时，mov_text 转为 SRT，其余兼容轨道直接复制。</p>` : ''}
      <label>输出目录 <span class="toolbar"><input id="export-destination" data-export-setting="destination" value="${escapeHtml(exportConfig.destination)}" placeholder="选择输出文件夹"><button data-action="choose-output">选择文件夹</button></span></label>
      <label>文件名模板 <input data-export-setting="template" value="${escapeHtml(exportConfig.template)}"></label><p class="muted">支持 {name} 和 {profile}，扩展名按输出格式确定。</p>
      <label>重名处理 <select data-export-setting="collision"><option value="number" ${exportConfig.collision === 'number' ? 'selected' : ''}>自动编号</option><option value="skip" ${exportConfig.collision === 'skip' ? 'selected' : ''}>跳过</option></select></label>
      <p class="muted" id="export-space-status">${exportSpace === null ? '剩余空间未检查' : translate('输出磁盘可用空间') + ' · ' + sizeText(exportSpace)}</p>
      <p class="notice">重名时按所选规则编号或跳过。</p></div>`)) +
    '<section id="delivery-confirm-list" class="panel workspace-change">' + deliveryConfirmation(currentDeliveryPlans()) +
    '</section><div id="export-job-summary"></div></div>';
}

let colorPreview, currentPlayerClip, playerEvents, renderedPage;
const navIcons = [
  '<svg class="nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.35"/><path d="M5.5 3v10M10.5 3v10" stroke="currentColor" stroke-width="1.2"/></svg>',
  '<svg class="nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 5h11M2.5 11h11" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><circle cx="6" cy="5" r="1.7" fill="currentColor"/><circle cx="10.5" cy="11" r="1.7" fill="currentColor"/></svg>',
  '<svg class="nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="5.7" r="3" stroke="currentColor" stroke-width="1.3"/><circle cx="5.7" cy="9.8" r="3" stroke="currentColor" stroke-width="1.3"/><circle cx="10.3" cy="9.8" r="3" stroke="currentColor" stroke-width="1.3"/></svg>',
  '<svg class="nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3.2" width="12" height="9.6" rx="2" stroke="currentColor" stroke-width="1.35"/><path d="M4.5 9.2h4.2M10.3 9.2h1.2M4.5 6.8h2M8 6.8h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  '<svg class="nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 10.5V2.8m0 0L5.2 5.6M8 2.8l2.8 2.8M3 10.5v1.8A1.2 1.2 0 0 0 4.2 13.5h7.6a1.2 1.2 0 0 0 1.2-1.2v-1.8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  '<svg class="nav-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.2 8.5h2.5l1.5-4 2.4 7 1.6-3h3.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
];
function render() {
  byId('navigation').innerHTML = pages.map((label,index) =>
    `<button data-page="${index}" ${index === page ? 'aria-current="page"' : ''}>${navIcons[index] || ''}<span>${label}</span>${index === tasksPageIndex ? '<span id="task-dot" class="task-dot" hidden><span class="task-dot-label">有进行中的任务</span></span>' : ''}</button>`).join('');
  const workspace = byId('workspace');
  stopWaveform?.();
  stopWaveform = null;
  redrawScope = null;
  colorPreview?.stop();
  colorPreview = null;
  playerEvents?.abort();
  const oldVideo = byId('player');
  const sameSource = oldVideo && currentPlayerClip === active && oldVideo.getAttribute('src') === active.url;
  let parked = false;
  if (sameSource && !oldVideo.seeking) active.cursor = oldVideo.currentTime;
  if (oldVideo) {
    // Media events can still be queued when the workspace is replaced.
    oldVideo.ontimeupdate = oldVideo.onloadedmetadata = null;
    oldVideo.onplay = oldVideo.onpause = oldVideo.onerror = null;
    if (!sameSource) oldVideo.pause();
  }
  if (sameSource && page !== tasksPageIndex && typeof workspace.parentElement.moveBefore === 'function') {
    try {
      workspace.parentElement.moveBefore(oldVideo,workspace);
      parked = true;
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  }
  workspace.innerHTML = [importPage, transcodePage, colorPage, subtitlesPage, exportPage, tasksPage][page]();
  const placeholder = workspace.querySelector('#player');
  if (sameSource && placeholder) {
    oldVideo.preload = placeholder.preload;
    if (parked) {
      try {
        placeholder.parentElement.moveBefore(oldVideo,placeholder);
        placeholder.remove();
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        placeholder.replaceWith(oldVideo);
      }
    } else placeholder.replaceWith(oldVideo);
  } else if (oldVideo) { oldVideo.pause(); if (parked) oldVideo.remove(); }
  renderQueue();
  if (renderedPage !== page && motionEnabled()) {
    for (const block of workspace.querySelectorAll('.workspace-change')) {
      block.animate([{opacity:.68,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],
        {duration:150,easing:'ease-out'});
    }
  }
  renderedPage = page;
  if (byId('track')) byId('track').value = String(active.track || 0);
  const video = byId('player');
  currentPlayerClip = active;
  if (video) {
    playerEvents = new AbortController();
    const eventOptions = {signal: playerEvents.signal};
    const clip = active;
    const seek = byId('seek');
    const clock = byId('clock');
    const playButton = workspace.querySelector('.player-tools [data-action="play"]');
    const timelinePlay = byId('subtitle-timeline-play');
    const unavailable = byId('preview-unavailable');
    const updateAvailability = () => { unavailable.hidden = video.readyState < 1 || video.videoWidth > 0; };
    video.onerror = () => {
      video.onerror = null;
      unavailable.hidden = false;
      if (active === clip && clip.mediaId && clip.status === '已就绪' && !String(clip.url).startsWith('blob:')) selectPlaybackTrack(clip, true);
    };
    video.onloadedmetadata = () => {
      const cursor = Number.isFinite(clip.cursor) ? Math.max(0,clip.cursor) : 0;
      if (Number.isFinite(video.duration)) { video.currentTime = Math.min(cursor,video.duration); seek.max = video.duration; }
      updateAvailability();
    };
    video.addEventListener('loadeddata', updatePreviewCaption, eventOptions);
    video.addEventListener('seeked', updatePreviewCaption, eventOptions);
    bindCaptionPosition(video, clip, playerEvents.signal);
    seek.oninput = () => { video.currentTime = Number(seek.value); updatePreviewCaption(); };
    video.ontimeupdate = () => {
      const row = clip.rows[clip.row];
      if (check('loop') && row && video.currentTime >= row.end && row.start < video.duration) video.currentTime = row.start;
      clip.cursor = video.currentTime;
      seek.value = clip.cursor;
      clock.textContent = timecode(clip.cursor);
      updatePreviewCaption();
    };
    const updatePlaybackButtons = () => {
      const label = translate(video.paused ? '播放' : '暂停');
      playButton.textContent = label;
      if (timelinePlay) timelinePlay.textContent = label;
    };
    video.onplay = video.onpause = updatePlaybackButtons;
    if (video.readyState >= 1 && Number.isFinite(video.duration)) seek.max = video.duration;
    if (!video.paused) updatePlaybackButtons();
    updateAvailability();
    updatePreviewCaption();
    if (byId('waveform')) {
      const waveform = attachWaveform(video);
      stopWaveform = waveform.stop;
      redrawScope = waveform.draw;
      colorPreview = bindColorPreview(video,clip,effective(clip),waveform.draw,playButton);
    }
  }
  renderLibrary();
  localize(workspace);
  subtitleTimeline = page === 3 ? bindSubtitleTimeline(active,video,playerEvents?.signal) : null;
  if (page === 3) setupCaptionFontPicker();
  if (page === 1) updateEncoderPath();
  localize(byId('navigation'));
  renderExportSummary();
}

const modalStyles = {
  '更换编码':['CODEC LIBRARY',1080], '项目管理':['PROJECT LIBRARY',1080],
  '新建项目':['PROJECT / NEW',550], '重命名项目':['PROJECT / RENAME',500],
  '删除项目':['PROJECT / REMOVE',500], '导出项目包':['PROJECT / PACKAGE',550],
  '新建文件夹':['MEDIA / NEW FOLDER',480], '重命名文件夹':['MEDIA / RENAME FOLDER',480],
  '已移除的素材':['MEDIA / REMOVED',760], '导入旧版项目':['PROJECT / LEGACY IMPORT',760],
  '在播放处加字幕':['SUBTITLES / INSERT',600], '查找与替换':['SUBTITLES / FIND & REPLACE',590],
  '原始识别稿':['SUBTITLES / SOURCE TRANSCRIPT',770], '局部重识别与候选比较':['SUBTITLES / SEGMENT REVIEW',960],
  '新识别稿（待确认）':['SUBTITLES / NEW DRAFT',920], '常用导出预设':['EXPORT / PRESET LIBRARY',1080],
  '保存导出预设':['EXPORT / SAVE PRESET',500], '删除预设':['EXPORT / REMOVE PRESET',480],
  '转码前后对照':['EXPORT / BEFORE & AFTER',1080], '界面与资源设置':['PREFERENCES',680]
};
function modal(title, content, layout = '') {
  const dialog = byId('modal');
  const style = modalStyles[title];
  dialog.classList.toggle('library-dialog', Boolean(style));
  if (style) {
    dialog.style.setProperty('--library-width',style[1]+'px');
    dialog.querySelector('.picker-eyebrow').textContent = style[0];
  }
  dialog.dataset.layout = layout;
  byId('modal-title').textContent = title;
  byId('modal-content').innerHTML = content;
  localize(dialog);
  if (!dialog.open) dialog.showModal();
}
const menuEyebrow = label => `<p class="menu-eyebrow" aria-hidden="true">${label}</p>`;
const modalDone = () => '<div class="secondary-footer end"><button class="primary" data-action="close-secondary">完成</button></div>';
const transcriptList = rows => `<div class="transcript-reading">${rows.map(row =>
  `<p><time>${timecode(row.start)}</time><span data-verbatim>${escapeHtml(row.text)}</span></p>`).join('')}</div>`;

let floatingMenuAnchor = null;
let floatingMenuClip = null;
function closeFloatingMenu(restoreFocus = false) {
  const menu = byId('floating-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (floatingMenuAnchor?.isConnected) {
    floatingMenuAnchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus) floatingMenuAnchor.focus();
  }
  floatingMenuAnchor = null;
  floatingMenuClip = null;
}
function showFloatingMenu(anchor, content) {
  closeFloatingMenu();
  let menu = byId('floating-menu');
  if (!menu) {
    menu = document.createElement('div'); menu.id = 'floating-menu';
    menu.className = 'floating-menu'; menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
  }
  floatingMenuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menu.innerHTML = content;
  menu.hidden = false;
  menu.style.left = '0px'; menu.style.top = '0px';
  localize(menu);
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const preferredLeft = rect.right + 5;
  menu.style.left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - width - margin)) + 'px';
  menu.style.top = Math.max(margin, Math.min(rect.top, window.innerHeight - height - margin)) + 'px';
  menu.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
}
function showClipMenu(anchor, clip) {
  showFloatingMenu(anchor, `${menuEyebrow('CLIP ACTIONS')}<div class="floating-menu-caption" data-verbatim title="${escapeHtml(clip.name)}">${escapeHtml(clip.name)}</div>
    <button role="menuitem" data-pin-clip="${clip.id}"><span class="menu-icon" aria-hidden="true">${clip.pinned ? '◈' : '◇'}</span>${clip.pinned ? '取消置顶' : '置顶素材'}</button>
    <button role="menuitem" data-choose-group="${clip.id}"><span class="menu-icon" aria-hidden="true">▱</span><span>移动到文件夹</span><span class="menu-chevron" aria-hidden="true">›</span></button>
    <div class="menu-divider"></div><button role="menuitem" class="menu-remove" data-remove-clip="${clip.id}"><span class="menu-icon" aria-hidden="true">−</span>从素材区移除</button>`);
  floatingMenuClip = clip;
}
function showGroupChoices(clip) {
  const menu = byId('floating-menu');
  menu.innerHTML = `${menuEyebrow('MOVE TO FOLDER')}<button role="menuitem" data-menu-back="${clip.id}"><span class="menu-icon" aria-hidden="true">‹</span>返回</button>
    <div class="menu-divider"></div><div class="floating-menu-caption">移动到文件夹</div>
    <button role="menuitem" data-move-clip="${clip.id}" data-destination=""><span class="menu-icon">${clip.groupId ? '' : '✓'}</span>未分组</button>
    ${groups.map(group => `<button role="menuitem" data-move-clip="${clip.id}" data-destination="${escapeHtml(group.id)}"><span class="menu-icon">${clip.groupId === group.id ? '✓' : ''}</span><span data-verbatim>${escapeHtml(group.name)}</span></button>`).join('')}`;
  localize(menu);
  const anchor = floatingMenuAnchor;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.right + 5, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }
  menu.querySelector('button')?.focus({preventScroll:true});
}
document.addEventListener('pointerdown', event => {
  const menu = byId('floating-menu');
  if (menu && !menu.hidden && !menu.contains(event.target) && !floatingMenuAnchor?.contains(event.target)) closeFloatingMenu();
});
document.addEventListener('keydown', event => {
  const menu = byId('floating-menu');
  if (event.key === 'Escape' && menu && !menu.hidden) {
    event.preventDefault(); closeFloatingMenu(true);
  } else if (menu && !menu.hidden && menu.contains(document.activeElement) && ['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
});
window.addEventListener('resize', () => closeFloatingMenu());
byId('media-list').closest('.library').addEventListener('scroll', () => closeFloatingMenu());

function tasksPage() {
  return header('任务中心', '查看导入、字幕识别和导出的进度。') + '<div id="queue" class="stack"></div>';
}
function exportJobFormat(job) {
  if (job.kind === 'subtitles') return translate('仅导字幕');
  if (job.kind === 'audio') return translate('仅音频');
  if (job.transcode === false && !job.color && job.subtitle_mode !== 'burn') return translate('复制视频流');
  return job.profile;
}
function renderQueue() {
  const imports = visibleClips().filter(clip => clip.mediaId).map(clip => ({name:clip.name, progressKey:'import-'+clip.id, stage:'导入 / 媒体分析', state:
    clip.status === '已就绪' ? '已完成' : ['已中断','失败','分析失败','缺失'].includes(clip.status) ? '失败' :
    clip.status === '排队中' ? '排队' : '运行中', message:clip.error || clip.status,
    progress:clip.status === '复制中' ? clip.progress : clip.status === '已就绪' ? 100 : null}));
  const jobs = [...exportJobs].reverse().map(job => ({...job, progressKey:'export-'+job.id,
    stage:job.kind === 'subtitles' ? '字幕导出' : job.kind === 'audio' ? '音频导出' : '视频导出', isExport:true}))
    .concat(queue.map((job,index) => ({...job,progressKey:'local-'+index})).reverse(), imports);
  const taskDot = byId('task-dot');
  if (taskDot) taskDot.hidden = !jobs.some(job => ['排队','运行中','正在完成','取消中'].includes(job.state));
  const list = byId('queue');
  if (!list) return;
  const signature = JSON.stringify([interfaceLocale, exportJobsError, jobs]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const previous = previousProgress(list);
  const statuses = ['运行中','排队','已完成','失败','已取消','已跳过','中断','取消中','正在完成'];
  const totals = statuses.map(state => [state, jobs.filter(job => job.state === state).length]);
  list.innerHTML = `<div class="task-totals">${totals.filter(([_, count], i) => count || i < 4).map(([state,count]) =>
    `<div><strong>${count}</strong><span>${state}</span></div>`).join('')}</div>
    ${exportJobsError ? `<p class="notice">${escapeHtml(exportJobsError)}</p>` : ''}
    ${jobs.map(job => {
      const running = ['运行中','正在完成','取消中'].includes(job.state);
      const progress = job.state === '已完成' ? 100 : job.progress;
      const progressText = Number.isFinite(progress) ? progress + '%' : running ? '处理中' : '—';
      const detail = [job.isExport ? exportJobFormat(job) : job.profile, job.container?.toUpperCase(),
        job.encoder_engine && job.encoder_engine !== 'none' ? encoderLabel({engine:job.encoder_engine,reason:job.encoder_reason}) : '',
        job.color?.direction === 'to_log' ? translate('转为 Log 供后续调色') : job.color?.gamma,
        job.output_info?.video?.pixel_format, ...((job.output_info?.audio || []).map(track => track.codec)),
        {soft:translate('软字幕'),burn:translate('烧录字幕')}[job.subtitle_mode]].filter(Boolean).join(' · ');
      return `<article class="panel task-card" data-state="${escapeHtml(job.state)}">
        <div class="task-top"><div><p class="muted">${escapeHtml(job.stage)}</p><h2 data-verbatim>${escapeHtml(job.name)}</h2></div>
          <span class="task-state">${escapeHtml(job.state)}</span></div>
        <div class="task-progress">${progressMeter(job.progressKey,Number.isFinite(progress) ? progress : running ? null : 0,'进度')}<span>${progressText}</span></div>
        ${detail ? `<p class="muted" data-verbatim>${escapeHtml(detail)}</p>` : ''}
        ${running && Number.isFinite(job.speed) ? `<p class="muted">速度 <span>${job.speed.toFixed(2)}×</span> ${Number.isFinite(job.eta) ? ' · 预计剩余 ' + timecode(job.eta) : ''}</p>` : ''}
        ${job.message ? `<p class="muted">${escapeHtml(job.message)}</p>` : ''}
        ${job.preview_state ? `<p class="muted">预览：<span>${escapeHtml(job.preview_state)}</span> ${escapeHtml(job.preview_error || '')}</p>` : ''}
        ${job.output ? `<p class="task-path muted" data-verbatim>${escapeHtml(job.output)}</p>` : ''}
        ${job.isExport ? `<div class="toolbar">${exportJobButtons(job)}</div>` : ''}
      </article>`;
    }).join('') || '<p class="panel panel-body muted">暂无任务。</p>'}`;
  localize(list);
  animateProgress(list,previous);
}
function exportJobButtons(job) {
  const id = escapeHtml(job.id);
  if (['排队','运行中'].includes(job.state)) return `<button data-export-cancel="${id}">取消</button>`;
  if (['失败','已取消','中断'].includes(job.state)) return `<button data-export-retry="${id}">重试</button>
    ${visibleClips().some(c=>c.mediaId === job.media_id) ? `<button data-export-repair="${id}">修改后重试</button>` : ''}`;
  if (job.state === '已完成') return `${['audio','subtitles'].includes(job.kind) ? '' : `<button data-export-compare="${id}">前后对照</button>`}<button data-export-open="${id}">打开目录</button>`;
  return '';
}
function renderExportSummary() {
  const container = byId('export-job-summary');
  if (!container) return;
  container.innerHTML = `<div class="panel"><div class="panel-head"><h2>导出任务</h2></div><div class="table-wrap"><table><tbody>${exportJobs.map(job =>
    `<tr><td data-verbatim>${escapeHtml(job.name)}</td><td>${escapeHtml([exportJobFormat(job),job.container?.toUpperCase(),job.output_info?.video?.pixel_format].filter(Boolean).join(' · '))}</td><td>${escapeHtml(job.state)}</td><td>${job.progress == null ? '—' : job.progress + '%'}</td><td>${escapeHtml(job.message || '')}${job.preview_state ? ' · 预览：' + escapeHtml(job.preview_state) : ''}${job.preview_error && job.preview_state === '失败' ? ' · ' + escapeHtml(job.preview_error) : ''}</td><td>${exportJobButtons(job)}</td></tr>`).join('') || `<tr><td>${escapeHtml(exportJobsError || '暂无导出任务')}</td></tr>`}</tbody></table></div></div>`;
  localize(container);
}
async function refreshExportJobs() {
  try { exportJobs = await api('export-jobs?studio='+studioId); exportJobsError = ''; renderQueue(); renderExportSummary(); }
  catch (error) { exportJobsError = error.message; renderQueue(); renderExportSummary(); }
}
async function refreshSystemUsage() {
  const show = (id, value) => { byId(id).textContent = Number.isFinite(value) ? value + '%' : '—'; };
  try {
    const usage = await api('system-usage');
    show('cpu-usage', usage.cpu);
    show('memory-usage', usage.memory);
  } catch {
    show('cpu-usage', null);
    show('memory-usage', null);
  }
}
function showComparison(job) {
  const clip = clips.find(item => item.mediaId === job.media_id);
  if (!clip) { toast('原素材记录不可用'); return; }
  const proxy = job.preview_state === '已完成';
  const softSubtitles = job.subtitle_mode === 'soft' || job.copy_subtitles && job.output_info?.subtitles?.length;
  const subtitleUrl = '/api/export-subtitles?id=' + encodeURIComponent(job.id) + '&token=' + encodeURIComponent(token);
  const media = (side) => proxy ? '/api/preview-media?id=' + encodeURIComponent(job.id) + '&side=' + side + '&token=' + encodeURIComponent(token) :
    side === 'source' ? mediaUrl(job.media_id) : '/api/export-media?id=' + encodeURIComponent(job.id) + '&token=' + encodeURIComponent(token);
  const info = (value) => {
    const v = value?.video;
    return v ? [v.codec, v.width + ' × ' + v.height, v.frame_rate, v.pixel_format, v.bit_depth ? v.bit_depth + ' bit' : null,
      '色彩标记（色域 / 曲线 / 矩阵 / 电平）：' + [v.primaries || '未知',v.transfer || '未知',v.matrix || '未知',v.range || '未知'].join(' / '),
      '音轨 ' + (value.audio?.length ?? '未知'),
      '字幕轨 ' + (value.subtitles ? value.subtitles.length : '未知')].filter(Boolean).join(' · ') : '媒体信息未知';
  };
  const sourceInfo = job.source_info, outputInfo = job.output_info;
  const differences = [];
  if (sourceInfo && outputInfo) {
    if (sourceInfo.duration != null && outputInfo.duration != null && Math.abs(sourceInfo.duration - outputInfo.duration) > 0.1) differences.push('时长不同');
    if (sourceInfo.video?.width !== outputInfo.video?.width || sourceInfo.video?.height !== outputInfo.video?.height) differences.push('分辨率不同');
    if (sourceInfo.video?.frame_rate !== outputInfo.video?.frame_rate) differences.push('帧率标记不同');
    if (sourceInfo.audio?.length !== outputInfo.audio?.length) differences.push('音轨数量不同');
  }
  modal('转码前后对照', `<div class="library-scroll comparison-body"><div class="comparison-grid">
    <div><h3>转码前</h3><video id="compare-left" preload="metadata" src="${escapeHtml(media('source'))}"></video><p class="muted" data-verbatim>${escapeHtml(info(job.source_info))}</p></div>
    <div><h3>转码后</h3><video id="compare-right" preload="metadata" src="${escapeHtml(media('output'))}">${softSubtitles ? `<track id="compare-subtitles" kind="captions" src="${escapeHtml(subtitleUrl)}">` : ''}</video><p class="muted" data-verbatim>${escapeHtml(info(job.output_info))}</p></div></div>
    <div class="toolbar comparison-tools"><button id="compare-play">播放 / 暂停</button><button id="compare-back" aria-label="后退 0.04 秒">−</button><button id="compare-forward" aria-label="前进 0.04 秒">＋</button><input id="compare-seek" type="range" min="0" max="1" step="0.04" value="0" aria-label="对照位置"><time id="compare-time">00:00:00</time>
    ${softSubtitles ? '<label><input id="compare-subtitles-toggle" type="checkbox"> 显示成片字幕</label>' : ''}
    ${proxy ? '' : `<button data-export-preview="${escapeHtml(job.id)}" ${['排队','运行中'].includes(job.preview_state) ? 'disabled' : ''}>生成预览代理</button>`}</div>
    <p class="notice">${proxy ? '当前播放的是无声、8-bit 的预览代理，不代表原始质量。' : '直接播放原片与输出；如果无法播放，可生成本地预览代理。'} 对照不能证明全片完整或严格色彩一致。${job.color ? ' 输出色彩：' + escapeHtml(job.color.output + ' / ' + job.color.gamma) + '。' : ' 未应用 Log 还原。'}${sourceInfo && outputInfo ? ' 信息差异：' + (differences.length ? escapeHtml(differences.join('、')) : '未发现所列项目的差异') + '。' : ' 媒体信息不完整。'}${job.preview_state ? ' 预览状态：' + escapeHtml(job.preview_state) : ''}</p></div>` + modalDone(),'comparison');
  const left = byId('compare-left'), right = byId('compare-right'), seek = byId('compare-seek');
  const dialog = byId('modal'), play = byId('compare-play'), clock = byId('compare-time');
  const videos = [left, right];
  if (softSubtitles) {
    const track = byId('compare-subtitles'), toggle = byId('compare-subtitles-toggle');
    toggle.onchange = () => { track.track.mode = toggle.checked ? 'showing' : 'disabled'; };
    track.onerror = () => {
      toggle.checked = false;
      track.track.mode = 'disabled';
      toast('无法读取成片字幕');
    };
  }
  let pendingStart = null;
  dialog.classList.add('comparison-modal');
  const pause = () => {
    pendingStart?.abort();
    videos.forEach(video => video.pause());
  };
  dialog.addEventListener('close', pause, {once:true});
  const waitForMedia = (video, ready, signal) => new Promise((resolve, reject) => {
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked', 'error'];
    const finish = error => {
      events.forEach(event => video.removeEventListener(event, checkReady));
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(signal.reason);
    const checkReady = () => {
      if (signal.aborted) aborted();
      else if (video.error) finish(video.error);
      else if (ready(video)) finish();
    };
    events.forEach(event => video.addEventListener(event, checkReady));
    signal.addEventListener('abort', aborted, {once:true});
    checkReady();
  });
  const updateRange = () => { if (Number.isFinite(left.duration) && Number.isFinite(right.duration)) seek.max = Math.min(left.duration, right.duration); };
  left.onloadedmetadata = right.onloadedmetadata = updateRange;
  left.ontimeupdate = () => {
    seek.value = left.currentTime;
    clock.textContent = timecode(left.currentTime);
    if (!pendingStart && !left.paused && !right.paused && !left.seeking && !right.seeking &&
        Math.abs(right.currentTime - left.currentTime) > 0.2) right.currentTime = left.currentTime;
  };
  seek.oninput = () => { pendingStart?.abort(); left.currentTime = right.currentTime = Number(seek.value); };
  const step = amount => { pause(); const next = Math.max(0, Math.min(Number(seek.max), left.currentTime + amount)); left.currentTime = right.currentTime = next; };
  byId('compare-back').onclick = () => step(-0.04);
  byId('compare-forward').onclick = () => step(0.04);
  play.onclick = async () => {
    if (pendingStart || videos.some(video => !video.paused)) { pause(); return; }
    const start = new AbortController();
    pendingStart = start;
    const timeout = setTimeout(() => start.abort(new Error('Media readiness timed out')), 10000);
    play.textContent = translate('等待画面 · 点击取消');
    try {
      await Promise.all(videos.map(video => waitForMedia(video, v => v.readyState >= 1, start.signal)));
      const duration = Math.min(left.duration, right.duration);
      const target = left.ended || (Number.isFinite(duration) && left.currentTime >= duration) ? 0 : left.currentTime;
      for (const video of videos) if (video.currentTime !== target) video.currentTime = target;
      await Promise.all(videos.map(video => waitForMedia(video, v => !v.seeking && v.readyState >= 2, start.signal)));
      if (start.signal.aborted || !dialog.open || !left.isConnected) return;
      await Promise.all(videos.map(video => video.play()));
    } catch (error) {
      videos.forEach(video => video.pause());
      if ((!start.signal.aborted || error.name !== 'AbortError') && dialog.open && left.isConnected) {
        toast('无法直接播放，请生成预览代理');
      }
    } finally {
      clearTimeout(timeout);
      start.abort();
      pendingStart = null;
      play.textContent = translate('播放 / 暂停');
    }
  };
  left.onerror = right.onerror = () => toast('此媒体无法直接播放，可生成预览代理');
}
byId('modal').addEventListener('close', () => {
  byId('modal').querySelectorAll('video').forEach(video => video.pause());
  byId('modal').classList.remove('comparison-modal');
});

function parseSrt(source) {
  const blocks = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[^\S\n]*\n+/);
  const clock = '(\\d{2,}):([0-5]\\d):([0-5]\\d)[,.](\\d{3})';
  const timing = new RegExp('^' + clock + '\\s+-->\\s+' + clock + '(?:\\s.*)?$');
  const seconds = parts => Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3]) / 1000;
  return blocks.map((block, index) => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const match = timing.exec((lines.shift() || '').trim());
    let text = lines.join('\n').trim();
    if (!match || !text) throw Error(translate('无效的 SRT 字幕段') + ' ' + (index + 1));
    const start = seconds(match.slice(1, 5)), end = seconds(match.slice(5, 9));
    if (!(end > start && end < 1e8)) throw Error(translate('无效的 SRT 字幕段') + ' ' + (index + 1));
    // Only lift an explicit voice tag when it covers the whole cue.
    const voice = /^<v[ \t]+([^<>\r\n]+)>((?:(?!<\/?v\b)[\s\S])+?)(?:<\/v>)?$/i.exec(text);
    const speaker = voice && voice[2].trim() ? voice[1].trim() : '';
    if (speaker) text = voice[2].trim();
    return {start, end, text, speaker, confirmed:false};
  }).sort((a, b) => a.start - b.start);
}

async function importSrt(file, clip) {
  if (!file || !visibleClips().includes(clip)) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw Error(translate('SRT 文件不能超过 2 MB'));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' :
      bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    let source;
    try { source = new TextDecoder(encoding, {fatal:true}).decode(bytes); }
    catch { throw Error(translate('请将 SRT 保存为 UTF-8 或带 BOM 的 UTF-16')); }
    const rows = parseSrt(source);
    if (!visibleClips().includes(clip)) return;
    if (clip.rows.length && !confirm(translate('导入 SRT 会替换当前校对稿，继续吗？'))) return;
    clip.rows = rows;
    delete clip.candidate;
    clip.row = 0;
    scheduleSave();
    if (active === clip) render();
    toast('已导入 SRT');
  } catch (error) { toast(error.message); }
}

function showInsertSubtitle(draft = {}) {
  const clip = active, video = byId('player');
  if (!video || clip === emptyClip) return;
  video.pause();
  if (byId('loop')) byId('loop').checked = false;
  const start = Math.round((video.readyState >= 1 ? video.currentTime : clip.cursor)*1000)/1000;
  const mediaDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : clip.duration;
  const limit = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : Infinity;
  const next = clip.rows.reduce((end,row) => row.start > start ? Math.min(end,row.start) : end,limit);
  const end = Math.max(start,Math.floor(Math.min(start+(draft.duration || 2),next)*1000)/1000);
  modal('在播放处加字幕', `<form id="insert-subtitle-form">
    <div class="secondary-form">
      <div class="subtitle-insert-times">
        <label>开始（秒）<input id="insert-subtitle-start" type="number" min="0" step="0.001" required value="${start.toFixed(3)}"></label>
        <label>结束（秒）<input id="insert-subtitle-end" type="number" min="0" step="0.001" required value="${end.toFixed(3)}"></label>
      </div>
      <label>字幕文字<textarea id="insert-subtitle-text" rows="4" required></textarea></label>
    </div>
    <div class="secondary-footer"><span id="insert-subtitle-message" role="status"></span>
      <div class="toolbar"><button type="button" data-action="close-secondary">返回</button><button class="primary" type="submit">添加字幕</button></div>
    </div></form>`,'secondary-form');
  const textInput = byId('insert-subtitle-text');
  textInput.value = draft.text || '';
  textInput.focus();
  byId('insert-subtitle-form').onsubmit = event => {
    event.preventDefault();
    if (active !== clip || !visibleClips().includes(clip)) return;
    const start = byId('insert-subtitle-start').valueAsNumber;
    const end = byId('insert-subtitle-end').valueAsNumber;
    const text = value('insert-subtitle-text').trim();
    const overlapping = clip.rows.some(row => row.start < end && start < row.end);
    const error = !text ? '请输入字幕文字' :
      !(start >= 0 && end > start) ? '字幕结束时间必须晚于开始时间' :
      end > limit ? '字幕结束时间不能超出素材时长' :
      overlapping ? '这段时间已有字幕，请调整开始或结束时间。' : '';
    if (error) {
      byId('insert-subtitle-message').textContent = translate(error);
      return;
    }
    const after = clip.rows.findIndex(row => row.start > start);
    const index = after < 0 ? clip.rows.length : after;
    clip.rows.splice(index,0,{start,end,text,speaker:draft.speaker || '',confirmed:false});
    if (clip.candidate?.row >= index) clip.candidate.row++;
    clip.row = index;
    hiddenPreviewCaptions.delete(clip.id);
    clip.cursor = start;
    if (video.readyState >= 1) video.currentTime = start;
    byId('modal').close();
    scheduleSave();
    render();
    const inserted = byId('workspace').querySelector('[data-text="' + index + '"]');
    inserted?.scrollIntoView({block:'nearest'});
    inserted?.focus({preventScroll:true});
    toast('字幕已添加');
  };
}

function togglePlayback() {
  const video = byId('player');
  if (colorPreview) colorPreview.togglePlayback();
  else if (video?.paused) video.play().catch(() => toast('此媒体暂时无法播放'));
  else video?.pause();
}

const editingControl = 'input,textarea,select,[contenteditable]:not([contenteditable=false])';
document.addEventListener('keydown', event => {
  const video = byId('player'), target = event.target instanceof Element ? event.target : document.activeElement;
  if (!video || libraryExpanded || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      target?.closest(editingControl) || document.querySelector('dialog[open],#floating-menu:not([hidden])')) return;
  if (page === 3 && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyN') {
    event.preventDefault();
    if (!event.repeat) showInsertSubtitle();
  } else if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey &&
      (!target?.closest('button,summary,a') || target.closest('[data-action=play],[data-timeline-mode]'))) {
    event.preventDefault();
    if (!event.repeat) togglePlayback();
  } else if (['ArrowLeft','ArrowRight'].includes(event.key) && !event.altKey && !event.shiftKey &&
      (isMacPlatform ? !event.ctrlKey : !event.metaKey) &&
      video.readyState >= 1 && Number.isFinite(video.duration)) {
    event.preventDefault();
    if (byId('loop')) byId('loop').checked = false;
    const time = Math.max(0,Math.min(video.duration,video.currentTime+(event.key === 'ArrowLeft' ? -15 : 15)));
    video.currentTime = active.cursor = time;
    subtitleTimeline?.follow(time);
  }
});

const subtitleClipboardType = 'application/x-local-post-subtitle';
const timelineClipboardTarget = event => {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return target?.closest('#subtitle-timeline') && !target.closest(editingControl);
};
document.addEventListener('copy', event => {
  if (!timelineClipboardTarget(event) || !event.clipboardData) return;
  const row = active.rows[active.row];
  if (!row?.text?.trim()) return;
  event.clipboardData.setData('text/plain',row.text);
  event.clipboardData.setData(subtitleClipboardType,JSON.stringify({duration:row.end-row.start,speaker:row.speaker || ''}));
  event.preventDefault();
  toast('已复制字幕');
});
document.addEventListener('paste', event => {
  if (!byId('player') || !timelineClipboardTarget(event)) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text?.trim()) return;
  let data;
  try { data = JSON.parse(event.clipboardData.getData(subtitleClipboardType)); } catch (_) {}
  event.preventDefault();
  showInsertSubtitle({text,duration:Number.isFinite(data?.duration) && data.duration > 0 ? data.duration : undefined,
    speaker:typeof data?.speaker === 'string' ? data.speaker : ''});
});

function download(srt) {
  const stamp = seconds => { const ms = Math.max(0, Math.round(seconds * 1000)); return timecode(Math.floor(ms / 1000)) + ',' + String(ms % 1000).padStart(3,'0'); };
  const withSpeakers = check('speakers');
  const rows = srt ? active.rows.flatMap(row => subtitleDisplayPages(active,row,withSpeakers)).sort((a,b) => a.start-b.start) : active.rows;
  const lines = rows.map((row,index) => {
    const speaker = (row.speaker || '').trim();
    const text = (!srt && withSpeakers && speaker ? speaker + '：' : '') + row.text;
    return srt ? (index + 1) + '\n' + stamp(row.start) + ' --> ' + stamp(row.end) + '\n' + text : timecode(row.start) + '  ' + text;
  });
  const content = lines.join(srt ? '\n\n' : '\n') + '\n';
  const filename = (active.name || '字幕').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') + '.' + (srt ? 'srt' : 'txt');
  if (window.localPost?.saveTextFile) {
    window.localPost.saveTextFile(filename, content).then(saved => { if (saved) toast('已导出'); }).catch(err => toast(err?.message || '导出失败'));
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], {type:'text/plain;charset=utf-8'}));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const token = document.querySelector('meta[name="workbench-token"]').content;
let saveTimer, saveChain = Promise.resolve(), dirty = false, changeVersion = 0, retryTarget = null, projectReady = false;
const uploads = new Map();
const importTickets = new Map();
let audioPreviewUrl = null, audioPreviewRequest = 0;
async function selectPlaybackTrack(clip, forceAudio = false) {
  const requestId = ++audioPreviewRequest;
  if (audioPreviewUrl) {
    for (const item of clips) if (item.url === audioPreviewUrl) item.url = mediaUrl(item.mediaId);
    URL.revokeObjectURL(audioPreviewUrl); audioPreviewUrl = null;
  }
  if (!clip.track && !forceAudio) { clip.url = mediaUrl(clip.mediaId); render(); return; }
  toast('正在准备所选音轨的试听…');
  try {
    const response = await fetch('/api/audio', {method:'POST', headers:{'X-Workbench-Token':token},
      body:JSON.stringify({id:clip.mediaId, audio_track:clip.track})});
    if (!response.ok) throw Error((await response.json()).error || '无法准备试听音轨');
    const blob = await response.blob();
    if (requestId !== audioPreviewRequest || active !== clip) return;
    audioPreviewUrl = URL.createObjectURL(blob); clip.url = audioPreviewUrl; render();
    toast('正在以音频模式试听所选音轨');
  } catch (error) { toast(error.message); }
}
async function api(route, payload) {
  const response = await fetch('/api/' + route, {method: payload === undefined ? 'GET' : 'POST',
    headers: {'X-Workbench-Token': token}, body: payload === undefined ? undefined : JSON.stringify(payload)});
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw Error(body.error || '本地服务请求失败'); }
  return response.json();
}
function scheduleSave() {
  if (studioId === 'none') return;
  dirty = true;
  changeVersion++;
  byId('save-state').textContent = '正在保存…';
  localize(byId('save-state'));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 350);
}
function persist() {
  clearTimeout(saveTimer);
  if (studioId === 'none') return Promise.resolve();
  const version = changeVersion;
  const snapshot = structuredClone({version:1, active: active.id || null, batchSerial, serial, groups, defaults, exportConfig, darkMode, themeMode, previewResolution, reduceMotion,
    clips: clips.map(({url, progress, ...clip}) => ({...clip}))});
  const route = 'studio-state?studio='+studioId;
  saveChain = saveChain.catch(() => {}).then(() => api(route, snapshot)).then(() => {
    if (version === changeVersion) { dirty = false; byId('save-state').textContent = '已自动保存'; localize(byId('save-state')); }
  }).catch(error => { dirty = true; byId('save-state').textContent = '保存失败：' + error.message; });
  return saveChain;
}
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
function mediaUrl(id) { return '/api/media?id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(token); }
let studioItems = [], studioSelected = '', studioMenu = '', studioFilter = 'active';
let studioForm = null, selectedPreset = 0;
function studioTitle(item) {
  return item.id === 'default' && item.name === '原工作台' ? translate(item.name) : item.name;
}
async function showStudioList() {
  if (projectReady && dirty) await persist();
  const catalog = await api('studios');
  studioItems = catalog.items;
  if (!studioSelected) studioSelected = studioId;
  studioMenu = '';
  modal('项目管理',`<div class="secondary-toolbar"><div class="toolbar">
    <button data-studio-filter="active">项目</button><button data-studio-filter="trash">已删除项目</button></div>
    <div class="toolbar"><input id="studio-search" type="search" aria-label="搜索项目" placeholder="搜索项目">
    <select id="studio-sort" aria-label="项目排序"><option value="date">最近编辑</option><option value="name">项目名称</option><option value="size">媒体占用</option></select>
    <button data-action="project-restore">打开项目包</button><button class="primary" data-action="project-create">新建项目</button></div></div>
    <div class="studio-grid" id="studio-grid"></div>
    <div class="secondary-footer"><div id="studio-selection"></div><button class="primary" id="studio-open-selected" disabled>打开项目</button></div>`,'studios');
  const grid = byId('studio-grid');
  grid.ondblclick = event => {
    const card = event.target.closest('[data-studio-pick]');
    if (card && studioFilter !== 'trash') openStudio({action:'open',id:card.dataset.studioPick}).catch(error=>toast(error.message));
  };
  grid.addEventListener('error',event=>{if(event.target.matches('img'))event.target.hidden=true;},true);
  byId('studio-sort').onchange = renderStudioGrid;
  byId('studio-search').oninput = renderStudioGrid;
  renderStudioGrid();
}
function renderStudioGrid() {
  const grid = byId('studio-grid');
  if (!grid) return;
  const search = value('studio-search').trim().toLowerCase(), sort = value('studio-sort');
  const items = studioItems.filter(item => item.trashed === (studioFilter==='trash') && studioTitle(item).toLowerCase().includes(search));
  items.sort((a,b)=>sort==='name' ? studioTitle(a).localeCompare(studioTitle(b)) :
    sort==='size' ? b.bytes-a.bytes : b.updated-a.updated);
  if (!items.some(item=>item.id===studioSelected)) studioSelected=items[0]?.id || '';
  for (const filter of byId('modal').querySelectorAll('[data-studio-filter]')) {
    filter.setAttribute('aria-pressed',String(filter.dataset.studioFilter===studioFilter));
  }
  grid.innerHTML=items.map(item=>`<article class="studio-card" data-selected="${studioSelected===item.id}">
    <button class="studio-tile" data-studio-pick="${item.id}" aria-pressed="${studioSelected===item.id}">
      <span class="studio-cover"><span aria-hidden="true">${item.count ? '♫' : '▱'}</span>
      ${item.cover ? `<img alt="" loading="lazy" src="/api/thumbnail?id=${encodeURIComponent(item.cover)}&amp;token=${encodeURIComponent(token)}">` : ''}</span>
      <span class="studio-info"><strong data-verbatim>${escapeHtml(studioTitle(item))}</strong>
      <small><span>${item.count}</span> <span>项素材</span> · <span data-verbatim>${item.available ? sizeText(item.bytes) : '—'}</span></small>
      <small>${item.available && item.updated ? translate('编辑于')+' '+new Date(item.updated*1000).toLocaleString() :
        item.available ? translate('尚未编辑') : translate('项目位置暂不可用。')}</small></span>
    </button>
    <button class="studio-card-more" data-studio-menu="${item.id}" aria-label="${escapeHtml(translate('项目操作'))}" aria-expanded="${studioMenu===item.id}">⋯</button>
    ${studioMenu===item.id ? `<div class="studio-card-menu">${menuEyebrow('PROJECT ACTIONS')}${item.trashed ? `<button data-studio-recover="${item.id}">恢复项目</button>` :
      `<button data-studio-rename="${item.id}">重命名</button><button data-studio-package="${item.id}" ${item.available?'':'disabled'}>导出项目包</button>
      <button class="studio-danger" data-studio-trash="${item.id}">删除项目</button>`}</div>` : ''}</article>`).join('') ||
    '<p class="muted studio-no-results">没有匹配的项目</p>';
  localize(grid);
  updateStudioSelection();
}
function updateStudioSelection() {
  const chosen = studioItems.find(item=>item.id===studioSelected);
  byId('studio-selection').innerHTML = chosen ?
    `<strong data-verbatim>${escapeHtml(studioTitle(chosen))}</strong><span class="muted studio-directory" data-verbatim>${escapeHtml(chosen.directory)}</span>` :
    '<span>请选择项目</span>';
  localize(byId('studio-selection'));
  const action = byId('studio-open-selected');
  action.disabled = !chosen || (!chosen.trashed && !chosen.available);
  action.textContent = translate(chosen?.trashed ? '恢复项目' : '打开项目');
  action.onclick = () => {
    if (!chosen) return;
    if (chosen.trashed) changeStudioStatus('recover',chosen.id).catch(error=>toast(error.message));
    else openStudio({action:'open',id:chosen.id}).catch(error=>toast(error.message));
  };
}
function showStudioForm(action,id) {
  const item=studioItems.find(entry=>entry.id===id);
  studioForm={action,id,directory:''};
  const titles={create:'新建项目',rename:'重命名项目',trash:'删除项目',export:'导出项目包'};
  const needsDirectory = action === 'create' || action === 'export';
  const contents = [
    ['create','rename'].includes(action) ? `<label>项目名称 <input id="new-studio-name" maxlength="80" value="${action==='rename'?escapeHtml(studioTitle(item)):''}"></label>` : '',
    action === 'export' ? `<p data-verbatim>${escapeHtml(studioTitle(item))}.lpsproject</p><label class="check"><input id="studio-include-media" type="checkbox" checked> 包含媒体</label>` : '',
    action === 'trash' ? `<p><strong data-verbatim>${escapeHtml(studioTitle(item))}</strong></p><p class="muted studio-directory" data-verbatim>${escapeHtml(item.directory)}</p><p>项目将移入「已删除项目」，可恢复。磁盘上的项目文件和媒体副本会保留。</p>` : '',
    needsDirectory ? '<label>保存位置 <div class="toolbar studio-path-field"><input id="studio-form-path" readonly placeholder="请选择目录"><button data-action="project-choose-location">选择位置</button></div></label>' : ''
  ].join('');
  modal(titles[action],`<div class="secondary-form">${contents}</div><div class="secondary-footer">
    <button data-action="project-list">返回项目管理</button><button data-action="project-save-form" class="primary">
    ${action==='create'?'创建项目':action==='rename'?'保存名称':action==='trash'?'移到已删除项目':'导出项目包'}</button></div>`,'secondary-form');
  byId('new-studio-name')?.focus();
}
async function changeStudioStatus(action,id) {
  if (action === 'trash' && id === studioId) await flushStudio();
  const result = await api('studios',{action,id});
  if (action === 'trash' && id === studioId) window.location.assign('/?studio='+encodeURIComponent(result.active));
  else {
    if (action === 'recover') studioFilter='active';
    await showStudioList();
  }
}
async function saveStudioForm() {
  const {action,id,directory}=studioForm;
  const name=value('new-studio-name').trim();
  if (['create','rename'].includes(action) && !name) throw Error('请输入项目名称。');
  if (['create','export'].includes(action) && !directory) throw Error('请选择有效的项目位置。');
  if (action === 'create') await openStudio({action,name,directory});
  if (action === 'rename') {
    if (id === studioId) await flushStudio();
    await api('studios',{action,id,name});
    if (id === studioId) byId('studio-name').textContent = name;
    await showStudioList();
  }
  if (action === 'trash') await changeStudioStatus(action,id);
  if (action === 'export') {
    if (id === studioId) await flushStudio();
    const output = await api('studio-backup',{id,directory,media:check('studio-include-media')});
    toast(translate('已保存项目包')+' · '+output.output);
    await showStudioList();
  }
}
async function flushStudio() {
  if (!projectReady || uploads.size || clips.some(clip=>['排队中','复制中','分析中'].includes(clip.status)) ||
      queue.some(job=>['字幕识别','局部识别'].includes(job.stage) && ['排队','运行中'].includes(job.state))) {
    throw Error('请等当前导入或识别完成后再切换项目。');
  }
  await persist();
  if (dirty) throw Error('当前项目保存失败。');
}
async function openStudio(data) {
  if (data.action === 'open' && data.id === studioId) { byId('modal').close(); return; }
  await flushStudio();
  const result = await api('studios',data);
  window.location.assign('/?studio='+encodeURIComponent(result.id));
}
function showDeliveryPresets() {
  if (selectedPreset >= deliveryPresets.length) selectedPreset = 0;
  const activePreset=deliveryPresets[selectedPreset];
  const details=activePreset?.value?.settings || {};
  const options=activePreset?.value?.options || {};
  const fields=[['交付类型',{video:'视频',audio:'仅音频',subtitles:'仅导字幕',remux:'仅换容器'}[options.kind]],
    ['输出编码',details.preset],['容器',details.container],['色彩处理',details.transform ? colorLabel(details) : '保留原色彩'],
    ['音频编码',details.audio],['视频字幕',{none:'不应用',soft:'软字幕',burn:'烧录字幕'}[details.subtitleMode]],
    ['编码路径',encoderModes[details.encoderMode || 'auto']]];
  modal('常用导出预设',`<div class="secondary-toolbar"><span class="muted">预设应用到选中的素材。</span>
    <button data-action="new-delivery-preset">保存当前设置</button></div><div class="preset-split">
    <div class="preset-library">${deliveryPresets.map((item,index)=>`<button class="codec-card" data-preset-pick="${index}" aria-pressed="${index===selectedPreset}"><strong data-verbatim>${escapeHtml(item.name)}</strong><small>${escapeHtml([item.value?.settings?.preset,item.value?.settings?.container,item.value?.settings?.audio].filter(Boolean).join(' · '))}</small></button>`).join('') || '<p>暂无预设</p>'}</div>
    <div class="preset-detail">${activePreset ? `<h3 data-verbatim>${escapeHtml(activePreset.name)}</h3><dl class="preset-facts">
      ${fields.map(([label,text])=>`<dt>${label}</dt><dd>${escapeHtml(text || '—')}</dd>`).join('')}</dl>` : '<p>选择预设以查看设置。</p>'}</div>
    </div><div class="secondary-footer"><div><span class="muted">待应用</span> <strong data-verbatim>${escapeHtml(activePreset?.name || '—')}</strong></div><div class="toolbar"><button data-action="close-secondary">取消</button>
    ${activePreset ? `<button class="studio-danger" data-remove-preset="${selectedPreset}">删除预设</button>` : ''}
    <button class="primary" data-delivery-preset="${selectedPreset}" ${activePreset?'':'disabled'}>应用预设</button></div></div>`,'presets');
}
function showSavePreset() {
  modal('保存导出预设','<div class="secondary-form"><label>预设名称 <input id="delivery-preset-name" maxlength="64"></label></div>' +
    '<div class="secondary-footer"><button data-action="delivery-presets">返回</button><button class="primary" data-action="save-delivery-preset">保存预设</button></div>','secondary-form');
  byId('delivery-preset-name').focus();
}
const deliveryPresetKeys = [...transcodeKeys,'subtitleMode','captionStyle','captionFont','captionPosition','captionSize',...colorKeys];
function currentPresetValue() {
  const settings = effective(active);
  const options = {...exportConfig};
  delete options.destination;
  return {settings:Object.fromEntries(deliveryPresetKeys.filter(key=>settings[key] !== undefined).map(key=>[key,settings[key]])),options};
}
function applyDeliveryPreset(preset) {
  const targets = repairDelivery ? [repairDelivery] : selectedClips().length ? selectedClips() : active === emptyClip ? [] : [active];
  for (const clip of targets) {
    for (const key of deliveryPresetKeys) delete clip.overrides[key];
    Object.assign(clip.overrides,structuredClone(preset.value.settings));
  }
  Object.assign(exportConfig,preset.value.options);
  byId('modal').close();
  scheduleSave();
  render();
}
function findSubtitleRows() {
  const word = value('subtitle-find');
  return word ? active.rows.map((row,index)=>({row,index})).filter(({row})=>row.text.includes(word)) : [];
}
function showSubtitleSearch() {
  modal('查找与替换','<div class="subtitle-find-fields"><label>查找文字 <input id="subtitle-find"></label>' +
    '<label>替换为 <input id="subtitle-replacement"></label></div><div id="subtitle-matches"></div>' +
    '<div class="secondary-footer"><span id="subtitle-match-count" role="status"></span><div class="toolbar"><button data-action="close-secondary">返回</button><button class="primary" data-action="replace-subtitles">全部替换</button></div></div>','find');
  byId('subtitle-find').focus();
  refreshSubtitleMatches();
}
function refreshSubtitleMatches() {
  const list = byId('subtitle-matches');
  if (!list || !byId('modal').open) return;
  const matches = findSubtitleRows(), word = value('subtitle-find');
  list.innerHTML = matches.map(({row,index})=>`<div class="subtitle-match">
    <time class="mono">${timecode(row.start)}</time><p data-verbatim>${row.text.split(word).map(escapeHtml).join('<mark>'+escapeHtml(word)+'</mark>')}</p>
    <button data-subtitle-replace="${index}">替换这一句</button></div>`).join('') || '<p class="muted">没有匹配的字幕</p>';
  byId('modal').querySelector('[data-action="replace-subtitles"]').disabled = !matches.length;
  byId('subtitle-match-count').textContent = matches.length+' '+translate('句匹配');
  localize(list);
}
function replaceSubtitleMatches(index = null) {
  const word = value('subtitle-find'), replacement = value('subtitle-replacement');
  const selected = findSubtitleRows().filter(match=>index === null || match.index === index);
  for (const {row,index} of selected) {
    row.text = row.text.split(word).join(replacement);
    row.confirmed = false;
    if (active.candidate?.row === index) delete active.candidate;
    localRecognitionJobs.delete(row);
  }
  if (!selected.length) return;
  scheduleSave();
  render();
  refreshSubtitleMatches();
}
async function inspectClip(clip) {
  clip.status = '分析中'; renderLibrary(); updateBatch(); renderQueue();
  const info = await api('probe', {id:clip.mediaId});
  const video = info.video || {};
  Object.assign(clip, {duration:info.duration, codec:video.codec || info.container, tracks:info.audio || [], sourceInfo:info,
    resolution:video.width ? video.width + ' × ' + video.height : null,
    fps:video.frame_rate, depth:video.bit_depth ? video.bit_depth + '-bit' : null,
    chroma:video.pixel_format, audio:(info.audio || []).length + ' 条音轨', status:'已就绪', progress:100,
    url:mediaUrl(clip.mediaId)});
  scheduleSave();
  if ([0,1,2].includes(page) && active === clip && !document.querySelector('dialog[open]')) render();
  else { renderLibrary(); updateBatch(); renderQueue(); }
}
function uploadFile(clip, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); uploads.set(clip.id, xhr);
    xhr.open('POST', '/api/import?id=' + encodeURIComponent(clip.mediaId));
    xhr.setRequestHeader('X-Workbench-Token', token); xhr.responseType = 'json';
    xhr.upload.onprogress = event => { if (event.lengthComputable) { clip.progress = Math.floor(event.loaded / event.total * 100); updateBatch(); if (page === tasksPageIndex) renderQueue(); } };
    xhr.onload = () => { uploads.delete(clip.id); xhr.status === 200 ? resolve() : reject(Error(xhr.response?.error || '复制失败')); };
    xhr.onerror = xhr.onabort = () => { uploads.delete(clip.id); reject(Error('导入中断')); };
    clip.status = '复制中'; renderLibrary(); updateBatch(); renderQueue(); xhr.send(file);
  });
}
let importChain = Promise.resolve();
function enqueueImport(clip, file) {
  const ticket = {cancelled:false}; importTickets.set(clip.id, ticket);
  clip.status = '排队中'; scheduleSave(); renderLibrary(); updateBatch();
  importChain = importChain.then(async () => {
    if (ticket.cancelled) return;
    try {
      await uploadFile(clip, file);
      inspectClip(clip).catch(error => {
        clip.status = '分析失败'; clip.error = error.message; scheduleSave();
        if (page === 0 && active === clip) render(); else { renderLibrary(); updateBatch(); }
        renderQueue(); toast(error.message);
      });
    }
    catch (error) {
      let recovered = false;
      try {
        const project = await api('open', {id:clip.mediaId});
        if (project.media_available) {
          recovered = true;
          inspectClip(clip).catch(problem => { clip.status = '分析失败'; clip.error = problem.message; scheduleSave(); renderLibrary(); updateBatch(); renderQueue(); });
        }
      } catch (_) {}
      if (!recovered) { clip.status = '已中断'; clip.error = error.message; scheduleSave(); renderLibrary(); updateBatch(); toast(error.message); }
    }
    finally { if (importTickets.get(clip.id) === ticket) importTickets.delete(clip.id); renderQueue(); }
  });
}
let recognitionChain = Promise.resolve();
const localRecognitionJobs = new WeakMap();
let candidateReview = null;
byId('modal').addEventListener('close', () => {
  if (!byId('modal').open) candidateReview = null;
});

function updateCandidateReview() {
  const review = candidateReview;
  if (!review || !review.node.isConnected || !byId('modal').open) return;
  const {clip, row, index, node} = review;
  const job = localRecognitionJobs.get(row);
  const busy = job && ['排队','运行中'].includes(job.state);
  const candidate = job?.candidate || (clip.candidate?.row === index ? clip.candidate.text : '');
  node.querySelector('[data-candidate-text]').textContent = candidate || translate('尚无该句候选');
  node.querySelector('[data-candidate-status]').textContent = job ? translate(job.message || job.state) : '';
  node.querySelector('progress').hidden = !busy;
  node.querySelector('[data-action="rerun"]').disabled = Boolean(busy) || !clip.mediaId || clip.status !== '已就绪';
  node.querySelector('[data-action="accept"]').disabled = Boolean(busy) || !candidate;
}

function recognizeClip(clip, interval) {
  const settings = effective(clip);
  const backend = npuRecognitionReady && settings.model === 'Base' && settings.recognitionBackend === 'npu' ? 'npu' : 'cpu';
  const job = {clipId:clip.id, name:clip.name, stage:interval ? '局部识别' : '字幕识别', state:'排队', message:''};
  const sourceRow = interval ? clip.rows[interval.row] : null;
  const publish = () => { renderQueue(); updateCandidateReview(); };
  if (sourceRow) localRecognitionJobs.set(sourceRow, job);
  queue.push(job); publish();
  recognitionChain = recognitionChain.catch(() => {}).then(async () => {
    job.state = '运行中'; publish();
    try {
      const model = {'Base':'base','Medium.en':'medium','Large-v3-turbo':'turbo'}[settings.model];
      const language = {'中文':'zh','英语':'en'}[settings.language] || null;
      const response = await fetch('/api/transcribe', {method:'POST', headers:{'X-Workbench-Token':token},
        body:JSON.stringify({id:clip.mediaId, model, language, interval, audio_track:clip.track || 0, backend})});
      if (!response.ok) { const body = await response.json(); throw Error(body.error || '识别失败'); }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '', result;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        buffer += part.value; const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) { if (!line) continue; const event = JSON.parse(line);
          if (event.error) throw Error(event.error);
          if (event.progress) { job.message = event.progress; publish(); }
          if (event.result) result = event.result;
        }
      }
      if (!result) throw Error('识别中断，没有收到完整结果');
      job.profile = result.backend === 'npu' ? 'Intel NPU' : 'CPU';
      if (interval) {
        const candidate = result.rows.map(row => row.text).join(' ').trim();
        if (!candidate) throw Error('本句未识别到可用文字');
        job.candidate = candidate;
        const index = clip.rows.indexOf(sourceRow);
        if (index !== -1 && localRecognitionJobs.get(sourceRow) === job) clip.candidate = {row:index, text:candidate};
      } else if (!clip.rows.length) {
        if (!clip.original.length) clip.original = structuredClone(result.rows);
        clip.rows = result.rows.map(row => ({...row,speaker:row.speaker || '',confirmed:false}));
      } else {
        clip.pendingResult = result.rows;
      }
      job.state = '已完成'; job.message = interval ? '候选已生成' : (clip.pendingResult ? '新识别结果待确认' : '初稿已生成');
      scheduleSave(); if (!interval && active === clip) render();
    } catch (error) { job.state = '失败'; job.message = error.message; }
    publish();
  });
}
async function addFiles(files) {
  if (studioId === 'none') { toast('请先新建或打开项目。'); return; }
  if (!projectReady) { toast('项目仍在恢复，暂时不能导入'); return; }
  const list = [...files]; if (!list.length) return;
  if (retryTarget) {
    const clip = retryTarget; retryTarget = null;
    if ((list[0].size !== clip.bytes || list[0].name !== clip.name) &&
        !confirm('选择的文件名或大小与记录不一致。请确认这是相同素材，字幕时间可能不匹配。继续关联吗？')) return;
    try {
      if (clip.mediaId) await api('prepare-relink', {id:clip.mediaId,size:list[0].size});
      else clip.mediaId = (await api('prepare-import', {name:clip.name,size:list[0].size,studio_id:studioId})).id;
    }
    catch (error) { toast(error.message); return; }
    clip.bytes = list[0].size;
    enqueueImport(clip, list[0]); return;
  }
  const batch = ++batchSerial;
  for (const file of list) {
    if (clips.some(clip => clip.name === file.name && clip.bytes === file.size) && !confirm(file.name + ' 可能已经导入。仍然导入吗？')) continue;
    const clip = {id:++serial,batch,name:file.name,bytes:file.size,
      cursor:0,row:0,track:0,selected:true,rows:[],original:[],overrides:{},status:'排队中'};
    clips.push(clip); active = clip; page = 0; scheduleSave(); render();
    try {
      const prepared = await api('prepare-import', {name:file.name,size:file.size,studio_id:studioId});
      clip.mediaId = prepared.id; scheduleSave();
      if (clip.status !== '已中断') enqueueImport(clip, file);
    } catch (error) { clip.status = '失败'; clip.error = error.message; scheduleSave(); render(); toast(file.name + '：' + error.message); }
  }
}

byId('files').onchange = event => { addFiles(event.target.files); event.target.value = ''; };
byId('add').onclick = () => byId('files').click();
function updateLibraryToggle() {
  const button = byId('expand-library');
  const label = libraryExpanded ? '收起素材库' : '展开素材库';
  button.innerHTML = libraryExpanded
    ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 6h3.5M10 6V2.5M6 10H2.5M6 10v3.5M10 6l3.5-3.5M6 10l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.setAttribute('aria-expanded', String(libraryExpanded));
  button.setAttribute('aria-label', translate(label));
  button.title = translate(label);
}
byId('expand-library').onclick = () => {
  libraryExpanded = !libraryExpanded;
  document.body.classList.toggle('library-expanded', libraryExpanded);
  updateLibraryToggle();
  closeFloatingMenu();
  renderLibrary();
};
byId('media-list').addEventListener('error', event => {
  if (event.target.matches('.clip-thumbnail img')) event.target.hidden = true;
}, true);
byId('new-group').onclick = () => {
  if (!projectReady) { toast('项目仍在恢复，请稍候'); return; }
  modal('新建文件夹', '<div class="secondary-form"><label>文件夹名称 <input id="group-name" maxlength="80" autofocus></label></div><div class="secondary-footer end"><button data-action="close-secondary">取消</button><button class="primary" data-create-group>创建</button></div>');
  byId('group-name').focus();
};
byId('trash').onclick = () => {
  const removed = clips.filter(clip => clip.removed);
  modal('已移除的素材', '<div class="library-scroll library-list">' + (removed.length ? removed.map(clip =>
    `<div class="organize-row"><span data-verbatim>${escapeHtml(clip.name)}</span><button data-restore-clip="${clip.id}">恢复</button></div>`).join('') +
    '<p class="notice">原文件、项目副本和字幕稿均保留在本机。</p>' : '<p>没有已移除的素材。</p>') + '</div>' + modalDone());
};
byId('legacy').onclick = async () => {
  if (!projectReady) { toast('项目仍在恢复，请稍候'); return; }
  try {
    const projects = await api('legacy-projects');
    modal('导入旧版项目', '<div class="library-scroll library-list">' + (projects.length ? projects.map((project, index) =>
      `<div class="toolbar"><span data-verbatim>${escapeHtml(project.name)} · ${project.source === 'work' ? '工作目录' : '旧版程序'} · ${sizeText(project.size)}</span><button data-legacy="${index}">复制到开发版</button></div>`).join('') : '<p>没有找到旧版项目。</p>') + '</div>' + modalDone());
    byId('modal').legacyProjects = projects;
  } catch (error) { toast(error.message); }
};
byId('samples').onclick = () => {
  const batch = ++batchSerial;
  clips.push(...structuredClone(sampleClips).map(clip => ({...clip, batch})));
  active = clips.find(clip => clip.id === 1);
  byId('samples').hidden = true;
  render();
};
byId('search').oninput = renderLibrary;
byId('sort').onchange = renderLibrary;
byId('select-all').onchange = event => { visibleClips().forEach(clip => { clip.selected = event.target.checked; }); render(); };
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } });
byId('media-list').addEventListener('contextmenu', event => {
  const item = event.target.closest('.item');
  if (!item) return;
  event.preventDefault(); item.querySelector('[data-organize]')?.click();
});
// A marquee begins on an empty part of the library; existing rows remain draggable.
const librarySurface = byId('media-list').closest('.library');
let marquee = null;
function paintLibrarySelection() {
  byId('media-list').querySelectorAll('[data-clip-item]').forEach(element => {
    const clip = clips.find(item => item.id === Number(element.dataset.clipItem));
    if (!clip) return;
    element.classList.toggle('selected', Boolean(clip.selected));
    const checkbox = element.querySelector('[data-pick]');
    if (checkbox) checkbox.checked = Boolean(clip.selected);
  });
}
librarySurface.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !projectReady || event.target.closest('button,input,select,textarea,.item,.group-head')) return;
  if (!event.target.closest('#media-list') && event.target !== librarySurface) return;
  marquee = {pointer:event.pointerId, x:event.clientX, y:event.clientY,
    additive:event.ctrlKey || event.metaKey || event.shiftKey,
    previous:new Map(visibleClips().map(clip => [clip.id, Boolean(clip.selected)])), started:false};
  librarySurface.setPointerCapture(event.pointerId);
});
librarySurface.addEventListener('pointermove', event => {
  if (!marquee || event.pointerId !== marquee.pointer) return;
  if (!marquee.started && Math.hypot(event.clientX - marquee.x, event.clientY - marquee.y) < 5) return;
  marquee.started = true;
  let overlay = byId('library-marquee');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'library-marquee'; document.body.appendChild(overlay); }
  const bounds = librarySurface.getBoundingClientRect();
  const left = Math.max(bounds.left, Math.min(marquee.x, event.clientX));
  const top = Math.max(bounds.top, Math.min(marquee.y, event.clientY));
  const right = Math.min(bounds.right, Math.max(marquee.x, event.clientX));
  const bottom = Math.min(bounds.bottom, Math.max(marquee.y, event.clientY));
  Object.assign(overlay.style, {left:left+'px', top:top+'px', width:Math.max(0,right-left)+'px', height:Math.max(0,bottom-top)+'px'});
  const hits = new Set();
  byId('media-list').querySelectorAll('[data-clip-item]').forEach(element => {
    const rect = element.getBoundingClientRect();
    if (rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom && rect.bottom > bounds.top && rect.top < bounds.bottom) hits.add(Number(element.dataset.clipItem));
  });
  visibleClips().forEach(clip => { clip.selected = hits.has(clip.id) || (marquee.additive && marquee.previous.get(clip.id)); });
  paintLibrarySelection();
});
function finishMarquee(event, cancelled = false) {
  if (!marquee || event.pointerId !== marquee.pointer) return;
  const completed = marquee;
  marquee = null;
  byId('library-marquee')?.remove();
  if (cancelled) visibleClips().forEach(clip => { clip.selected = completed.previous.get(clip.id) || false; });
  if (completed.started) { if (!cancelled) scheduleSave(); render(); }
}
librarySurface.addEventListener('pointerup', event => finishMarquee(event));
librarySurface.addEventListener('pointercancel', event => finishMarquee(event, true));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !marquee) return;
  const pointerId = marquee.pointer;
  finishMarquee({pointerId}, true);
  if (librarySurface.hasPointerCapture(pointerId)) librarySurface.releasePointerCapture(pointerId);
  event.preventDefault();
});

let draggedClipIds = null;
const mediaList = byId('media-list');
mediaList.addEventListener('dragstart', event => {
  const item = event.target.closest('[data-clip-item]');
  if (!item || event.target.closest('input,.item-menu')) { event.preventDefault(); return; }
  const clip = visibleClips().find(entry => entry.id === Number(item.dataset.clipItem));
  if (!clip) { event.preventDefault(); return; }
  if (!clip.selected) {
    visibleClips().forEach(entry => { entry.selected = entry === clip; });
    paintLibrarySelection(); scheduleSave();
  }
  draggedClipIds = selectedClips().map(entry => entry.id);
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/x-local-post-clips', draggedClipIds.join(','));
  item.classList.add('dragging');
});
mediaList.addEventListener('dragover', event => {
  const target = event.target.closest('[data-drop-group]');
  if (!target || !draggedClipIds) return;
  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
  mediaList.querySelectorAll('.drop-target').forEach(node => { if (node !== target) node.classList.remove('drop-target'); });
  target.classList.add('drop-target');
});
mediaList.addEventListener('dragleave', event => {
  const target = event.target.closest('[data-drop-group]');
  if (target && !target.contains(event.relatedTarget)) target.classList.remove('drop-target');
});
mediaList.addEventListener('drop', event => {
  const target = event.target.closest('[data-drop-group]');
  if (!target || !draggedClipIds) return;
  event.preventDefault(); event.stopPropagation();
  const group = groups.find(item => item.id === target.dataset.dropGroup);
  if (!group) return;
  const ids = new Set(draggedClipIds);
  const moved = visibleClips().filter(clip => ids.has(clip.id));
  moved.forEach(clip => { clip.groupId = group.id; });
  group.collapsed = false;
  draggedClipIds = null; scheduleSave(); render();
  toast('已移动 ' + moved.length + ' 个素材到文件夹' + (moved.some(clip => clip.pinned) ? '；置顶素材仍显示在顶部' : ''));
});
mediaList.addEventListener('dragend', () => {
  draggedClipIds = null;
  mediaList.querySelectorAll('.drop-target,.dragging').forEach(node => node.classList.remove('drop-target','dragging'));
});
byId('theme-toggle')?.addEventListener('click', () => {
  const order = ['auto', 'dark', 'light'];
  themeMode = order[(order.indexOf(themeMode) + 1) % order.length];
  try { localStorage.setItem('local-post-theme-mode', themeMode); } catch (_) {}
  applyTheme();
  if (projectReady) scheduleSave();
});
byId('settings').onclick = () => modal('界面与资源设置', `<div class="library-scroll settings-library"><section class="library-box fields"><h3>外观</h3>
  <label>外观模式<select id="theme-mode">
    <option value="auto" ${themeMode === 'auto' ? 'selected' : ''}>跟随系统</option>
    <option value="dark" ${themeMode === 'dark' ? 'selected' : ''}>深色模式</option>
    <option value="light" ${themeMode === 'light' ? 'selected' : ''}>浅色模式</option>
  </select></label>
  <label>工作区导航<select id="nav-position"><option value="top">顶部</option><option value="bottom" ${document.body.classList.contains('bottom') ? 'selected' : ''}>底部</option></select></label>
  <label class="check"><input id="show-workspace-art" type="checkbox" ${showWorkspaceArt ? 'checked' : ''}> 显示背景装饰线</label>
  <label class="check"><input id="reduce-motion" type="checkbox" ${reduceMotion ? 'checked' : ''}> 减少动态效果</label>
  </section><section class="library-box fields"><h3>资源说明</h3><p class="notice">${isMacPlatform
    ? '当前策略：文件复制最多 1 项、媒体分析最多 2 项；识别、转码和预览代理共享单个计算任务位。转码线程可在转码页设置，自动模式按逻辑处理器调整；由 macOS 调度核心。'
    : '当前策略：文件复制最多 1 项、媒体分析最多 2 项；识别、转码和预览代理共享单个计算任务位。转码线程可在转码页设置，自动模式按逻辑处理器调整；由 Windows 调度核心。'}</p>
  <p class="notice">${isMacPlatform
    ? 'GPU 编码：转码页可选自动、CPU 或 GPU，在 macOS 上支持 Apple VideoToolbox 硬件编码并按规格实测校验。色彩预览可在兼容素材上使用 VideoToolbox 硬件解码。离线字幕识别使用本地 Whisper 模型。'
    : 'GPU 编码：转码页可选自动、CPU 或 GPU，可用性按本机和编码档位检测。色彩预览可在兼容素材上使用 Intel Quick Sync 解码。字幕默认用 CPU；具备运行条件时，Base 可选实验性的 Intel NPU。'}</p></section></div>` + modalDone());
function openTasks() {
  if (page !== tasksPageIndex) {
    page = tasksPageIndex;
    libraryExpanded = false;
    document.body.classList.remove('library-expanded');
    updateLibraryToggle();
    render();
    byId('workspace').scrollTop = 0;
  }
}

document.addEventListener('change', event => {
  const el = event.target;
  if (el.id === 'resolution-preset' || el.id === 'aspect-preset') {
    applyResolutionPreset(el);
  } else if (el.matches('[data-color-control]')) {
    setColorSelection(el.dataset.colorControl,el.value);
    render();
    byId('workspace').querySelector(`[data-color-control="${el.dataset.colorControl}"]`)?.focus();
  } else if (el.matches('[data-pick]')) {
    clips.find(clip => clip.id === +el.dataset.pick).selected = el.checked;
    render();
  } else if (el.id === 'scope-signal') {
    scopeSignal = el.value;
    redrawScope?.();
  } else if (el.id === 'scope') {
    scope = el.value;
    render();
  } else if (el.id === 'transcode-track') {
    active.track = +el.value;
    scheduleSave();
    render();
    byId('transcode-track')?.focus();
  } else if (el.id === 'track') {
    active.track = +el.value;
    selectPlaybackTrack(active);
  } else if (el.id === 'nav-position') {
    document.body.classList.toggle('bottom', el.value === 'bottom');
  } else if (el.id === 'theme-mode') {
    themeMode = el.value;
    try { localStorage.setItem('local-post-theme-mode', themeMode); } catch (_) {}
    applyTheme();
    if (projectReady) scheduleSave();
  } else if (el.id === 'show-workspace-art') {
    showWorkspaceArt = el.checked;
    document.body.classList.toggle('hide-art', !showWorkspaceArt);
    try { localStorage.setItem('local-post-show-art', String(showWorkspaceArt)); } catch (_) {}
  } else if (el.id === 'dark-mode') {
    themeMode = el.checked ? 'dark' : 'light';
    try { localStorage.setItem('local-post-theme-mode', themeMode); } catch (_) {}
    applyTheme();
    if (projectReady) scheduleSave();
  } else if (el.id === 'reduce-motion') {
    reduceMotion = el.checked;
    document.body.classList.toggle('reduce-motion', reduceMotion);
    try { localStorage.setItem('local-post-reduce-motion', String(reduceMotion)); } catch (_) {}
    if (reduceMotion) document.getAnimations().forEach(animation => {
      if (animation.effect?.target?.matches?.('.workspace-change, #color-options > *, .meter > span')) animation.cancel();
    });
    scheduleSave();
  } else if (el.id === 'job-limit' || el.id === 'thread-limit') {
    limits[el.id === 'job-limit' ? 'jobs' : 'threads'] = el.value;
  } else if (el.matches('[data-field]')) {
    const target = scope === 'batch' && page !== 3 ? defaults : active.overrides;
    target[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    if (page === 3 && el.dataset.field === 'model') {
      if (el.value === 'Medium.en') active.overrides.language = '英语';
      render();
    } else if (el.dataset.field === 'subtitleMode') {
      const stage = el.closest('.stage-controls');
      const enabled = el.value !== 'none';
      stage.dataset.enabled = String(enabled);
      const status = stage.querySelector('.stage-status');
      status.textContent = enabled ? '已启用' : '已关闭';
      localize(stage);
      renderLibrary();
    } else if (page !== 3) {
      render();
      if (el.classList.contains('stage-switch')) byId('workspace').querySelector(`[data-field="${el.dataset.field}"]`).focus();
    }
    else renderLibrary();
  } else if (el.matches('[data-caption-time]')) {
    const index = +el.dataset.captionIndex;
    const row = active.rows[index], key = el.dataset.captionTime, value = el.valueAsNumber;
    if (!Number.isFinite(value) || value < 0 || (key === 'start' ? value >= row.end : value <= row.start)) {
      el.value = row[key];
      toast('字幕结束时间必须晚于开始时间');
      return;
    }
    row[key] = value;
    refreshSubtitleTiming(index);
    subtitleTimeline?.redraw();
  } else if (el.matches('[data-confirm]')) {
    active.rows[+el.dataset.confirm].confirmed = el.checked;
  }
  if (el.matches('[data-export-setting]')) exportConfig[el.dataset.exportSetting] = el.value;
  if (el.matches('[data-pick], [data-field], [data-confirm], [data-export-setting]') || el.id === 'track' || el.id === 'select-all') scheduleSave();
  if (el.matches('[data-export-setting]') && page === 4) {
    if (el.dataset.exportSetting === 'kind') render();
    else if (el.dataset.exportSetting === 'destination') checkDeliveryDirectory();
    else refreshDeliveryConfirmation();
  }
});
document.addEventListener('input', event => {
  const el = event.target;
  if (el.id === 'subtitle-find') { refreshSubtitleMatches();return; }
  if (el.id === 'caption-size' && active !== emptyClip) {
    const value = el.valueAsNumber;
    active.overrides.captionSize = value;
    el.setAttribute('aria-valuetext', value + '%');
    byId('caption-size-value').textContent = value + '%';
    updatePreviewCaption();
    scheduleSave();
    return;
  }
  if (el.matches('[data-export-setting]')) {
    exportConfig[el.dataset.exportSetting] = el.value;
    if (el.dataset.exportSetting === 'destination') {
      exportSpace = null;
      exportDirectoryError = '';
      byId('export-space-status').textContent = translate('剩余空间未检查');
    }
    if (el.tagName === 'INPUT') refreshDeliveryConfirmation();
    scheduleSave();
    return;
  }
  const key = el.matches('[data-text]') ? 'text' : el.matches('[data-speaker]') ? 'speaker' : null;
  if (!key) return;
  const index = +(key === 'text' ? el.dataset.text : el.dataset.speaker);
  active.rows[index][key] = el.value;
  if (key === 'text') subtitleTimeline?.updateLabel(index);
  active.rows[index].confirmed = false;
  byId('workspace').querySelector(`[data-confirm="${index}"]`).checked = false;
  updatePreviewCaption();
  scheduleSave();
});

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.subtitleReplace !== undefined) { replaceSubtitleMatches(+button.dataset.subtitleReplace);return; }
  if (button.dataset.deliveryFix) {
    const [row,index] = button.dataset.deliveryFix.split(':').map(Number);
    const plan = currentDeliveryPlans()[row], issue = plan?.issues[index];
    if (!issue) return;
    active = plan.clip;
    scope = 'clip';
    const [target, , selector] = issue;
    page = target;
    render();
    const workspace = byId('workspace');
    workspace.scrollTop = 0;
    const field = selector && workspace.querySelector(selector);
    if (field) field.focus();
    else byId('navigation').querySelector('[aria-current]').focus();
    return;
  }
  if (button.dataset.captionStyle && active !== emptyClip) {
    active.overrides.captionStyle = button.dataset.captionStyle;
    const caption = byId('preview-caption');
    if (caption) caption.dataset.captionLook = active.overrides.captionStyle;
    byId('caption-styles').querySelectorAll('button').forEach(card => card.setAttribute('aria-pressed', String(card === button)));
    scheduleSave();
    return;
  }
  if (button.dataset.colorDirection) { switchColorDirection(button.dataset.colorDirection); return; }
  if (button.dataset.scopeView) {
    scopeView = button.dataset.scopeView;
    byId('workspace').querySelectorAll('[data-scope-view]').forEach(item=>item.setAttribute('aria-pressed',item === button));
    byId('scope-scale').style.visibility = scopeView === 'vector' ? 'hidden' : 'visible';
    byId('waveform').closest('.waveform-plot').dataset.scopeKind = scopeView;
    byId('waveform').setAttribute('aria-label',translate(scopeViews[scopeView]));
    redrawScope?.();
    return;
  }
  if (button.dataset.colorPick) { openColorPicker(button.dataset.colorPick); return; }
  if (button.dataset.colorSetting) {
    setColorSelection(button.dataset.colorSetting, button.dataset.colorValue);
    render();
    const replacement = byId('workspace').querySelector(`[data-color-setting="${button.dataset.colorSetting}"][aria-pressed=true]`);
    replacement?.focus();
    return;
  }
  if (button.dataset.exportCancel) {
    api('export-cancel', {id:button.dataset.exportCancel}).then(refreshExportJobs).catch(error => toast(error.message));
  }
  if (button.dataset.exportRetry) {
    api('export-retry', {id:button.dataset.exportRetry}).then(refreshExportJobs).catch(error => toast(error.message));
  }
  if (button.dataset.exportRepair) {
    const job = exportJobs.find(item=>item.id===button.dataset.exportRepair);
    const clip = visibleClips().find(item=>item.mediaId===job?.media_id);
    if (!clip) return;
    repairDelivery = clip;
    active = clip;
    scope = 'clip';
    Object.assign(exportConfig,{kind:job.kind || 'video',destination:job.destination,
      audioFormat:job.kind === 'audio' ? job.container.toUpperCase() : exportConfig.audioFormat,
      template:job.template || exportConfig.template,
      collision:job.collision,muxAudio:job.mux_audio,muxSubtitles:job.copy_subtitles ? '保留' : '省略'});
    if (job.kind === 'video') {
      Object.assign(clip.overrides,{preset:job.profile,container:job.container.toUpperCase(),audio:job.audio,
        threads:job.threads,transcode:job.transcode,transform:!!job.color,subtitleMode:job.subtitle_mode,
        captionStyle:job.caption_style || clip.overrides.captionStyle,captionFont:job.caption_font,
        captionPosition:job.caption_position,captionSize:job.caption_size,
        encoderMode:job.encoder_mode || 'auto',targetSize:job.target_size_mb || '',
        outputWidth:job.output_width || '',outputHeight:job.output_height || '',outputFps:job.output_fps || '保持原值',
        proresSpeed:job.prores_speed === 'fixed' ? '快速（固定量化）' : '标准'});
      if (job.color?.input_id) {
        const reverse = job.color.direction === 'to_log';
        clip.overrides.colorDirection = job.color.direction;
        clip.overrides[reverse ? 'logColor' : 'viewColor'] = {input_id:job.color.input_id,output_id:job.color.output_id,
          range:{limited:'有限',full:'完整'}[job.color.range],matrix:{bt709:'BT.709',bt2020:'BT.2020 NCL'}[job.color.matrix],
          strategy:job.color.strategy,highlight:job.color.highlight || 'off',
          tone:job.color.tone || (job.color.highlight === 'shoulder' ? 'legacy' : 'none'),ootf:job.color.ootf || 'off',
          white_adapt:job.color.white_adapt === false ? 'off' : 'on',input_peak:job.color.input_peak ?? 400,output_peak:job.color.output_peak ?? 100,
          output_range:job.color.output_range || 'auto',output_matrix:job.color.output_matrix || 'auto'};
      }
    }
    exportSpace = null; exportDirectoryError = '';
    page = job.kind === 'video' ? 1 : 4;
    render();
    byId('workspace').scrollTop = 0;
    scheduleSave();
    toast('修正设置后，在导出页重新提交此素材');
    return;
  }
  if (button.dataset.studioFilter) {
    studioFilter = button.dataset.studioFilter;
    studioMenu = '';
    renderStudioGrid();
    return;
  }
  if (button.dataset.studioPick) {
    studioSelected = button.dataset.studioPick;
    if (studioMenu) { studioMenu = ''; renderStudioGrid(); }
    else {
      for (const card of byId('studio-grid').querySelectorAll('[data-studio-pick]')) {
        const selected = String(card.dataset.studioPick === studioSelected);
        card.setAttribute('aria-pressed',selected);
        card.closest('.studio-card').dataset.selected = selected;
      }
      updateStudioSelection();
    }
    return;
  }
  if (button.dataset.studioMenu) {
    studioSelected = button.dataset.studioMenu;
    studioMenu = studioMenu === studioSelected ? '' : studioSelected;
    renderStudioGrid();
    return;
  }
  if (button.dataset.studioRename) { showStudioForm('rename',button.dataset.studioRename);return; }
  if (button.dataset.studioPackage) { showStudioForm('export',button.dataset.studioPackage);return; }
  if (button.dataset.studioTrash) { showStudioForm('trash',button.dataset.studioTrash);return; }
  if (button.dataset.studioRecover) { changeStudioStatus('recover',button.dataset.studioRecover).catch(error=>toast(error.message));return; }
  if (button.dataset.presetPick !== undefined) { selectedPreset=+button.dataset.presetPick;showDeliveryPresets();return; }
  if (button.dataset.deliveryPreset !== undefined) {
    applyDeliveryPreset(deliveryPresets[+button.dataset.deliveryPreset]);return;
  }
  if (button.dataset.removePreset !== undefined) {
    const index = +button.dataset.removePreset;
    const preset = deliveryPresets[index];
    if (preset) modal('删除预设',`<div class="secondary-form"><p>删除这个导出预设？</p><strong data-verbatim>${escapeHtml(preset.name)}</strong></div>
      <div class="secondary-footer"><button data-action="delivery-presets">返回</button><button class="primary" data-confirm-remove-preset="${index}">删除预设</button></div>`,'secondary-form');
    return;
  }
  if (button.dataset.confirmRemovePreset !== undefined) {
    const preset = deliveryPresets[+button.dataset.confirmRemovePreset];
    if (preset) api('delivery-presets',{action:'remove',name:preset.name})
      .then(items=>{deliveryPresets=items;showDeliveryPresets();}).catch(error=>toast(error.message));
    return;
  }
  if (button.dataset.exportCompare) {
    const job = exportJobs.find(item => item.id === button.dataset.exportCompare);
    if (job) showComparison(job);
  }
  if (button.dataset.exportOpen) {
    const job = exportJobs.find(item => item.id === button.dataset.exportOpen);
    if (job) openNativeDirectory(job.destination).then(error => { if (error) toast(error); });
  }
  if (button.dataset.exportPreview) {
    button.disabled = true;
    api('export-preview', {id:button.dataset.exportPreview}).then(() => { byId('modal').close(); toast('预览代理已排队，完成后重新打开对照'); refreshExportJobs(); })
      .catch(error => { button.disabled = false; toast(error.message); });
  }
  if (button.dataset.organize) {
    const clip = clips.find(item => item.id === +button.dataset.organize);
    if (floatingMenuAnchor === button && !byId('floating-menu')?.hidden) closeFloatingMenu(true);
    else showClipMenu(button, clip);
  }
  if (button.dataset.chooseGroup) showGroupChoices(clips.find(item => item.id === +button.dataset.chooseGroup));
  if (button.dataset.menuBack) showClipMenu(floatingMenuAnchor, clips.find(item => item.id === +button.dataset.menuBack));
  if (button.dataset.pinClip) {
    const clip = clips.find(item => item.id === +button.dataset.pinClip);
    clip.pinned = !clip.pinned; closeFloatingMenu(); scheduleSave(); renderLibrary();
  }
  if (button.dataset.moveClip) {
    const clip = clips.find(item => item.id === +button.dataset.moveClip);
    clip.groupId = button.dataset.destination || ''; closeFloatingMenu(); scheduleSave(); renderLibrary();
  }
  if (button.dataset.removeClip) {
    const clip = clips.find(item => item.id === +button.dataset.removeClip);
    if (['排队中','复制中','分析中'].includes(clip.status) || queue.some(job => job.clipId === clip.id && ['排队','运行中'].includes(job.state))) {
      toast('该素材有进行中的任务，请等待完成或先取消导入'); return;
    }
    clip.removed = true; clip.selected = false;
    if (active === clip) active = visibleClips()[0] || emptyClip;
    closeFloatingMenu(); scheduleSave(); render(); renderQueue();
  }
  if (button.dataset.restoreClip) {
    const clip = clips.find(item => item.id === +button.dataset.restoreClip);
    clip.removed = false; active = clip; byId('modal').close(); scheduleSave(); render(); renderQueue();
  }
  if (button.dataset.toggleGroup) {
    const group = groups.find(item => item.id === button.dataset.toggleGroup);
    group.collapsed = !group.collapsed; scheduleSave(); renderLibrary();
  }
  if (button.dataset.groupMenu) {
    const group = groups.find(item => item.id === button.dataset.groupMenu);
    if (floatingMenuAnchor === button && !byId('floating-menu')?.hidden) closeFloatingMenu(true);
    else showFloatingMenu(button, `${menuEyebrow('FOLDER ACTIONS')}<div class="floating-menu-caption" data-verbatim title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</div>
      <button role="menuitem" data-rename-group="${escapeHtml(group.id)}"><span class="menu-icon" aria-hidden="true">✎</span>重命名文件夹</button>
      <div class="menu-divider"></div><button role="menuitem" class="menu-remove" data-delete-group="${escapeHtml(group.id)}"><span class="menu-icon" aria-hidden="true">−</span>删除文件夹</button>`);
  }
  if (button.dataset.renameGroup) {
    const group = groups.find(item => item.id === button.dataset.renameGroup);
    closeFloatingMenu();
    modal('重命名文件夹', `<div class="secondary-form"><label>文件夹名称 <input id="group-name" maxlength="80" value="${escapeHtml(group.name)}"></label></div><div class="secondary-footer end"><button data-action="close-secondary">取消</button><button class="primary" data-save-group="${escapeHtml(group.id)}">保存</button></div>`);
    byId('group-name').focus();
  }
  if (button.hasAttribute('data-create-group') || button.dataset.saveGroup) {
    const name = byId('group-name').value.trim();
    if (!name) { toast('请输入文件夹名称'); return; }
    const group = button.dataset.saveGroup ? groups.find(item => item.id === button.dataset.saveGroup) : null;
    if (groups.some(item => item !== group && item.name === name)) { toast('文件夹名称已存在'); return; }
    if (group) group.name = name; else groups.push({id:crypto.randomUUID(), name, collapsed:false});
    byId('modal').close(); scheduleSave(); renderLibrary();
  }
  if (button.dataset.deleteGroup) {
    const group = groups.find(item => item.id === button.dataset.deleteGroup);
    if (!confirm(translate('删除文件夹并将其中素材移至未分组？'))) return;
    clips.forEach(clip => { if (clip.groupId === group.id) clip.groupId = ''; });
    groups.splice(groups.indexOf(group), 1); closeFloatingMenu(); scheduleSave(); renderLibrary();
  }
  if (button.dataset.page !== undefined) {
    if (+button.dataset.page === tasksPageIndex) openTasks();
    else { page = +button.dataset.page; render(); byId('workspace').scrollTop = 0; }
    byId('navigation').querySelector('[aria-current]').focus();
  }
  if (button.dataset.clip) {
    active = clips.find(clip => clip.id === +button.dataset.clip); render(); scheduleSave();
    if (active.track && active.mediaId && active.status === '已就绪') selectPlaybackTrack(active);
  }
  if (button.dataset.retry) { retryTarget = clips.find(clip => clip.id === +button.dataset.retry); byId('files').click(); }
  if (button.dataset.probe) { const clip = clips.find(clip => clip.id === +button.dataset.probe); inspectClip(clip).catch(error => { clip.status = '分析失败'; clip.error = error.message; scheduleSave(); render(); }); }
  if (button.dataset.cancel) {
    const id = +button.dataset.cancel, ticket = importTickets.get(id), xhr = uploads.get(id);
    if (ticket) ticket.cancelled = true;
    if (xhr) xhr.abort();
    else { const clip = clips.find(item => item.id === id); clip.status = '已中断'; clip.error = '已取消'; scheduleSave(); render(); renderQueue(); }
  }
  if (button.dataset.legacy !== undefined) {
    const source = byId('modal').legacyProjects[+button.dataset.legacy];
    button.disabled = true; button.textContent = '正在复制…';
    api('copy-legacy', {source:source.source,id:source.id,studio_id:studioId}).then(project => {
      const models = {base:'Base',medium:'Medium.en',turbo:'Large-v3-turbo'};
      const languages = {en:'英语',zh:'中文'};
      const clip = {id:++serial,mediaId:project.id,batch:++batchSerial,name:project.name,bytes:source.size,
        cursor:0,row:0,track:project.audio_track || 0,selected:true,rows:project.rows?.length ? project.rows : (project.original || []).map(row => ({...row})),original:project.original || [],
        overrides:{model:models[project.model] || 'Base',language:languages[project.language] || '自动检测'},
        status:project.media_available ? '分析中' : '缺失'};
      clips.push(clip); active = clip; byId('modal').close(); scheduleSave(); render();
      if (project.media_available) inspectClip(clip).catch(error => { clip.status='分析失败'; clip.error=error.message; scheduleSave(); render(); });
    }).catch(error => { button.disabled = false; button.textContent = '复制到开发版'; toast(error.message); });
  }
  if (button.dataset.segment !== undefined) {
    active.row = +button.dataset.segment;
    const video = byId('player');
    active.cursor = active.rows[active.row].start;
    if (video) { video.currentTime = active.cursor; video.play().catch(() => toast('此媒体暂时无法播放')); }
    byId('workspace').querySelectorAll('[data-row]').forEach(row => row.classList.toggle('active', +row.dataset.row === active.row));
    subtitleTimeline?.showRow(active.row);
  }
  if (button.dataset.job !== undefined) {
    const job = queue[+button.dataset.job];
    job.state = job.state === '排队' ? '已取消' : '排队';
    renderQueue();
  }
  const action = button.dataset.action;
  if (action === 'codec-change') { openCodecPicker(button); return; }
  if (action === 'insert-subtitle') showInsertSubtitle();
  if (action === 'import-srt' && active !== emptyClip) {
    const clip = active;
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.srt';
    picker.onchange = () => importSrt(picker.files[0], clip);
    picker.click();
  }
  if (action === 'apply-subtitle') {
    const mode = effective(active).subtitleMode;
    selectedClips().forEach(clip => { clip.overrides.subtitleMode = mode; });
    scheduleSave(); render(); toast('已应用字幕方式至选中素材');
  }
  if (action === 'choose-output') {
    chooseNativeDirectory().then(async path => { if (path) {
      exportConfig.destination = path; exportSpace = null; exportDirectoryError = ''; scheduleSave();
      await checkDeliveryDirectory();
      if (page === 4) render();
    } }).catch(() => toast('请选择本机输出目录'));
  }
  if (action === 'start-exports') {
    if (exportSubmitting) return;
    exportSubmitting = true;
    button.disabled = true;
    (async () => {
      try {
        const plans = currentDeliveryPlans().filter(plan => !plan.issues.length);
        if (!plans.length || !(await checkDeliveryDirectory())) return;
        for (const {clip,payload} of plans) {
          try { await api('export-submit',payload); }
          catch (error) { queue.push({name:clip.name,stage:'提交导出',state:'失败',message:error.message}); }
        }
        repairDelivery = null;
        await refreshExportJobs();
        openTasks();
      } finally {
        exportSubmitting = false;
        refreshDeliveryConfirmation();
      }
    })();
  }
  if (action === 'cancel-repair') { repairDelivery = null; refreshDeliveryConfirmation(); }
  if (action === 'subtitle-search') showSubtitleSearch();
  if (action === 'replace-subtitles') replaceSubtitleMatches();
  if (action === 'project-list') showStudioList().catch(error=>toast(error.message));
  if (action === 'project-create') showStudioForm('create');
  if (action === 'project-save-form') {
    button.disabled = true;
    saveStudioForm().catch(error=>toast(error.message)).finally(()=>{button.disabled=false;});
  }
  if (action === 'project-choose-location') {
    const opened = studioForm;
    chooseNativeDirectory().then(directory=>{
      if (directory && studioForm === opened && byId('studio-form-path')) {
        opened.directory = directory;
        byId('studio-form-path').value = directory;
      }
    }).catch(error=>toast(error.message));
  }
  if (action === 'project-restore') {
    const picker = document.createElement('input');
    picker.type='file';picker.accept='.lpsproject';
    picker.onchange = async () => {
      if (!picker.files.length) return;
      button.disabled=true;
      try {
        await flushStudio();
        const reply=await fetch('/api/studio-restore',{method:'POST',headers:{'X-Workbench-Token':token},body:picker.files[0]});
        const data=await reply.json();
        if (!reply.ok) throw Error(data.error || '打开项目包失败');
        window.location.assign('/?studio='+encodeURIComponent(data.id));
      } catch (error) { button.disabled=false;toast(error.message); }
    };
    picker.click();
  }
  if (action === 'delivery-presets') api('delivery-presets').then(items=>{deliveryPresets=items;showDeliveryPresets();}).catch(error=>toast(error.message));
  if (action === 'new-delivery-preset') showSavePreset();
  if (action === 'close-secondary') byId('modal').close();
  if (action === 'save-delivery-preset') {
    const name=value('delivery-preset-name').trim();
    if (!name) { toast('请输入预设名称。');return; }
    if (deliveryPresets.some(item=>item.name===name) && !confirm(translate('覆盖同名预设？'))) return;
    api('delivery-presets',{action:'save',name,value:currentPresetValue()})
      .then(items=>{deliveryPresets=items;byId('modal').close();showDeliveryPresets();}).catch(error=>toast(error.message));
  }
  if (action === 'import') byId('files').click();
  if (action === 'play') togglePlayback();
  if (action === 'preview-captions') {
    if (hiddenPreviewCaptions.has(active.id)) hiddenPreviewCaptions.delete(active.id);
    else hiddenPreviewCaptions.add(active.id);
    button.setAttribute('aria-pressed', String(!hiddenPreviewCaptions.has(active.id)));
    updatePreviewCaption();
  }
  if (action === 'reset-caption-position' && active !== emptyClip) {
    active.overrides.captionPosition = null;
    updatePreviewCaption();
    scheduleSave();
  }
  if (action === 'inherit') {
    const keys = page === 1 ? transcodeKeys :
      page === 2 ? colorKeys : ['delivery','destination'];
    for (const key of keys) delete active.overrides[key];
    scheduleSave();
    render();
  }
  if (action === 'apply') {
    const keys = page === 1 ? transcodeKeys :
      page === 2 ? colorKeys : ['delivery','destination'];
    for (const clip of selectedClips()) for (const key of keys) delete clip.overrides[key];
    scheduleSave();
    render();
    toast('所选素材已应用此页的批次默认设置');
  }
  if (action === 'original') modal('原始识别稿', '<div class="library-scroll">'+transcriptList(active.original || [])+'</div>'+modalDone());
  if (action === 'candidate') {
    const row = active.rows[active.row];
    if (row) {
      modal('局部重识别与候选比较', '<div id="candidate-review" class="review-library"><div class="library-scroll stack"><div class="split equal">' +
        panel('当前稿件', '<p data-verbatim>' + escapeHtml(row.text) + '</p>') +
        panel('识别候选', '<p data-verbatim data-candidate-text></p>') +
        '</div><p class="notice">重新识别不会覆盖当前稿件，采纳后才会替换。</p>' +
        '<div class="candidate-progress"><progress hidden aria-label="识别进度"></progress><span role="status" data-candidate-status></span></div>' +
        '</div><div class="secondary-footer"><button data-action="rerun">重新识别本句</button><div class="toolbar"><button data-action="keep">保留当前版本</button><button class="primary" data-action="accept">采用候选</button></div></div></div>');
      candidateReview = {clip:active, row, index:active.row, node:byId('candidate-review')};
      updateCandidateReview();
    }
  }
  if (action === 'rerun') {
    if (!candidateReview) return;
    const {clip, row, index} = candidateReview;
    const interval = [row.start, row.end];
    interval.row = index;
    recognizeClip(clip, interval);
  }
  if (action === 'review-full') modal('新识别稿（待确认）',
    '<div class="library-scroll stack"><div class="split equal">'+panel('当前校对稿',transcriptList(active.rows))+panel('新识别稿',transcriptList(active.pendingResult))+'</div><p class="notice">采纳将替换当前校对稿，请先确认。</p></div>' +
    '<div class="secondary-footer end"><button data-action="keep">保留当前稿</button><button class="primary" data-action="accept-full">采纳新稿</button></div>');
  if (action === 'accept-full') {
    if (!active.pendingResult) return;
    active.rows = active.pendingResult.map(row => ({...row, speaker:row.speaker || '', confirmed:false}));
    delete active.candidate;
    delete active.pendingResult; active.row = 0; byId('modal').close(); scheduleSave(); render();
  }
  if (action === 'keep') byId('modal').close();
  if (action === 'accept') {
    if (!candidateReview) return;
    const {clip, row, index} = candidateReview;
    const text = localRecognitionJobs.get(row)?.candidate || (clip.candidate?.row === index ? clip.candidate.text : '');
    if (!text || clip.rows[index] !== row) return;
    row.text = text;
    row.confirmed = false;
    localRecognitionJobs.delete(row);
    if (clip.candidate?.row === index) delete clip.candidate;
    byId('modal').close();
    scheduleSave();
    render();
  }
  if (action === 'enqueue') {
    selectedClips().forEach(clip => queue.push({name:clip.name, stage:effective(clip).delivery, state:'排队'}));
    renderQueue();
    openTasks();
  }
  if (action === 'transcribe-demo') {
    queue.push({name:active.name, stage:'字幕识别 · ' + effective(active).model, state:'排队'});
    renderQueue();
    openTasks();
  }
  if (action === 'transcribe-real') {
    if (active.rows.length && !confirm('已有校对稿。新识别结果将保留为候选，不会覆盖当前稿件。继续吗？')) return;
    recognizeClip(active, null); openTasks();
  }
  if (action === 'srt' || action === 'txt') download(action === 'srt');
});

const resizer = byId('library-resize');
function setRail(width) {
  document.documentElement.style.setProperty('--rail', Math.max(180, Math.min(380, width)) + 'px');
}
resizer.onpointerdown = event => resizer.setPointerCapture(event.pointerId);
resizer.onpointermove = event => { if (resizer.hasPointerCapture(event.pointerId)) setRail(event.clientX); };
resizer.onkeydown = event => {
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  setRail(byId('media-list').closest('aside').offsetWidth + (event.key === 'ArrowRight' ? 12 : -12));
};
byId('locale').onclick = () => {
  changeLocale(interfaceLocale === 'zh' ? 'en' : 'zh');
  localize(document.body);
  updateThemeButton();
  updateLibraryToggle();
  renderQueue();
  render();
};
changeLocale(interfaceLocale);
localize(document.body);
renderQueue();
render();
refreshExportJobs();
api('recognition-capabilities').then(result => {
  npuRecognitionReady = result.npu === true;
  if (result.platform === 'darwin') isMacPlatform = true;
  if (result.default_caption_font) defaultCaptionFontName = result.default_caption_font;
  if (page === 3) render();
}).catch(() => {});
api('modern-codecs').then(result => { modernCodecs = result; }).catch(() => {});
api('color-presets').then(entries => {
  colorPresets = entries;
  if ([1,2,4].includes(page)) render();
}).catch(() => toast('色彩预设读取失败'));
setInterval(refreshExportJobs, 2500);
refreshSystemUsage();
setInterval(refreshSystemUsage, 2000);
api('studios').then(catalog => {
  const requested = new URLSearchParams(window.location.search).get('studio');
  const available = catalog.items.filter(item=>item.available && !item.trashed);
  const studio = available.find(item=>item.id===(requested || catalog.active)) ||
    available.find(item=>item.id===catalog.active) || available[0];
  studioId = studio?.id || 'none';
  byId('studio-name').textContent = studio ? studioTitle(studio) : translate('未打开项目');
  return api('studio-state?studio='+studioId);
}).then(async state => {
  if (typeof state.reduceMotion === 'boolean') {
    reduceMotion = state.reduceMotion;
    document.body.classList.toggle('reduce-motion', reduceMotion);
  }
  if (previewResolutions.includes(state.previewResolution)) previewResolution = state.previewResolution;
  if (state.themeMode === 'auto' || state.themeMode === 'dark' || state.themeMode === 'light') {
    themeMode = state.themeMode;
  } else if (typeof state.darkMode === 'boolean' && !localStorage.getItem('local-post-theme-mode')) {
    themeMode = 'auto';
  }
  applyTheme();
  serial = Math.max(serial, state.serial || 0);
  batchSerial = state.batchSerial || 0;
  if (state.defaults && typeof state.defaults === 'object') Object.assign(defaults, state.defaults);
  if (state.exportConfig && typeof state.exportConfig === 'object') Object.assign(exportConfig, state.exportConfig);
  groups.push(...(Array.isArray(state.groups) ? state.groups.filter(group => group && typeof group.id === 'string' && typeof group.name === 'string') : []));
  const needsProbe = [];
  for (const stored of state.clips || []) {
    const clip = {...stored, overrides:stored.overrides || {}, rows:stored.rows || [], original:stored.original || []};
    try {
      const project = await api('open', {id:clip.mediaId});
      if (project.media_available) {
        clip.url = mediaUrl(clip.mediaId);
        if (!clip.original.length && project.original?.length) {
          clip.original = project.original;
          if (!clip.rows.length) clip.rows = project.original.map(row => ({...row,speaker:row.speaker || '',confirmed:false}));
        }
        if (['排队中','复制中','分析中'].includes(clip.status)) { clip.status = '分析中'; needsProbe.push(clip); }
      } else { clip.status = project.import_state === 'interrupted' ? '已中断' : '缺失'; delete clip.url; }
    } catch (_) { clip.status = '缺失'; delete clip.url; }
    clips.push(clip);
  }
  let recoveredOrphans = false;
  const savedProjects = await api('projects?studio='+studioId);
  for (const entry of savedProjects) {
    if (clips.some(clip => clip.mediaId === entry.id)) continue;
    try {
      const project = await api('open', {id:entry.id});
      const clip = {id:++serial,mediaId:entry.id,batch:++batchSerial,name:project.name,
        bytes:project.expected_size || 0,cursor:0,row:0,track:project.audio_track || 0,selected:true,
        rows:project.rows || [],original:project.original || [],overrides:{},
        status:project.media_available ? '分析中' : '已中断'};
      if (project.media_available) clip.url = mediaUrl(entry.id);
      clips.push(clip); recoveredOrphans = true;
      if (project.media_available) needsProbe.push(clip);
    } catch (_) { /* Keep other project records available even if one is unreadable. */ }
  }
  active = visibleClips().find(clip => clip.id === state.active) || visibleClips()[0] || emptyClip;
  byId('save-state').textContent = state.recovered_from_backup ? '已从上一份备份恢复，请核对最近修改' : '项目已恢复';
  localize(byId('save-state'));
  if (state.recovered_from_backup) toast('项目文件异常，已读取上一份备份；最近修改可能未包含');
  projectReady = true;
  const themeSwitch = byId('dark-mode');
  if (themeSwitch) { themeSwitch.checked = darkMode; themeSwitch.disabled = false; }
  render(); renderQueue(); refreshExportJobs();
  if (recoveredOrphans) { scheduleSave(); toast('已找回上次中断时登记的素材，请核对'); }
  for (const clip of needsProbe) inspectClip(clip).catch(() => { clip.status = '分析失败'; scheduleSave(); renderLibrary(); });
  if (active.track && active.status === '已就绪') selectPlaybackTrack(active);
}).catch(error => { byId('save-state').textContent = '读取项目失败：' + error.message; });
