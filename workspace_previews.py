"""Temporary previews driven by the selected source timestamp."""
import hashlib
import json
import math
import subprocess
import tempfile
import threading
from functools import lru_cache
from pathlib import Path

from color_presets import PRESETS, validate_color, write_transform
from transcode_jobs import color_input_filters
from hardware_encoding import output_tags
from platform_mac import IS_MAC, data_root, find_ffmpeg, subprocess_kwargs

AUTO_PREVIEW_HEIGHT = 1080
PREVIEW_HEIGHTS = {'360': 360, '720': 720, '1080': 1080}
QSV_PIXEL_FORMATS = {'yuv420p': 'nv12', 'yuv420p10le': 'p010le', 'yuv422p10le': 'y210le'}
VT_CODECS = {'hevc', 'h264', 'prores'}


class WorkspacePreviews:
    def __init__(self, root, project_dir, probe):
        self.ffmpeg = find_ffmpeg(root, 'ffmpeg')
        self.project_dir = project_dir
        self.probe = probe
        self.directory = tempfile.TemporaryDirectory(prefix='localpost-preview-', dir=data_root(root))
        self.root = Path(self.directory.name)
        self.lock = threading.RLock()
        self.color_lock = threading.Lock()
        self.processes = set()
        self.latest_color = 0
        self.stopping = False
        self.unsupported_hw = set()

    def source(self, data):
        source = self.project_dir(data.get('media_id')) / 'media'
        if not source.is_file():
            raise ValueError('预览素材不存在。')
        start = data.get('start')
        if not isinstance(start, (float, int)) or not math.isfinite(start) or not 0 <= start < 1e8:
            raise ValueError('无效的预览播放位置。')
        return source, start

    @lru_cache(maxsize=32)
    def video_info(self, source, identity):
        return self.probe(source).get('video') or {}

    def command(self, source, start, threads, hw=None):
        decoder = []
        if hw == 'qsv':
            decoder = ['-init_hw_device', 'qsv=preview:hw_any,child_device_type=d3d11va',
                       '-hwaccel', 'qsv', '-hwaccel_device', 'preview',
                       '-hwaccel_output_format', 'qsv', '-c:v', 'hevc_qsv']
        elif hw == 'videotoolbox':
            decoder = ['-hwaccel', 'videotoolbox']
        return [self.ffmpeg, '-hide_banner', '-v', 'error', '-nostdin', '-filter_threads', '2',
                '-threads', str(threads), '-copyts', '-start_at_zero', '-noaccurate_seek',
                '-ss', format(start, '.6f'), *decoder, '-i', str(source),
                '-map', '0:v:0', '-an', '-sn', '-dn']

    def process(self, cmd, **kwargs):
        with self.lock:
            if self.stopping:
                raise ValueError('程序正在关闭。')
            process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       **subprocess_kwargs(**kwargs))
            self.processes.add(process)
            return process

    def release(self, process):
        if process.poll() is None:
            process.terminate()
        process.wait()
        if process.stdout:
            process.stdout.close()
        with self.lock:
            self.processes.discard(process)

    def color(self, data):
        source, start = self.source(data)
        settings = validate_color(data.get('color'))
        sequence = data.get('sequence')
        if sequence is not None:
            with self.lock:
                if type(sequence) is not int or sequence <= self.latest_color:
                    raise ValueError('此色彩预览已过期。')
                self.latest_color = sequence
        # The input matrix and range are applied before the exact same 3D LUT as export.
        if PRESETS[settings['input_id']]['asset']:
            lut_definition = [settings['input_id']]
        else:
            lut_definition = [settings.get(key) for key in (
                'input_id', 'output_id', 'range', 'strategy', 'highlight', 'tone', 'ootf', 'white_adapt', 'input_peak', 'output_peak')]
        key = hashlib.sha256(json.dumps(lut_definition).encode()).hexdigest()[:24]
        folder = self.root / key
        with self.color_lock:
            if self.stopping or (sequence is not None and sequence != self.latest_color):
                raise ValueError('此色彩预览已过期。')
            folder.mkdir(exist_ok=True)
            lut = folder / 'canon.cube'
            if not lut.is_file():
                temporary = folder / 'draft.cube'
                write_transform(temporary, settings)
                temporary.replace(lut)
        if self.stopping or (sequence is not None and sequence != self.latest_color):
            raise ValueError('此色彩预览已过期。')
        stat = source.stat()
        identity = (stat.st_size, stat.st_mtime_ns)
        info = self.video_info(source, identity)
        source_width, source_height = info.get('width'), info.get('height')
        if not source_width or not source_height:
            raise ValueError('素材没有可转换的视频画面。')
        display = data.get('display')
        if isinstance(display, list) and len(display) == 2 and all(type(n) is int and 0 < n <= 16384 for n in display):
            source_width, source_height = display
        quality = data.get('quality', 'auto')
        if not isinstance(quality, str) or quality not in (*PREVIEW_HEIGHTS, 'auto', 'source'):
            raise ValueError('无效的预览分辨率。')
        if quality == 'source':
            width, height = source_width, source_height
        else:
            bound = PREVIEW_HEIGHTS.get(quality, AUTO_PREVIEW_HEIGHT)
            box = (round(bound * 16 / 9), bound) if source_width >= source_height else (bound, round(bound * 16 / 9))
            factor = min(1, box[0] / source_width, box[1] / source_height)
            width, height = max(1, round(source_width * factor)), max(1, round(source_height * factor))
        if width * height > 40_000_000:
            raise ValueError('原分辨率超过预览支持范围。')
        live = data.get('live') is True
        fps = 20
        # Explicitly trim decoded timestamps so both decoders start at the same frame after seeking.
        seconds = format(start, '.6f')
        timing = [f'trim=start={seconds}', f'setpts=PTS-{seconds}/TB']
        if live:
            timing.append(f'fps=fps={fps}:start_time=0:round=up')
        filters = color_input_filters(settings, (width, height) if live else None)
        # Preview the same range/matrix transform as export, then decode it for RGB display.
        _, _, matrix_tag, range_tag = output_tags(settings, None)
        matrix = 'bt2020' if matrix_tag == 9 else 'bt709'
        levels = 'full' if range_tag == 2 else 'limited'
        filters += [f'scale=in_range=full:out_range={levels}:out_color_matrix={matrix}',
                    'format=yuv444p16le', f'scale=in_range={levels}:in_color_matrix={matrix}:out_range=full', 'format=gbrp16le']
        gamma = settings['gamma']
        if gamma in ('Rec.2100 HLG', 'Rec.2100 PQ'):
            transfer = 'arib-std-b67' if gamma.endswith('HLG') else 'smpte2084'
            filters += ['format=gbrpf32le', f'zscale=pin=2020:tin={transfer}:p=709:t=linear:npl=100',
                        'tonemap=mobius:desat=0', 'zscale=t=709']
        elif settings['output'] == 'BT.2020' and gamma == 'BT.2020 SDR':
            filters += ['format=gbrpf32le', 'zscale=pin=2020:tin=2020_10:p=709:t=709']
        filters += [f'scale={width}:{height}:flags=area', 'format=rgba']
        pixel_format = info.get('pixel_format')
        codec = info.get('codec')
        hardware_key = (source, identity)
        hw_candidate = None
        if data.get('software') is not True and hardware_key not in self.unsupported_hw:
            if IS_MAC and codec in VT_CODECS:
                hw_candidate = 'videotoolbox'
            elif not IS_MAC and codec == 'hevc' and pixel_format in QSV_PIXEL_FORMATS:
                hw_candidate = 'qsv'

        attempts = (hw_candidate, None) if hw_candidate else (None,)
        for hw in attempts:
            if self.stopping or (sequence is not None and sequence != self.latest_color):
                raise ValueError('此色彩预览已过期。')
            unpack = []
            if hw == 'qsv':
                unpack = ['hwdownload', f'format={QSV_PIXEL_FORMATS[pixel_format]}', f'format={pixel_format}']
            graph = timing + unpack + filters
            command = self.command(source, start, 2, hw=hw) + ['-vf', ','.join(graph)]
            if not live:
                command += ['-frames:v', '1']
            command += ['-c:v', 'rawvideo', '-threads:v', '1', '-f', 'rawvideo', 'pipe:1']
            process = self.process(command, stderr=subprocess.DEVNULL, cwd=folder)
            try:
                first = process.stdout.read(width * height * 4)
                if len(first) == width * height * 4:
                    if hw_candidate and hw is None:
                        # Cache only when CPU confirms that this source position was decodable.
                        with self.lock:
                            self.unsupported_hw.add(hardware_key)
                    return process, first, width, height, fps, hw or 'cpu'
            except Exception:
                self.release(process)
                raise
            self.release(process)
        raise ValueError('无法解码此位置的色彩预览。')

    def stop(self):
        with self.lock:
            self.stopping = True
            processes = list(self.processes)
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            process.wait()
        try:
            self.directory.cleanup()
        except OSError:
            pass
