function tonePeakHint(tone) {
  return tone === 'freeman' ? 'Freeman 曲线的输出峰值须为 48–100 尼特，输入峰值须高于输出且不超过 10000 尼特。' :
    '输入峰值须高于输出峰值，两者均为 1–10000 尼特。';
}

function validTonePeaks(color) {
  return !['simple','luminance','freeman'].includes(color.tone) ||
    ([color.input_peak,color.output_peak].every(value=>Number.isFinite(value) && value >= 1 && value <= 10000) &&
      color.input_peak > color.output_peak && (color.tone !== 'freeman' || color.output_peak >= 48 && color.output_peak <= 100));
}

function colorRequestSettings(settings) {
  const state = colorSelection(settings);
  return {
    direction: settings.colorDirection === 'to_log' ? 'to_log' : 'to_709',
    input_id: state.input_id, output_id: state.output_id, strategy: state.strategy, highlight: state.highlight || 'off',
    tone:state.tone, ootf:state.ootf, white_adapt:state.white_adapt === 'on',
    input_peak:Number(state.input_peak), output_peak:Number(state.output_peak),
    output_range:state.output_range || 'auto', output_matrix:state.output_matrix || 'auto',
    range: {有限:'limited',完整:'full'}[state.range],
    matrix: {'BT.709':'bt709','BT.2020 NCL':'bt2020'}[state.matrix]
  };
}

