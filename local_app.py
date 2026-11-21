import json
import faulthandler
import math
import os
import queue
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
import mimetypes
import re
from tempfile import TemporaryDirectory
from zipfile import ZipFile
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from platform_mac import (
    IS_MAC, bootstrap_pydeps, caption_font_names, data_root,
    default_caption_font, find_ffmpeg, subprocess_kwargs, system_usage,
)
bootstrap_pydeps(ROOT)

from transcode_jobs import ExportQueue
from color_presets import install_vendor_lut, public_presets
from workspace_previews import WorkspacePreviews
from npu_asr import recognize_npu, runtime_ready

WORK = data_root(ROOT)
UI = ROOT / '界面'
sys.path.insert(0, str(WORK / 'speech_tools'))
sys.path.insert(0, str(ROOT / 'work/speech_tools'))
MODELS = {'base': 'base', 'medium': 'medium-en', 'turbo': 'turbo'}
TOKEN = secrets.token_urlsafe(32)
recognition_lock = threading.Lock()
project_lock = threading.RLock()
PROJECTS = WORK / 'projects'
STUDIO_STATE = WORK / 'studio-project.json'
STUDIOS = WORK / 'studios'
STUDIO_CATALOG = WORK / 'studio-catalog'
MEDIA_LOCATIONS = WORK / 'media-locations'
RECENT_STUDIO = WORK / 'recent-studio.txt'
DELIVERY_PRESETS = WORK / 'delivery-presets.json'
LEGACY_ROOTS = {
    'work': ROOT.parent.parent / 'work/projects',
    'packaged': ROOT.parent.parent / 'outputs/采访工作台-项目保存版/work/projects',
}
copy_slots = threading.Semaphore(1)
probe_slots = threading.Semaphore(2)


def valid_id(identifier):
    return isinstance(identifier,str) and len(identifier) == 32 and all(c in '0123456789abcdef' for c in identifier)


def catalog_path(identifier):
    if identifier != 'default' and not valid_id(identifier):
        raise ValueError('项目编号无效。')
    return STUDIO_CATALOG / (identifier+'.json')


def read_catalog(identifier):
    path = catalog_path(identifier)
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}


def write_catalog(identifier, record):
    STUDIO_CATALOG.mkdir(exist_ok=True)
    temporary = STUDIO_CATALOG / (secrets.token_hex(8)+'.tmp')
    try:
        temporary.write_text(json.dumps(record,ensure_ascii=False),encoding='utf-8')
        temporary.replace(catalog_path(identifier))
    finally:
        temporary.unlink(missing_ok=True)


def studio_path(identifier):
    directory = read_catalog(identifier).get('directory')
    if directory:
        return Path(directory) / 'studio-project.json'
    if identifier == 'default':
        return STUDIO_STATE
    return STUDIOS / (identifier + '.json')


def load_studio(path):
    if not path.exists() and not path.with_suffix('.bak').exists():
        if path == STUDIO_STATE:
            return {'version':1,'clips':[],'active':None}
        raise ValueError('项目不存在。')
    for candidate in (path,path.with_suffix('.bak')):
        try:
            state = json.loads(candidate.read_text(encoding='utf-8'))
            if state.get('version') == 1 and isinstance(state.get('clips'),list):
                if candidate != path:
                    state['recovered_from_backup'] = True
                return state
        except (OSError,ValueError,AttributeError):
            continue
    raise ValueError('项目与备份都无法读取。')


def studio_inventory():
    ids = {'default'} | {p.stem for p in STUDIOS.glob('*.json')} | {p.stem for p in STUDIO_CATALOG.glob('*.json')}
    items = []
    for identifier in ids:
        try:
            record = read_catalog(identifier)
            state_path = studio_path(identifier)
        except (OSError,ValueError):
            continue
        entry = {'id':identifier,'name':record.get('name') or ('原工作台' if identifier == 'default' else '未命名项目'),
                 'directory':str(state_path.parent),'trashed':bool(record.get('trashed')),
                 'updated':0,'count':0,'bytes':0,'cover':None,'available':False}
        try:
            state = load_studio(state_path)
            entry['available'] = True
            entry['name'] = record.get('name') or state.get('studio_name') or entry['name']
            state_file = state_path if state_path.is_file() else state_path.with_suffix('.bak')
            entry['updated'] = max(state_file.stat().st_mtime if state_file.is_file() else 0,record.get('renamed_at',0))
            entry['count'] = sum(not clip.get('removed') for clip in state['clips'])
            seen = set()
            for clip in state['clips']:
                media_id = clip.get('mediaId')
                if not valid_id(media_id) or media_id in seen:
                    continue
                seen.add(media_id)
                try:
                    media = project_dir(media_id) / 'media'
                    size = media.stat().st_size
                except OSError:
                    continue
                entry['bytes'] += size
                if not entry['cover'] and not clip.get('removed') and (
                    (clip.get('sourceInfo') or {}).get('video') or clip.get('resolution')
                    or media.with_name('thumbnail.jpg').is_file()
                ):
                    entry['cover'] = media_id
        except (OSError,ValueError,TypeError,AttributeError):
            pass
        items.append(entry)
    return sorted(items,key=lambda item:(item['updated'],item['id']),reverse=True)


def recent_studio(items=None):
    items = studio_inventory() if items is None else items
    available = [item['id'] for item in items if item['available'] and not item['trashed']]
    try:
        result = RECENT_STUDIO.read_text(encoding='ascii').strip()
        if result in available:
            return result
    except OSError:
        pass
    return available[0] if available else 'none'


def select_studio(identifier):
    temp = RECENT_STUDIO.with_suffix('.tmp')
    temp.write_text(identifier,encoding='ascii')
    temp.replace(RECENT_STUDIO)


def create_studio(name, directory=None):
    identifier = secrets.token_hex(16)
    initial = {'version':1,'clips':[],'active':None,'studio_name':name}
    if directory is None:
        STUDIOS.mkdir(exist_ok=True)
        with studio_path(identifier).open('x',encoding='utf-8') as stream:
            json.dump(initial,stream,ensure_ascii=False)
        return identifier
    parent = Path(directory)
    if not parent.is_absolute() or not parent.is_dir():
        raise ValueError('请选择有效的项目位置。')
    basename = re.sub(r'[\\/:*?"<>|\x00-\x1f]','_',name).strip(' .') or '项目'
    if re.fullmatch(r'CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]',basename.split('.')[0],re.I):
        basename = '项目-' + basename
    folder = parent.resolve() / basename
    if folder.exists():
        raise ValueError('这个位置已有同名文件夹，请改名或换一个位置。')
    folder.mkdir()
    state = folder/'studio-project.json'
    try:
        state.write_text(json.dumps(initial,ensure_ascii=False),encoding='utf-8')
        write_catalog(identifier,{'name':name,'directory':str(folder)})
    except OSError:
        state.unlink(missing_ok=True)
        folder.rmdir()
        raise
    return identifier


def delivery_presets():
    if not DELIVERY_PRESETS.exists():
        return []
    presets = json.loads(DELIVERY_PRESETS.read_text(encoding='utf-8'))
    if not isinstance(presets,list):
        raise ValueError('预设列表无法读取。')
    return presets


def package_studio(state, directory, include_media):
    destination = Path(directory)
    if not destination.is_absolute() or not destination.is_dir():
        raise ValueError('请选择项目备份目录。')
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]','_',state.get('studio_name') or '原工作台').strip(' .') or '项目'
    path = destination / f'{name}-{secrets.token_hex(4)}.lpsproject'
    temporary = path.with_suffix('.partial')
    try:
        with ZipFile(temporary,'x') as out:
            out.writestr('studio.json',json.dumps(state,ensure_ascii=False))
            if include_media:
                for identifier in {clip.get('mediaId') for clip in state['clips']} - {None}:
                    source = project_dir(identifier)/'media'
                    if source.is_file():
                        out.write(source,'media/'+identifier)
        temporary.rename(path)
        return str(path)
    finally:
        temporary.unlink(missing_ok=True)


def restore_studio(stream, length):
    from zipfile import BadZipFile
    STUDIOS.mkdir(exist_ok=True)
    identifier = secrets.token_hex(16)
    created = []
    with TemporaryDirectory(prefix='studio-transfer-', dir=WORK) as folder:
        staging = Path(folder)
        bundle = staging/'incoming'
        try:
            with bundle.open('xb') as file:
                remaining = length
                while remaining:
                    block = stream.read(min(1<<20,remaining))
                    if not block:
                        raise ValueError('项目包接收中断。')
                    remaining -= len(block)
                    file.write(block)
            with ZipFile(bundle) as archive:
                if archive.getinfo('studio.json').file_size > 20 * 1024**2:
                    raise ValueError('项目包状态文件过大。')
                state = json.loads(archive.read('studio.json'))
                if state.get('version') != 1 or not isinstance(state.get('clips'),list):
                    raise ValueError('项目包状态格式无效。')
                paths = set(archive.namelist())
                assets = {}
                for clip in state['clips']:
                    old = clip.get('mediaId')
                    if old:
                        project_dir(old)
                        key = 'media/'+old
                        if key in paths:
                            assets[old] = archive.getinfo(key).file_size
                if shutil.disk_usage(PROJECTS).free < sum(assets.values()):
                    raise ValueError('空间不足，无法恢复项目媒体。')
                mapped = {}
                for clip in state['clips']:
                    old = clip.get('mediaId')
                    if old and old in mapped:
                        clip['mediaId'] = mapped[old]
                        continue
                    media_id = secrets.token_hex(16)
                    folder = staging/media_id
                    folder.mkdir()
                    if old in assets:
                        with archive.open('media/'+old) as src, (folder/'media').open('xb') as out:
                            shutil.copyfileobj(src,out,1<<20)
                    project = {'id':media_id,'version':1,'studio_id':identifier,
                               'name':str(clip.get('name','未命名媒体'))[:255],
                               'expected_size':assets.get(old,clip.get('bytes') or 0),
                               'rows':clip.get('rows',[]),'original':clip.get('original',[]),
                               'audio_track':clip.get('track',0),'updated':time.time(),
                               'import_state':'ready' if old in assets else 'missing'}
                    (folder/'project.json').write_text(json.dumps(project,ensure_ascii=False),encoding='utf-8')
                    if old:
                        mapped[old] = media_id
                    clip['mediaId'] = media_id
                    clip['status'] = '已就绪' if old in assets else '缺失'
                    created.append(media_id)
            state['studio_name'] = (str(state.get('studio_name') or '原工作台')[:72] + '（恢复）')
            state.pop('recovered_from_backup',None)
            if isinstance(state.get('exportConfig'),dict):
                state['exportConfig']['destination'] = ''
            with project_lock:
                moved = []
                metadata = studio_path(identifier)
                try:
                    for media_id in created:
                        destination = project_dir(media_id)
                        (staging/media_id).rename(destination)
                        moved.append(destination)
                    (staging/'studio.json').write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
                    (staging/'studio.json').rename(metadata)
                    select_studio(identifier)
                except OSError:
                    metadata.unlink(missing_ok=True)
                    for destination in moved:
                        (destination/'media').unlink(missing_ok=True)
                        (destination/'project.json').unlink(missing_ok=True)
                        destination.rmdir()
                    raise
        except (BadZipFile,KeyError,AttributeError,TypeError) as exc:
            raise ValueError('无法读取此项目包。') from exc
    return identifier


thumbnail_slots = threading.Semaphore(1)
compute_lock = threading.Lock()
export_queue = None


def project_dir(identifier):
    if not valid_id(identifier):
        raise ValueError('项目编号无效。')
    link = MEDIA_LOCATIONS / (identifier+'.txt')
    if link.is_file():
        path = Path(link.read_text(encoding='utf-8'))
        if not path.is_absolute() or path.name != identifier:
            raise ValueError('媒体副本位置无效。')
        return path
    return PROJECTS / identifier


def media_parent(studio_id):
    directory = read_catalog(studio_id).get('directory')
    if directory:
        parent = Path(directory)
        if not parent.is_dir():
            raise ValueError('项目位置暂不可用。')
        folder = parent/'media'
        folder.mkdir(exist_ok=True)
        return folder
    return PROJECTS


def assign_media_location(identifier, parent):
    folder = parent/identifier
    if parent != PROJECTS:
        MEDIA_LOCATIONS.mkdir(exist_ok=True)
        with (MEDIA_LOCATIONS / (identifier+'.txt')).open('x',encoding='utf-8') as link:
            link.write(str(folder))
    return folder


def read_project(identifier):
    directory = project_dir(identifier)
    with (directory / 'project.json').open(encoding='utf-8') as file:
        project = json.load(file)
    if project.get('id') != identifier or project.get('version') != 1:
        raise ValueError('项目文件格式无法识别。')
    return project