let colorView = true;
let colorSequence = Date.now() * 1024;
const previewResolutions = ['auto','360','720','1080','source'];
let previewResolution = 'auto';
function bindColorPreview(video, clip, settings, redrawWave, playButton) {
  const canvas = byId('transformed-view'), status = byId('color-preview-status');
  const toggle = byId('color-preview-toggle');
  const quality = byId('color-preview-quality');
  const resolution = byId('color-preview-resolution');
  if (!canvas || !toggle) return;
  const selection = colorRequestSettings(settings);
  const source = colorEndpoint(selection.input_id), target = colorEndpoint(selection.output_id);
  const ready = !!(settings.transform && clip.mediaId && source?.input && target?.output
    && selection.range && selection.matrix && validTonePeaks(selection) && (!source.fixed_output || source.fixed_output === target.id)
    && (selection.direction === 'to_log' ? source.group === 'sdr' && target.group === 'log' : target.group !== 'log'));
  const colorSpace = target?.id === 'p3' ? 'display-p3' : 'srgb';
  const context = canvas.getContext('2d', {colorSpace});
  const events = new AbortController();
  let request = null, scheduled = 0, waitingToPlay = false, autoTier = 'auto', forceSoftware = false;
  const qualityNote = () => translate(previewResolution === 'auto'
    ? '自动预览 · 暂停后查看原分辨率。' : '手动预览 · 最终画质按导出设置处理。');
  quality.textContent = qualityNote();
  resolution.value = previewResolution;
  const note = message => { status.textContent = translate(message); status.hidden = !message; };
  const cancel = () => { clearTimeout(scheduled); request?.abort(); request = null; };
  const drawOriginal = () => { canvas.hidden = true; redrawWave(); };
  const updatePlayButton = () => {
    playButton.textContent = translate(waitingToPlay ? '取消播放' : video.paused ? '播放' : '暂停');
  };
  const play = () => video.play().catch(() => toast('此媒体暂时无法播放'));
  function waitForConvertedPlayback() {
    waitingToPlay = true;
    if (!video.paused) video.pause();
    note('正在读取转换画面');
    updatePlayButton();
    refresh();
  }
  toggle.disabled = !ready;
  const updateToggle = () => {
    toggle.setAttribute('aria-pressed', String(ready && colorView));
    toggle.textContent = translate(ready && colorView ? '转换后' : '原始');
    quality.hidden = !ready || !colorView;
    resolution.disabled = !ready || !colorView;
    const original = byId('color-preview-original');
    if (original) {
      original.setAttribute('aria-pressed', String(!ready || !colorView));
      toggle.textContent = translate('转换后');
    }
  };

  async function stream(fullFrame = false) {
    if (!ready || !colorView || video.seeking || video.readyState < 1) return;
    if (!video.videoWidth) {
      const shouldPlay = waitingToPlay;
      waitingToPlay = false;
      updatePlayButton();
      note('转换预览暂不可用');
      if (shouldPlay) play();
      return;
    }
    cancel();
    const current = new AbortController();
    request = current;
    const duration = video.duration;
    const start = Math.max(0, Math.min(video.currentTime, duration - 0.05));
    const live = waitingToPlay;
    const auto = previewResolution === 'auto';
    const requestedQuality = fullFrame ? 'source' : auto ? autoTier : previewResolution;
    note('正在读取转换画面');
    const hdrDisplay = matchMedia('(dynamic-range: high)').matches;
    const medium = target.group === 'hdr' ? (hdrDisplay
      ? '屏幕环境支持 HDR · 当前为 SDR 映射预览' : 'HDR 输出 · SDR 映射预览') :
      target.id === '2020' ? 'BT.2020 输出 · Rec.709 屏幕预览' : '';
    let completeFrame = false, decoder, lateFrames = 0;
    let reader;
    try {
      const response = await fetch('/api/color-stream', {method:'POST', signal:current.signal,
        headers:{'X-Workbench-Token':token},
        body:JSON.stringify({media_id:clip.mediaId, start, live, sequence:++colorSequence,
          display:[video.videoWidth,video.videoHeight], quality:requestedQuality, software:forceSoftware, color:selection})});
      if (!response.ok) throw Error('color stream failed');
      const width = +response.headers.get('X-Frame-Width'), height = +response.headers.get('X-Frame-Height');
      const fps = +response.headers.get('X-Frame-Rate');
      decoder = response.headers.get('X-Preview-Decoder');
      if (!width || !height || !fps || current.signal.aborted) return;
      const frame = new ImageData(width,height,{colorSpace:context.getContextAttributes().colorSpace});
      const bytes = frame.data;
      reader = response.body.getReader();
      let offset = 0, number = 0;
      while (!current.signal.aborted) {
        const {done,value} = await reader.read();
        if (done) break;
        for (let cursor = 0; cursor < value.length && !current.signal.aborted;) {
          const size = Math.min(value.length-cursor, bytes.length-offset);
          bytes.set(value.subarray(cursor,cursor+size),offset);
          cursor += size;
          offset += size;
          if (offset !== bytes.length) continue;
          const time = start + number++ / fps;
          while (live && time > video.currentTime + .5/fps && !current.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve,12));
          }
          if (current.signal.aborted) return;
          const late = live && completeFrame && time < video.currentTime-.12;
          lateFrames = late ? lateFrames+1 : 0;
          if (lateFrames >= 5 && auto && (width > 640 || height > 640)) {
            autoTier = width > 1280 || height > 1280 || (width > 720 && height > 720) ? '720' : '360';
            if (requestedQuality !== autoTier) {
              waitForConvertedPlayback();
              return;
            }
          }
          if (!completeFrame || !live || time >= video.currentTime-.12) {
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width;
              canvas.height = height;
            }
            context.putImageData(frame,0,0);
            canvas.hidden = false;
            if (!completeFrame) {
              const route = translate(
                decoder === 'videotoolbox' ? 'VideoToolbox 硬解' :
                decoder === 'qsv' ? 'Quick Sync 硬解' : 'CPU 解码'
              );
              quality.textContent = width + '×' + height + ' · ' +
                (live ? fps + ' ' + translate('帧/秒') : translate('暂停画面')) + ' · ' + route + ' · ' + qualityNote();
              completeFrame = true;
            }
            note(medium);
            redrawWave();
            if (waitingToPlay) {
              waitingToPlay = false;
              updatePlayButton();
              await play();
            }
          }
          offset = 0;
        }
      }
      if (!completeFrame && !current.signal.aborted) throw Error('no converted frame');
      if (current.signal.aborted) return;
      if (live && (decoder === 'qsv' || decoder === 'videotoolbox') && start + number / fps < duration - .35 && !video.ended) {
        forceSoftware = true;
        waitForConvertedPlayback();
      } else if (!live && auto && !fullFrame && (width < video.videoWidth || height < video.videoHeight) && video.paused) {
        stream(true);
      }
    } catch (error) {
      if (current.signal.aborted) return;
      if (live && (decoder === 'qsv' || decoder === 'videotoolbox') && !forceSoftware) {
        forceSoftware = true;
        waitForConvertedPlayback();
        return;
      }
      if (fullFrame && !canvas.hidden) { note('原分辨率帧暂不可用'); return; }
      waitingToPlay = false;
      updatePlayButton();
      drawOriginal();
      note('转换预览暂不可用');
    } finally {
      if (reader) reader.cancel().catch(()=>{});
    }
  }
  function refresh() {
    cancel();
    if (ready && colorView) scheduled = setTimeout(() => stream(), 55);
  }
  const bind = (event, handler) => video.addEventListener(event,handler,{signal:events.signal});
  bind('seeking', () => {
    cancel();
    drawOriginal();
    if (ready && colorView && !video.paused) waitForConvertedPlayback();
  });
  for (const event of ['loadeddata','seeked','ended']) bind(event,refresh);
  bind('pause', () => {
    if (waitingToPlay) updatePlayButton();
    else refresh();
  });
  const selectView = converted => {
    if (!ready || colorView === converted) return;
    colorView = converted;
    updateToggle();
    if (colorView && !video.paused) waitForConvertedPlayback();
    else if (colorView) refresh();
    else {
      cancel();
      drawOriginal();
      note('');
      if (waitingToPlay) {
        waitingToPlay = false;
        updatePlayButton();
        play();
      }
    }
  };
  toggle.onclick = () => selectView(true);
  const original = byId('color-preview-original');
  if (original) original.onclick = () => selectView(false);
  resolution.onchange = () => {
    previewResolution = resolution.value;
    autoTier = 'auto';
    quality.textContent = qualityNote();
    scheduleSave();
    if (!video.paused) waitForConvertedPlayback();
    else refresh();
  };
  updateToggle();
  if (settings.transform && !ready) note('确认输入和输出色彩参数后预览');
  else if (ready && colorView && !video.paused) waitForConvertedPlayback();
  else refresh();
  return {
    stop() { events.abort(); cancel(); },
    togglePlayback() {
      if (!video.paused) video.pause();
      else if (waitingToPlay) {
        waitingToPlay = false;
        updatePlayButton();
        refresh();
      } else if (ready && colorView) {
        if (video.ended) video.currentTime = 0;
        waitForConvertedPlayback();
      } else play();
    }
  };
}