def write_project(project):
    directory = project_dir(project['id'])
    target = directory / 'project.json'
    temporary = directory / ('project-' + secrets.token_hex(8) + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as output:
            json.dump(project, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def store_recognition(identifier, selected, language, interval, result, audio_track=0):
    directory = project_dir(identifier) / 'recognitions'
    directory.mkdir(exist_ok=True)
    filename = secrets.token_hex(16) + '.json'
    record = {'model': selected, 'language_requested': language, 'interval': interval, 'audio_track': audio_track,
              'result': result}
    with (directory / filename).open('x', encoding='utf-8') as output:
        json.dump(record, output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())


def probe_media(source):
    with probe_slots:
        result = subprocess.run(
            [sys.executable, '-I', '-B', '-u', '-X', 'utf8', __file__, '--probe-worker'],
            input=str(source), capture_output=True, text=True, encoding='utf-8',
            timeout=30, **subprocess_kwargs())
    if result.returncode:
        raise ValueError('无法读取媒体信息，请检查文件是否完整。')
    return json.loads(result.stdout)


def find_whisper_model(selected):
    name = MODELS[selected]
    for base in (WORK / 'models' / name, ROOT / 'work/models' / name):
        if (base / 'tokenizer.json').is_file():
            return base
    return None


def recognize(source, selected, language, interval, progress=lambda message: None, audio_track=0, backend='cpu'):
    faulthandler.dump_traceback_later(15)
    try:
        progress('正在加载 NumPy…')
        import numpy as np
        if backend == 'cpu':
            progress('正在加载 faster-whisper…')
            from faster_whisper import WhisperModel
    finally:
        faulthandler.cancel_dump_traceback_later()

    command = [find_ffmpeg(ROOT, 'ffmpeg'), '-v', 'error', '-nostdin', '-threads', '2']
    if interval:
        start, end = interval
        command += ['-ss', str(start)]
    command += ['-i', str(source)]
    if interval:
        command += ['-t', str(end - start)]
    command += ['-map', f'0:a:{audio_track}', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']
    extract_started = time.perf_counter()
    progress('正在提取音轨…')
    audio = subprocess.run(command, capture_output=True, timeout=300, **subprocess_kwargs())
    if audio.returncode or not audio.stdout:
        raise ValueError('无法读取音轨，或所选时间段没有音频。')
    samples = np.frombuffer(audio.stdout, dtype='<f4')
    offset = interval[0] if interval else 0
    extract_seconds = time.perf_counter() - extract_started
    if backend == 'npu':
        if selected != 'base':
            raise ValueError('NPU 实验仅支持 Whisper Base。')
        result = recognize_npu(ROOT, samples, language, offset, progress)
        result['timings']['extract_seconds'] = extract_seconds
        return result
    progress('正在准备模型…')
    path = find_whisper_model(selected)
    if path is None:
        raise ValueError(f'本地模型未就绪，请先运行「下载Whisper模型.command」或将模型放到 {WORK / "models" / MODELS[selected]}。')
    started = time.perf_counter()
    model = WhisperModel(str(path), device='cpu', compute_type='int8',
                         local_files_only=True, cpu_threads=max(1, min(6, (os.cpu_count() or 2) - 1)))
    load_seconds = time.perf_counter()-started
    started = time.perf_counter()
    progress('正在检测语音和识别语言…')
    segments, info = model.transcribe(
        samples, language='en' if selected == 'medium' else language,
        beam_size=5, condition_on_previous_text=False, vad_filter=interval is None)
    progress('正在识别音频…')
    rows = []
    for segment in segments:
        if segment.text.strip() and segment.end > segment.start:
            rows.append({'start': segment.start + offset, 'end': segment.end + offset,
                         'text': segment.text.strip()})
            progress(f'正在识别音频，已生成 {len(rows)} 段文字…')
    return {'language': info.language, 'rows': rows, 'backend':'cpu',
            'timings':{'load_seconds':load_seconds, 'inference_seconds':time.perf_counter()-started,
                       'extract_seconds':extract_seconds}}


def run_worker(source, selected, language, interval, send_event, audio_track=0, backend='cpu'):
    if not recognition_lock.acquire(blocking=False):
        send_event({'error': '已有识别任务正在运行，请等待完成。'})
        return
    try:
        env = dict(os.environ, OPENBLAS_NUM_THREADS='1', HF_HUB_OFFLINE='1')
        arguments = json.dumps([str(source), selected, language, interval, audio_track, backend])
        # Pass JSON via stdin so Windows command-line quoting never alters paths.
        with (WORK / 'recognition.log').open('wb') as diagnostics:
            worker = subprocess.Popen(
                [sys.executable, '-I', '-B', '-u', '-X', 'utf8', __file__, '--recognition-worker'],
                env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=diagnostics,
                text=True, encoding='utf-8', **subprocess_kwargs())
            try:
                worker.stdin.write(arguments)
                worker.stdin.close()
                events = queue.Queue()

                def read_events():
                    try:
                        for line in worker.stdout:
                            events.put(line)
                    finally:
                        events.put(None)

                threading.Thread(target=read_events, daemon=True).start()
                stage = '启动识别进程'
                timeout = 30
                while True:
                    try:
                        line = events.get(timeout=timeout)
                    except queue.Empty:
                        send_event({'error': f'{stage}超时。诊断记录位于 work/recognition.log。'})
                        return
                    if line is None:
                        send_event({'error': '识别进程意外退出。诊断记录位于 work/recognition.log。'})
                        return
                    event = json.loads(line)
                    if 'progress' in event:
                        stage = event['progress'].rstrip('…')
                        if '提取音轨' in stage:
                            timeout = 310
                        elif '模型' in stage or '语音' in stage or '识别音频' in stage:
                            timeout = 300
                    send_event(event)
                    if 'result' in event or 'error' in event:
                        return
            finally:
                try:
                    worker.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait()
                worker.stdout.close()
    finally:
        recognition_lock.release()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def allowed(self):
        return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

    def reply(self, body, kind='application/json; charset=utf-8', status=200):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def json_reply(self, value, status=200):
        self.reply(json.dumps(value, ensure_ascii=False).encode(), status=status)

    def do_GET(self):
        if not self.allowed():
            self.send_error(403)
            return
        parsed = urlsplit(self.path)
        if parsed.path == '/api/delivery-presets':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            with project_lock:
                try:
                    self.json_reply(delivery_presets())
                except (ValueError,OSError) as exc:
                    self.json_reply({'error':str(exc)},500)
            return
        if parsed.path == '/api/studios':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            with project_lock:
                items = studio_inventory()
                self.json_reply({'active':recent_studio(items),'items':items})
            return
        if parsed.path == '/api/recognition-capabilities':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            self.json_reply({
                'npu': runtime_ready(ROOT),
                'platform': sys.platform,
                'default_caption_font': default_caption_font(),
                'models': {key: find_whisper_model(key) is not None for key in MODELS},
            })
            return
        if parsed.path == '/api/caption-fonts':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            try:
                self.json_reply(caption_font_names())
            except (OSError, subprocess.SubprocessError, UnicodeError):
                self.json_reply({'error':'无法读取本机字体。'}, 500)
            return
        if parsed.path == '/api/color-presets':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            self.json_reply(list(public_presets()))
            return
        if parsed.path == '/api/system-usage':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            self.json_reply(system_usage())
            return
        if parsed.path == '/api/modern-codecs':
            self.json_reply(export_queue.modern_codecs())
            return
        if parsed.path == '/api/export-jobs':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403); return
            try:
                studio_id = parse_qs(parsed.query).get('studio',[None])[0]
                self.json_reply([job for job in export_queue.list() if studio_id is None or job.get('studio_id','default') == studio_id])
            except ValueError as exc:
                self.json_reply({'error': str(exc)}, 500)
            return
        if parsed.path == '/api/export-subtitles':
            query = parse_qs(parsed.query)
            if query.get('token') != [TOKEN]:
                self.send_error(403)
                return
            try:
                source = export_queue.output(query['id'][0])
                result = subprocess.run([
                    find_ffmpeg(ROOT, 'ffmpeg'), '-v', 'error', '-nostdin',
                    '-i', str(source), '-map', '0:s:0', '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1',
                ], capture_output=True, timeout=20, **subprocess_kwargs())
                if result.returncode or not result.stdout.startswith(b'WEBVTT'):
                    self.send_error(422, 'Cannot read embedded subtitles')
                    return
            except (KeyError, IndexError, ValueError, OSError, subprocess.TimeoutExpired):
                self.send_error(404, 'Export subtitles unavailable')
                return
            self.reply(result.stdout, 'text/vtt; charset=utf-8')
            return
        if parsed.path in ('/api/export-media', '/api/preview-media'):
            query = parse_qs(parsed.query)
            if query.get('token') != [TOKEN]:
                self.send_error(403); return
            try:
                identifier = query['id'][0]
                if parsed.path == '/api/export-media':
                    source = export_queue.output(identifier)
                else:
                    source = export_queue.preview_path(identifier, query['side'][0])
                size = source.stat().st_size
                start, end = 0, size - 1
                header = self.headers.get('Range')
                if header:
                    import re
                    match = re.fullmatch(r'bytes=(\d+)-(\d*)', header)
                    if not match: self.send_error(416); return
                    start = int(match.group(1))
                    end = min(int(match.group(2)), end) if match.group(2) else end
                    if start > end: self.send_error(416); return
                self.send_response(206 if header else 200)
                mime = {'.mov':'video/quicktime', '.mp4':'video/mp4', '.mkv':'video/x-matroska',
                        '.webm':'video/webm', '.mxf':'application/mxf'}
                self.send_header('Content-Type', mime.get(source.suffix.lower(), 'application/octet-stream'))
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Length', str(end - start + 1))
                if header: self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.end_headers()
                with source.open('rb') as file:
                    file.seek(start)
                    remaining = end - start + 1
                    while remaining:
                        chunk = file.read(min(1024 * 1024, remaining))
                        if not chunk: break
                        self.wfile.write(chunk); remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (IndexError, KeyError, OSError, ValueError):
                self.send_error(404)
            return
        if parsed.path == '/api/thumbnail':
            query = parse_qs(parsed.query)
            if query.get('token') != [TOKEN]:
                self.send_error(403)
                return
            try:
                identifier = query['id'][0]
                directory = project_dir(identifier)
                read_project(identifier)
                source = directory / 'media'
                if not source.is_file():
                    raise FileNotFoundError('媒体文件不存在。')
                target = directory / 'thumbnail.jpg'
                with thumbnail_slots:
                    if not target.is_file():
                        result = subprocess.run([
                            find_ffmpeg(ROOT, 'ffmpeg'), '-v', 'error', '-nostdin',
                            '-threads', '1', '-i', str(source), '-map', '0:v:0',
                            '-frames:v', '1', '-vf', 'scale=480:-2', '-threads', '1',
                            '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
                        ], capture_output=True, timeout=30, **subprocess_kwargs())
                        if result.returncode or not result.stdout or len(result.stdout) > 4 * 1024 * 1024:
                            raise ValueError('无法提取缩略图。')
                        temporary = directory / ('thumbnail-' + secrets.token_hex(8) + '.tmp')
                        try:
                            temporary.write_bytes(result.stdout)
                            os.replace(temporary, target)
                        finally:
                            temporary.unlink(missing_ok=True)
                    image = target.read_bytes()
                self.reply(image, 'image/jpeg')
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (IndexError, KeyError, OSError, ValueError, subprocess.TimeoutExpired):
                self.send_error(404)
            return
        if parsed.path == '/api/legacy-projects':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            items = []
            for key, root in LEGACY_ROOTS.items():
                if not root.is_dir():
                    continue
                for directory in root.iterdir():
                    try:
                        if len(directory.name) != 32 or any(c not in '0123456789abcdef' for c in directory.name):
                            continue
                        with (directory / 'project.json').open(encoding='utf-8') as file:
                            project = json.load(file)
                        if project.get('version') == 1 and project.get('id') == directory.name:
                            media = directory / 'media'
                            items.append({'source':key, 'id':directory.name, 'name':project.get('name','未命名'),
                                          'updated':project.get('updated',0), 'size':media.stat().st_size if media.is_file() else 0})
                    except (OSError, ValueError, TypeError):
                        continue
            self.json_reply(sorted(items, key=lambda item: item['updated'], reverse=True))
            return
        if parsed.path == '/api/studio-state':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            with project_lock:
                try:
                    identifier = parse_qs(parsed.query).get('studio',['default'])[0]
                    state = {'version':1,'clips':[],'active':None} if identifier == 'none' else load_studio(studio_path(identifier))
                except ValueError as exc:
                    self.json_reply({'error':str(exc)},400)
                    return
            self.json_reply(state)
            return
        if parsed.path == '/api/projects':
            if self.headers.get('X-Workbench-Token') != TOKEN:
                self.send_error(403)
                return
            projects = []
            studio_id = parse_qs(parsed.query).get('studio',[None])[0]
            media_ids = {folder.name for folder in PROJECTS.iterdir() if folder.is_dir()} | {p.stem for p in MEDIA_LOCATIONS.glob('*.txt')}
            for identifier in media_ids:
                try:
                    project = read_project(identifier)
                    if studio_id is None or project.get('studio_id','default') == studio_id:
                        projects.append({'id': project['id'], 'name': project['name'],
                                         'updated': project.get('updated', 0)})
                except (OSError, ValueError, KeyError):
                    continue
            self.json_reply(sorted(projects, key=lambda item: item['updated'], reverse=True))
            return
        if parsed.path == '/api/media':
            query = parse_qs(parsed.query)
            if query.get('token') != [TOKEN]:
                self.send_error(403)
                return
            try:
                identifier = query['id'][0]
                project = read_project(identifier)
                source = project_dir(identifier) / 'media'
                size = source.stat().st_size
                start, end = 0, size - 1
                header = self.headers.get('Range')
                if header:
                    import re
                    match = re.fullmatch(r'bytes=(\d+)-(\d*)', header)
                    if not match:
                        self.send_error(416)
                        return
                    start = int(match.group(1))
                    end = min(int(match.group(2)), end) if match.group(2) else end
                    if start > end:
                        self.send_error(416)
                        return
                self.send_response(206 if header else 200)
                self.send_header('Content-Type', mimetypes.guess_type(project['name'])[0] or 'application/octet-stream')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Length', str(end - start + 1))
                if header:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.end_headers()
                with source.open('rb') as file:
                    file.seek(start)
                    remaining = end - start + 1
                    while remaining:
                        chunk = file.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (KeyError, IndexError, OSError, ValueError):
                self.send_error(404)
            return
        assets = {'/': ('index.html', 'text/html'), '/studio.css': ('studio.css', 'text/css'),
                  '/studio.js': ('studio.js', 'text/javascript'), '/locale.js': ('locale.js', 'text/javascript'),
                  '/workspace-previews.js': ('workspace-previews.js', 'text/javascript'),
                  '/media-empty.svg': ('media-empty.svg', 'image/svg+xml'),
                  '/review-still.jpg': ('review-still.jpg', 'image/jpeg'),
                  '/review-sample.mp4': ('review-sample.mp4', 'video/mp4')}
        if parsed.path not in assets:
            self.send_error(404)
            return
        name, mime = assets[parsed.path]
        body = (UI / name).read_bytes()
        if parsed.path == '/':
            body = body.replace(b'__LOCAL_TOKEN__', TOKEN.encode())
        self.reply(body, mime + '; charset=utf-8')

    def stream_color(self, data):
        process, first, width, height, fps, decoder = workspace_previews.color(data)
        try:
            size = width * height * 4
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Frame-Width', str(width))
            self.send_header('X-Frame-Height', str(height))
            self.send_header('X-Frame-Rate', str(fps))
            self.send_header('X-Preview-Decoder', decoder)
            self.end_headers()
            self.connection.settimeout(8)
            frame = first
            while len(frame) == size:
                self.wfile.write(frame)
                frame = process.stdout.read(size)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            workspace_previews.release(process)

    def do_POST(self):
        if not self.allowed() or self.headers.get('X-Workbench-Token') != TOKEN:
            self.send_error(403)
            return
        try:
            parsed = urlsplit(self.path)
            length = int(self.headers.get('Content-Length', -1))
            if parsed.path == '/api/delivery-presets':
                if not 0 < length <= 16384:
                    raise ValueError('导出预设无效。')
                data = json.loads(self.rfile.read(length))
                name = str(data.get('name','')).strip()
                if not 1 <= len(name) <= 64:
                    raise ValueError('请输入预设名称。')
                with project_lock:
                    presets = [item for item in delivery_presets() if item.get('name') != name]
                    if data.get('action') == 'save':
                        if len(presets) >= 100 or not isinstance(data.get('value'),dict):
                            raise ValueError('导出预设无效或已达上限。')
                        presets.append({'name':name,'value':data['value']})
                    elif data.get('action') != 'remove':
                        raise ValueError('预设操作无效。')
                    temp = DELIVERY_PRESETS.with_suffix('.tmp')
                    temp.write_text(json.dumps(presets,ensure_ascii=False),encoding='utf-8')
                    temp.replace(DELIVERY_PRESETS)
                self.json_reply(presets)
                return
            if parsed.path == '/api/studios':
                if not 0 < length <= 4096:
                    raise ValueError('项目请求无效。')
                data = json.loads(self.rfile.read(length))
                with project_lock:
                    action = data.get('action')
                    if action in ('create','rename'):
                        name = str(data.get('name','')).strip()
                        if not 1 <= len(name) <= 80:
                            raise ValueError('请输入项目名称。')
                    if action == 'create':
                        identifier = create_studio(name,data.get('directory'))
                        select_studio(identifier)
                    elif action == 'open':
                        identifier = data.get('id')
                        if read_catalog(identifier).get('trashed'):
                            raise ValueError('请先恢复此项目。')
                        load_studio(studio_path(identifier))
                        select_studio(identifier)
                    elif action in ('rename','trash','recover'):
                        identifier = data.get('id')
                        record = read_catalog(identifier)
                        path = studio_path(identifier)
                        if not record and identifier != 'default' and not path.is_file() and not path.with_suffix('.bak').is_file():
                            raise ValueError('项目不存在。')
                        if action == 'rename':
                            record['name'] = name
                            record['renamed_at'] = time.time()
                        else:
                            record['trashed'] = action == 'trash'
                        write_catalog(identifier,record)
                    else:
                        raise ValueError('项目操作无效。')
                    active = recent_studio() if action == 'trash' else identifier if action in ('open','create') else None
                    if action == 'trash':
                        select_studio(active)
                self.json_reply({'id':identifier,'active':active})
                return
            if parsed.path == '/api/studio-backup':
                if not 0 < length <= 16384:
                    raise ValueError('项目备份请求无效。')
                data = json.loads(self.rfile.read(length))
                with project_lock:
                    identifier = data.get('id')
                    state = load_studio(studio_path(identifier))
                    name = read_catalog(identifier).get('name')
                    if name:
                        state['studio_name'] = name
                self.json_reply({'output':package_studio(state,data['directory'],data.get('media') is True)})
                return
            if parsed.path == '/api/choose-directory':
                if not IS_MAC:
                    self.json_reply({'path': None})
                    return
                res = subprocess.run(
                    ['osascript', '-e', 'POSIX path of (choose folder with prompt "选择目录")'],
                    capture_output=True, text=True, encoding='utf-8', timeout=120,
                )
                chosen = res.stdout.strip().rstrip('/') if res.returncode == 0 else ''
                self.json_reply({'path': chosen or None})
                return
            if parsed.path == '/api/open-directory':
                if not 0 < length <= 16384:
                    raise ValueError('路径请求无效。')
                data = json.loads(self.rfile.read(length))
                directory = data.get('directory')
                if not isinstance(directory, str) or not Path(directory).is_absolute() or not Path(directory).is_dir():
                    raise ValueError('无效路径。')
                if IS_MAC:
                    subprocess.run(['open', directory], check=False)
                    self.json_reply({'ok': True})
                else:
                    raise ValueError('当前平台不支持从浏览器打开目录。')
                return
            if parsed.path == '/api/studio-restore':
                if length <= 0 or length > shutil.disk_usage(WORK).free:
                    raise ValueError('项目包为空或保存空间不足。')
                self.json_reply({'id':restore_studio(self.rfile,length)})
                return
            if parsed.path == '/api/color-stream':
                if not 0 < length <= 16384:
                    raise ValueError('预览请求无效。')
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError('预览请求无效。')
                self.stream_color(data)
                return
            if parsed.path == '/api/color-lut':
                if not 0 < length <= 12 * 1024 * 1024:
                    raise ValueError('LUT 文件为空或过大。')
                data = json.loads(self.rfile.read(length))
                with project_lock:
                    install_vendor_lut(data['id'], data['content'])
                self.json_reply(list(public_presets()))
                return
            if parsed.path == '/api/export-space':
                if not 0 < length <= 16384: raise ValueError('输出路径无效。')
                data = json.loads(self.rfile.read(length))
                folder = Path(str(data.get('destination', ''))).expanduser()
                if not folder.is_absolute() or not folder.is_dir(): raise ValueError('请选择存在的输出文件夹。')
                self.json_reply({'free': shutil.disk_usage(folder).free})
                return
            if parsed.path in ('/api/export-submit', '/api/export-cancel', '/api/export-retry', '/api/export-preview', '/api/export-encoder'):
                if not 0 < length <= 1024 * 1024: raise ValueError('任务请求无效。')
                data = json.loads(self.rfile.read(length))
                if parsed.path == '/api/export-encoder': self.json_reply(export_queue.encoder_plan(data))
                elif parsed.path == '/api/export-submit': self.json_reply(export_queue.submit(data))
                elif parsed.path == '/api/export-cancel': export_queue.cancel(data['id']); self.json_reply({'ok': True})
                elif parsed.path == '/api/export-retry': export_queue.retry(data['id']); self.json_reply({'ok': True})
                else: export_queue.request_preview(data['id']); self.json_reply({'ok': True})
                return
            if parsed.path == '/api/copy-legacy':
                if not 0 < length <= 16384:
                    raise ValueError('旧项目请求无效。')
                data = json.loads(self.rfile.read(length))
                studio_id = data.get('studio_id','default')
                load_studio(studio_path(studio_id))
                legacy_root = LEGACY_ROOTS.get(data.get('source'))
                legacy_id = data.get('id')
                project_dir(legacy_id)
                if legacy_root is None:
                    raise ValueError('旧项目来源无效。')
                source_dir = legacy_root / legacy_id
                with (source_dir / 'project.json').open(encoding='utf-8') as file:
                    project = json.load(file)
                if project.get('id') != legacy_id or project.get('version') != 1:
                    raise ValueError('旧项目格式无效。')
                old_media = source_dir / 'media'
                media_size = old_media.stat().st_size if old_media.is_file() else 0
                parent = media_parent(studio_id)
                if shutil.disk_usage(parent).free < media_size + 256 * 1024**2:
                    raise ValueError('项目所在磁盘空间不足。')
                identifier = secrets.token_hex(16)
                destination = assign_media_location(identifier,parent)
                with copy_slots:
                    shutil.copytree(source_dir, destination)
                    project['id'] = identifier
                    project['studio_id'] = studio_id
                    project['expected_size'] = media_size
                    project['import_state'] = 'ready' if media_size else 'interrupted'
                    write_project(project)
                project['media_available'] = bool(media_size)
                self.json_reply(project)
                return
            if parsed.path == '/api/prepare-import':
                if not 0 < length <= 16384:
                    raise ValueError('导入信息无效。')
                data = json.loads(self.rfile.read(length))
                studio_id = data.get('studio_id','default')
                load_studio(studio_path(studio_id))
                size = data.get('size')
                if not isinstance(size, int) or not 0 < size <= 40 * 1024**3:
                    raise ValueError('文件大小必须在 0 到 40 GiB 之间。')
                parent = media_parent(studio_id)
                if shutil.disk_usage(parent).free < size + 256 * 1024**2:
                    raise ValueError('项目所在磁盘空间不足，无法保存媒体副本。')
                identifier = secrets.token_hex(16)
                assign_media_location(identifier,parent).mkdir()
                write_project({'version': 1, 'id': identifier, 'name': str(data.get('name', '未命名媒体'))[:255],
                               'studio_id':studio_id,
                               'updated': time.time(), 'model': 'base', 'language': '', 'rows': [],
                               'original': [], 'import_state': 'interrupted', 'expected_size': size})
                self.json_reply({'id': identifier})
                return
            if parsed.path == '/api/prepare-relink':
                if not 0 < length <= 16384:
                    raise ValueError('重新关联信息无效。')
                data = json.loads(self.rfile.read(length))
                directory = project_dir(data.get('id'))
                project = read_project(data['id'])
                if (directory / 'media').is_file():
                    raise ValueError('此素材的媒体副本存在，不能用重新关联覆盖。')
                size = data.get('size')
                if not isinstance(size, int) or not 0 < size <= 40 * 1024**3:
                    raise ValueError('文件大小无效。')
                project['expected_size'] = size
                project['import_state'] = 'interrupted'
                write_project(project)
                self.json_reply({'ready': True})
                return
            if parsed.path == '/api/studio-state':
                if not 0 < length <= 20 * 1024 * 1024:
                    raise ValueError('项目数据过大或为空。')
                state = json.loads(self.rfile.read(length))
                if state.get('version') != 1 or not isinstance(state.get('clips'), list):
                    raise ValueError('项目数据格式无效。')
                with project_lock:
                    identifier = parse_qs(parsed.query).get('studio',['default'])[0]
                    path = studio_path(identifier)
                    previous_project = load_studio(path)
                    name = read_catalog(identifier).get('name') or previous_project.get('studio_name')
                    if name:
                        state['studio_name'] = name
                    state.pop('recovered_from_backup',None)
                    if state == previous_project and path.is_file():
                        self.json_reply({'saved':True})
                        return
                    temporary = path.with_name('studio-' + secrets.token_hex(8) + '.tmp')
                    try:
                        with temporary.open('x', encoding='utf-8') as output:
                            json.dump(state, output, ensure_ascii=False)
                            output.flush()
                            os.fsync(output.fileno())
                        if path.exists():
                            try:
                                with path.open(encoding='utf-8') as previous:
                                    previous_state = json.load(previous)
                                if previous_state.get('version') == 1 and isinstance(previous_state.get('clips'), list):
                                    backup_tmp = path.with_name('backup-' + secrets.token_hex(8) + '.tmp')
                                    try:
                                        shutil.copyfile(path, backup_tmp)
                                        os.replace(backup_tmp, path.with_suffix('.bak'))
                                    finally:
                                        backup_tmp.unlink(missing_ok=True)
                            except (OSError, ValueError, TypeError, AttributeError):
                                pass
                        os.replace(temporary, path)
                    finally:
                        temporary.unlink(missing_ok=True)
                self.json_reply({'saved': True})
                return
            if parsed.path == '/api/import':
                if not 0 < length <= 40 * 1024**3:
                    raise ValueError('文件大小必须在 0 到 40 GiB 之间。')
                identifier = parse_qs(parsed.query).get('id', [''])[0]
                project = read_project(identifier)
                if project.get('expected_size') != length:
                    raise ValueError('文件大小与待导入素材不一致。')
                directory = project_dir(identifier)
                if shutil.disk_usage(directory).free < length + 256 * 1024**2:
                    raise ValueError('项目所在磁盘空间不足，无法保存媒体副本。')
                target = directory / 'media.partial'
                try:
                    copy_slots.acquire()
                    if (directory / 'media').exists():
                        raise ValueError('项目媒体副本已存在，不会覆盖。')
                    target.unlink(missing_ok=True)
                    with target.open('xb') as output:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise ValueError('导入中断，请重新选择文件。')
                            output.write(chunk)
                            remaining -= len(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(target, directory / 'media')
                    (directory / 'thumbnail.jpg').unlink(missing_ok=True)
                    project.update({'updated': time.time(), 'import_state': 'ready'})
                    write_project(project)
                except Exception:
                    target.unlink(missing_ok=True)
                    raise
                finally:
                    copy_slots.release()
                self.json_reply({'id': identifier})
                return
            if parsed.path not in ('/api/transcribe', '/api/audio', '/api/open', '/api/save', '/api/checkpoint', '/api/restore-checkpoint', '/api/probe'):
                self.send_error(404)
                return
            if not 0 < length <= 20 * 1024 * 1024:
                raise ValueError('无效的转录请求。')
            data = json.loads(self.rfile.read(length))
            identifier = data['id']
            directory = project_dir(identifier)
            source = directory / 'media'
            if parsed.path == '/api/open':
                project = read_project(identifier)
                project['media_available'] = source.is_file()
                self.json_reply(project)
                return
            if not source.is_file() and parsed.path in ('/api/probe', '/api/audio', '/api/transcribe'):
                raise ValueError('请重新导入媒体。')
            if parsed.path == '/api/probe':
                self.json_reply(probe_media(source))
                return
            if parsed.path == '/api/checkpoint':
                with project_lock:
                    project = read_project(identifier)
                    if data.get('revision') != project.get('revision', 0):
                        self.json_reply({'error': '项目已被其他窗口更新，请重新打开项目。'}, 409)
                        return
                    folder = directory / 'checkpoints'
                    folder.mkdir(exist_ok=True)
                    with (folder / (secrets.token_hex(16) + '.json')).open('x', encoding='utf-8') as output:
                        json.dump(project, output, ensure_ascii=False)
                        output.flush()
                        os.fsync(output.fileno())
                self.json_reply({'saved': True})
                return
            if parsed.path == '/api/restore-checkpoint':
                with project_lock:
                    project = read_project(identifier)
                    if data.get('revision') != project.get('revision', 0):
                        self.json_reply({'error': '项目已被其他窗口更新，请重新打开项目。'}, 409)
                        return
                    folder = directory / 'checkpoints'
                    candidates = sorted(folder.glob('*.json'), key=lambda item: item.stat().st_mtime_ns) if folder.exists() else []
                    if not candidates:
                        raise ValueError('这个项目还没有可恢复的旧版本。')
                    with candidates[-1].open(encoding='utf-8') as saved:
                        previous = json.load(saved)
                    with (folder / (secrets.token_hex(16) + '.json')).open('x', encoding='utf-8') as output:
                        json.dump(project, output, ensure_ascii=False)
                        output.flush()
                        os.fsync(output.fileno())
                    project.update({'rows': previous['rows'], 'model': previous['model'],
                                    'language': previous['language'], 'audio_track': previous.get('audio_track', 0),
                                    'revision': project.get('revision', 0) + 1,
                                    'updated': time.time()})
                    write_project(project)
                self.json_reply(project)
                return
            if parsed.path == '/api/save':
                with project_lock:
                    project = read_project(identifier)
                    revision = data.get('revision')
                    if not isinstance(revision, int) or revision != project.get('revision', 0):
                        self.json_reply({'error': '项目已被其他窗口更新，请重新打开项目。'}, 409)
                        return
                    rows = data.get('rows')
                    if not isinstance(rows, list) or len(rows) > 100000:
                        raise ValueError('稿件格式无效。')
                    for row in rows:
                        if (not isinstance(row, dict) or not isinstance(row.get('text'), str)
                            or not isinstance(row.get('start'), (float, int))
                            or not isinstance(row.get('end'), (float, int))
                            or not (math.isfinite(row['start']) and math.isfinite(row['end'])
                                    and 0 <= row['start'] <= row['end'])):
                            raise ValueError('稿件片段格式无效。')
                    model, language = data.get('model'), data.get('language')
                    if model not in MODELS or language not in ('', 'en', 'zh'):
                        raise ValueError('模型或语言无效。')
                    audio_track = data.get('audio_track', 0)
                    if not isinstance(audio_track, int) or not 0 <= audio_track < 128:
                        raise ValueError('音轨选择无效。')
                    project.update({'rows': rows, 'model': model, 'language': language, 'audio_track': audio_track,
                                    'updated': time.time(), 'revision': revision + 1})
                    write_project(project)
                self.json_reply({'revision': project['revision']})
                return
            if parsed.path == '/api/audio':
                audio_track = data.get('audio_track', 0)
                if not isinstance(audio_track, int) or not 0 <= audio_track < 128:
                    raise ValueError('音轨选择无效。')
                audio = subprocess.run([
                    find_ffmpeg(ROOT, 'ffmpeg'), '-v', 'error', '-nostdin',
                    '-i', str(source), '-map', f'0:a:{audio_track}', '-ac', '1', '-ar', '16000',
                    '-b:a', '48k', '-f', 'mp3', '-'
                ], capture_output=True, **subprocess_kwargs())
                if audio.returncode or not audio.stdout:
                    raise ValueError('无法生成可播放的音轨。')
                self.reply(audio.stdout, 'audio/mpeg')
                return
            selected, language = data['model'], data.get('language')
            backend = data.get('backend', 'cpu')
            if backend not in ('cpu','npu') or (backend == 'npu' and selected != 'base'):
                raise ValueError('NPU 实验仅支持 Whisper Base。')
            audio_track = data.get('audio_track', 0)
            if not isinstance(audio_track, int) or not 0 <= audio_track < 128:
                raise ValueError('音轨选择无效。')
            if not source.is_file() or selected not in MODELS or language not in (None, 'en', 'zh'):
                raise ValueError('媒体、模型或语言无效。')
            interval = data.get('interval')
            if interval is not None:
                start, end = interval
                if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end):
                    raise ValueError('选段时间无效。')
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

            def send_event(event):
                self.wfile.write((json.dumps(event, ensure_ascii=False) + '\n').encode())
                self.wfile.flush()

            try:
                def record_and_send(event):
                    if 'result' in event:
                        store_recognition(identifier, selected, language, interval, event['result'], audio_track)
                        if interval is None:
                            with project_lock:
                                project = read_project(identifier)
                                if not project.get('original'):
                                    project['original'] = event['result']['rows']
                                    project['original_model'] = selected
                                    project['original_language'] = language or ''
                                    project['original_audio_track'] = audio_track
                                    write_project(project)
                    send_event(event)

                send_event({'progress': '等待识别资源…'})
                with compute_lock:
                    run_worker(source, selected, language, interval, record_and_send, audio_track, backend)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                send_event({'error': f'转录失败：{exc}'})
        except (ValueError, KeyError, TypeError) as exc:
            self.json_reply({'error': str(exc)}, 400)
        except Exception as exc:
            self.json_reply({'error': f'本地处理失败：{exc}'}, 500)


if __name__ == '__main__':
    if '--probe-worker' in sys.argv:
        try:
            import av
            with av.open(sys.stdin.read()) as container:
                audio = []
                for index, stream in enumerate(container.streams.audio):
                    context = stream.codec_context
                    audio.append({'index': index, 'codec': context.name,
                                  'channels': context.channels, 'sample_rate': context.sample_rate,
                                  'language': stream.metadata.get('language'),
                                  'title': stream.metadata.get('title')})
                video = None
                if container.streams.video:
                    stream = container.streams.video[0]
                    context = stream.codec_context
                    fmt = context.format
                    video = {'codec': context.name, 'width': context.width, 'height': context.height,
                             'duration': float(stream.duration * stream.time_base)
                             if stream.duration is not None and stream.time_base is not None else None,
                             'frame_rate': str(stream.average_rate) if stream.average_rate else None,
                             'pixel_format': fmt.name if fmt else None,
                             'bit_depth': max((getattr(component, 'bits', 0) or 0 for component in fmt.components), default=0) or None if fmt else None,
                             'primaries': str(getattr(context, 'color_primaries', '') or ''),
                             'transfer': str(getattr(context, 'color_trc', '') or ''),
                             'range': str(getattr(context, 'color_range', '') or ''),
                             'matrix': str(getattr(context, 'colorspace', '') or '')}
                subtitles = [{'codec': stream.codec_context.name,
                              'language': stream.metadata.get('language')}
                             for stream in container.streams.subtitles]
                info = {'duration': container.duration / av.time_base if container.duration else None,
                        'container': container.format.name, 'video': video, 'audio': audio,
                        'subtitles': subtitles}
            print(json.dumps(info, ensure_ascii=False), flush=True)
        except Exception:
            sys.exit(1)
        sys.exit(0)

    if '--recognition-worker' in sys.argv:
        def emit(event):
            print(json.dumps(event, ensure_ascii=False), flush=True)

        try:
            source, selected, language, interval, *extra = json.load(sys.stdin)
            result = recognize(source, selected, language, interval,
                               lambda message: emit({'progress': message}), extra[0] if extra else 0,
                               extra[1] if len(extra) > 1 else 'cpu')
            emit({'result': result})
        except Exception as exc:
            import traceback
            traceback.print_exc()
            emit({'error': f'转录失败：{exc}'})
        sys.exit(0)

    PROJECTS.mkdir(parents=True, exist_ok=True)
    export_queue = ExportQueue(ROOT, project_dir, read_project, probe_media, compute_lock)
    workspace_previews = WorkspacePreviews(ROOT, project_dir, probe_media)
    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        address = f'http://127.0.0.1:{server.server_port}/'
        print(address, flush=True)
        if '--no-browser' not in sys.argv:
            webbrowser.open(address)
        if '--managed' in sys.argv:
            def stop_on_parent_exit():
                sys.stdin.read()
                server.shutdown()

            threading.Thread(target=stop_on_parent_exit, daemon=True).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            workspace_previews.stop()
            export_queue.stop()
