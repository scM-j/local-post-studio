"""Persistent, single-worker media export queue for the development build."""
import json
import math
from functools import lru_cache
import os
import queue
import re
import secrets
import shutil
import struct
import subprocess
import threading
import time
from pathlib import Path
from color_presets import HDR_PROFILES, validate_color, write_transform
from hardware_encoding import (HARDWARE_ENGINES, MODES as ENCODER_MODES, PROFILES as HARDWARE_PROFILES,
    HardwareEncoderProbe, HardwareEncodingError, encoder_args, output_tags, tag_filter, tag_flags, verify_encoding)
from platform_mac import data_root, default_caption_font, find_ffmpeg, subprocess_kwargs

PROFILES = {'ProRes 422 Proxy': 'proxy', 'ProRes 422 LT': 'lt',
            'ProRes 422': 'standard', 'ProRes 422 HQ': 'hq',
            'ProRes 4444': '4444', 'ProRes 4444 XQ': '4444xq'}
EXTRA_PROFILES = {
    'H.266 / VVC': (('mp4',), 'yuv420p10le', ('-c:v','libvvenc','-preset','fast','-qp','30')),
    # VVenC takes 10-bit input in both modes; internalbitdepth controls the coded output.
    'H.266 / VVC 8-bit': (('mp4',), 'yuv420p10le', ('-c:v','libvvenc','-preset','fast','-qp','30','-vvenc-params','internalbitdepth=8')),
    'AV2': (('ivf',), 'yuv420p10le', ()),
    'AV2 8-bit': (('ivf',), 'yuv420p', ()),
    'DNxHR SQ': (('mov', 'mxf'), 'yuv422p', ('-c:v', 'dnxhd', '-profile:v', 'dnxhr_sq')),
    'DNxHR HQX': (('mov', 'mxf'), 'yuv422p10le', ('-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx')),
    'FFV1': (('mkv',), None, ('-c:v', 'ffv1', '-level', '3')),
    'AV1 10-bit': (('mp4', 'mkv'), 'yuv420p10le', ('-c:v', 'libaom-av1', '-cpu-used', '6', '-crf', '28')),
    'AV1 8-bit': (('mp4', 'mkv'), 'yuv420p', ('-c:v', 'libaom-av1', '-cpu-used', '6', '-crf', '28')),
    'AV1 10-bit 4:2:2': (('mp4', 'mkv'), 'yuv422p10le', ('-c:v', 'libaom-av1', '-profile:v', '2', '-cpu-used', '6', '-crf', '28')),
    'VP9': (('webm',), 'yuv420p', ('-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '4', '-crf', '28', '-b:v', '0')),
}
AUDIO_OUTPUT = {'wav':'pcm_s24le', 'flac':'flac', 'mp3':'libmp3lame'}
MUXER_NAMES = {'mkv':'matroska'}
VVC_PROFILES = ('H.266 / VVC','H.266 / VVC 8-bit')
AV2_PROFILES = ('AV2','AV2 8-bit')

@lru_cache(maxsize=8)
def executable_support(path, modified, option, expected):
    try:
        result = subprocess.run([str(path), option], stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=8, **subprocess_kwargs())
        return expected in result.stdout + result.stderr
    except (OSError, subprocess.TimeoutExpired):
        return False
SHARE_PROFILES = {'H.264 8-bit 4:2:0': ('libx264', 'yuv420p'),
                  'H.264 10-bit 4:2:2': ('libx264', 'yuv422p10le'),
                  'H.265 8-bit 4:2:0': ('libx265', 'yuv420p'),
                  'H.265 10-bit 4:2:0': ('libx265', 'yuv420p10le'),
                  'H.265 10-bit 4:2:2': ('libx265', 'yuv422p10le')}
AUDIO = {'PCM 24-bit': 'pcm_s24le', 'PCM 16-bit': 'pcm_s16le',
         'PCM 32-bit': 'pcm_s32le', '不输出音频': None}
CAPTION_STYLES = {
    'box': 'BorderStyle=3,PrimaryColour=&H00FFFFFF,OutlineColour=&H33101010,Outline=2.4,Shadow=0',
    'outline': 'BorderStyle=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00131517,Outline=1.6,Shadow=0',
    'shadow': 'BorderStyle=1,PrimaryColour=&H00FFFFFF,BackColour=&H40000000,Outline=0,Shadow=2.0',
    'amber': 'BorderStyle=1,PrimaryColour=&H00A3E0FF,OutlineColour=&H00131517,Outline=1.6,Shadow=0',
}


def srt_text(rows, duration=None):
    def stamp(seconds):
        milliseconds = round(seconds * 1000)
        hours, remainder = divmod(milliseconds, 3600000)
        minutes, remainder = divmod(remainder, 60000)
        seconds, milliseconds = divmod(remainder, 1000)
        return f'{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}'
    lines = []
    for row in sorted(rows, key=lambda row: row['start']):
        start = row['start']
        end = min(row['end'], duration) if duration else row['end']
        if round(start * 1000) >= round(end * 1000):
            continue
        # Blank lines separate SRT cues. Keep only visible lines within a cue.
        text = '\n'.join(line for line in row['text'].splitlines() if line.strip())
        if text:
            lines.append(f"{len(lines) + 1}\n{stamp(start)} --> {stamp(end)}\n{text}\n")
    if not lines:
        raise ValueError('素材时间范围内没有有效字幕。')
    return '\n'.join(lines)


def write_positioned_captions(ffmpeg, assets, job, video):
    font = job.get('caption_font') or default_caption_font()
    x, y = job.get('caption_position') or (.5, .91)
    play_height = 288
    play_width = max(1, round(play_height * video['width'] / video['height']))
    margin = round(play_width * max(.06, abs(x - .5) + .02))
    position = rf'{{\an2\pos({round(x * play_width)},{round(y * play_height)})}}'
    converted = subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-f', 'srt', '-i', 'caption.srt',
                                '-c:s', 'ass', '-f', 'ass', 'pipe:1'],
                               cwd=assets, capture_output=True, encoding='utf-8',
                               timeout=15, **subprocess_kwargs())
    if converted.returncode:
        raise ValueError('无法准备烧录字幕：' + converted.stderr.strip())
    lines = []
    for line in converted.stdout.splitlines():
        if line.startswith('PlayResX:'):
            line = f'PlayResX: {play_width}'
        elif line.startswith('PlayResY:'):
            line = f'PlayResY: {play_height}'
        elif line.startswith('Style:'):
            fields = line.split(',')
            fields[1] = font
            line = ','.join(fields)
        elif line.startswith('Dialogue:'):
            fields = line.split(',', 9)
            fields[5:7] = [str(margin), str(margin)]
            fields[9] = position + re.sub(r'\{\\an[1-9]\}', '', fields[9])
            line = ','.join(fields)
        lines.append(line)
    (assets / 'caption.ass').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def color_input_filters(color, size=None):
    dimensions = f'{size[0]}:{size[1]}:' if size else ''
    return [f"scale={dimensions}in_color_matrix={color['matrix']}:in_range={color['range']}:out_range=full",
            'format=gbrp16le', 'lut3d=file=canon.cube:interp=tetrahedral']


def video_encoding(job, info):
    command = []
    profile = PROFILES.get(job['profile'])
    color = job.get('color')
    mode = job.get('subtitle_mode', 'none')
    pixel_format = 'yuv422p10le'
    if profile:
        if profile.startswith('4444'):
            source_format = info['video'].get('pixel_format') or ''
            has_alpha = source_format.startswith(('yuva', 'gbrap')) or source_format in ('rgba','bgra','argb','abgr','rgba64le','rgba64be')
            if has_alpha and (color or mode == 'burn'):
                raise ValueError('保留透明通道时请关闭色彩转换和烧录字幕。')
            pixel_format = 'yuva444p10le' if has_alpha else 'yuv444p10le'
        command += ['-c:v', 'prores_ks', '-profile:v', profile, '-pix_fmt', pixel_format]
        if job.get('prores_speed') == 'fixed':
            command += ['-qscale:v', '4']
    elif job['profile'] in EXTRA_PROFILES:
        _, pixel_format, options = EXTRA_PROFILES[job['profile']]
        command += options
        if pixel_format:
            command += ['-pix_fmt', pixel_format]
        elif not color and mode != 'burn' and info['video'].get('pixel_format'):
            # Fail if the encoder cannot retain the source sampling and precision.
            command += ['-pix_fmt', '+' + info['video']['pixel_format']]
    else:
        codec, pixel_format = SHARE_PROFILES[job['profile']]
        command += ['-c:v', codec, '-pix_fmt', pixel_format, '-crf', '20', '-preset', 'medium']
        if codec == 'libx265':
            command += ['-tag:v', 'hvc1']
    return command, pixel_format


def target_video_bitrate(job, info, extension):
    duration = info['video'].get('duration') or info.get('duration')
    if not duration or duration <= 0:
        raise ValueError('无法读取视频时长，不能按体积估算码率。')
    audio = info.get('audio') or []
    audio_rate = 0
    if AUDIO[job['audio']] and audio:
        track = audio[job['track']]
        depth = {'PCM 16-bit':16,'PCM 24-bit':24,'PCM 32-bit':32}[job['audio']]
        audio_rate = 160000 if extension == 'mp4' else (track.get('channels') or 2)*(track.get('sample_rate') or 48000)*depth
    result = int(job['target_size_mb'] * 1_000_000 * .98 * 8 / duration - audio_rate)
    if result < 1000:
        raise ValueError('目标体积太小，无法容纳当前音轨与视频。')
    return result


def write_canon_transform(path, settings):
    # Canon Log 3 v1.2 studio code values and Canon Cinema Gamut D65.
    # https://github.com/colour-science/colour/blob/develop/colour/models/rgb/transfer_functions/canon.py
    # https://colour.readthedocs.io/en/develop/generated/colour.models.RGB_COLOURSPACE_CINEMA_GAMUT.html
    cinema_to_xyz = ((0.71604965, 0.12968348, 0.10472280),
                     (0.26126136, 0.86964215, -0.13090350),
                     (-0.00967635, -0.23648164, 1.33521573))
    xyz_to_709 = ((3.24096994, -1.53738318, -0.49861076),
                  (-0.96924364, 1.87596750, 0.04155506),
                  (0.05563008, -0.20397696, 1.05697151))
    matrix = tuple(tuple(sum(row[k] * cinema_to_xyz[k][j] for k in range(3))
                         for j in range(3)) for row in xyz_to_709)
    reverse = settings.get('direction') == 'to_log'
    if reverse:
        # Invert the linear D65 Cinema Gamut → Rec.709 matrix.
        a, b, c = matrix
        cross = lambda u, v: tuple(u[(i+1)%3]*v[(i+2)%3] - u[(i+2)%3]*v[(i+1)%3] for i in range(3))
        cofactors = (cross(b,c), cross(c,a), cross(a,b))
        determinant = sum(x*y for x,y in zip(a,cofactors[0]))
        matrix = tuple(tuple(cofactors[j][i] / determinant for j in range(3)) for i in range(3))

    def linear(value):
        if reverse:
            if settings['curve'] == 'Rec.709':
                return value / 4.5 if value < 0.081 else ((value + .099) / 1.099) ** (1 / .45)
            return value ** (2.2 if settings['curve'] == 'Gamma 2.2' else 2.4)
        code = (64 + 876 * value) / 1023 if settings['range'] == 'limited' else value
        if code < 0.097465473:
            x = -(10 ** ((0.12783901 - code) / 0.36726845) - 1) / 14.98325
        elif code <= 0.15277891:
            x = (code - 0.12512219) / 1.9754798
        else:
            x = (10 ** ((code - 0.12240537) / 0.36726845) - 1) / 14.98325
        return 0.9 * x

    def encode(value):
        if reverse:
            x = value / .9
            if x < -.014:
                code = .12783901 - .36726845 * math.log10(1 - 14.98325*x)
            elif x <= .014:
                code = 1.9754798*x + .12512219
            else:
                code = .36726845 * math.log10(1 + 14.98325*x) + .12240537
            return min(1.0, max(0.0, (code * 1023 - 64) / 876))
        value = min(1.0, max(0.0, value))
        if settings['gamma'] == 'Gamma 2.2':
            return value ** (1 / 2.2)
        if settings['gamma'] == 'Gamma 2.4':
            return value ** (1 / 2.4)
        return 4.5 * value if value < 0.018 else 1.099 * value ** 0.45 - 0.099

    grid = [linear(i / 64) for i in range(65)]
    with path.open('w', encoding='ascii') as cube:
        cube.write('LUT_3D_SIZE 65\n')
        for b in grid:
            for g in grid:
                for r in grid:
                    rgb = [encode(row[0] * r + row[1] * g + row[2] * b) for row in matrix]
                    cube.write(' '.join(f'{value:.8f}' for value in rgb) + '\n')


class ExportQueue:
    def __init__(self, root, project_dir, read_project, probe, compute_lock):
        self.root, self.project_dir, self.read_project = root, project_dir, read_project
        self.probe, self.compute_lock = probe, compute_lock
        self.hardware = HardwareEncoderProbe(root,probe)
        self.work_root = data_root(root)
        self.path = self.work_root / 'export-jobs.json'
        self.lock = threading.RLock()
        self.pending = queue.Queue()
        self.processes = {}
        self.stopping = False
        self.jobs = []
        self.load_error = None
        if self.path.exists():
            try:
                with self.path.open(encoding='utf-8') as file:
                    self.jobs = json.load(file)
                if not isinstance(self.jobs, list):
                    raise ValueError('任务记录格式无效')
                for job in self.jobs:
                    if job.get('state') in ('排队', '运行中', '取消中', '正在完成'):
                        job.update(state='中断', message='程序退出时任务未完成；请检查后重试。')
                    if job.get('preview_state') in ('排队', '运行中'):
                        job['preview_state'] = '中断'
                self._save()
            except (OSError, ValueError, TypeError, AttributeError) as exc:
                self.jobs = []
                self.load_error = '导出任务记录无法读取，原文件已保留：' + str(exc)
        threading.Thread(target=self._worker, daemon=True).start()

    def _save(self):
        temporary = self.path.with_name('jobs-' + secrets.token_hex(8) + '.tmp')
        try:
            with temporary.open('x', encoding='utf-8') as file:
                json.dump(self.jobs, file, ensure_ascii=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def list(self):
        if self.load_error:
            raise ValueError(self.load_error)
        with self.lock:
            result = json.loads(json.dumps([
                {key: value for key, value in job.items() if key != 'subtitles'} for job in self.jobs
            ], ensure_ascii=False))
        for job in result:
            if job.get('preview_state') == '已完成':
                try:
                    paths = (self.project_dir(job['media_id']) / 'media', Path(job['output']))
                    current = [[path.stat().st_size, path.stat().st_mtime_ns] for path in paths]
                    if current != job.get('preview_sources'):
                        job['preview_state'] = '已过期'
                except (OSError, ValueError, TypeError):
                    job['preview_state'] = '已过期'
        return result

    def _get(self, identifier):
        return next((job for job in self.jobs if job['id'] == identifier), None)

    def encoder_plan(self, data):
        mode = data.get('encoder_mode', 'cpu')
        if mode not in ENCODER_MODES:
            raise ValueError('编码路径无效。')
        if data.get('kind', 'video') != 'video' or not (
            data.get('transcode', True) or data.get('transform') or data.get('subtitle_mode') == 'burn'
        ):
            return {'engine':'none','reason':''}
        profile = data.get('profile')
        if profile in VVC_PROFILES + AV2_PROFILES:
            available = self.modern_codecs().get(profile,False)
            return {'engine':'cpu' if available and mode != 'gpu' else None,
                    'reason':'此档位仅支持 CPU' if available else '本机缺少该编码器'}
        if data.get('target_size_mb') is not None:
            return {'engine':None if mode == 'gpu' else 'cpu',
                    'reason':'按目标体积需使用 CPU 编码'}
        if mode == 'cpu' or profile not in HARDWARE_PROFILES:
            return self.hardware.resolve(mode,profile,())
        color = validate_color(data.get('color')) if data.get('transform') else None
        source_video = None
        if not color:
            source = self.project_dir(data.get('media_id')) / 'media'
            source_video = self.probe(source).get('video')
        return self.hardware.resolve(mode,profile,output_tags(color,source_video))

    def modern_codecs(self):
        def supports(path, option, expected):
            try:
                p = Path(path)
                return executable_support(p, p.stat().st_mtime_ns, option, expected)
            except OSError:
                return False
        vvc = supports(find_ffmpeg(self.root, 'vvc'), '-encoders', b' libvvenc ')
        av2 = supports(find_ffmpeg(self.root, 'avm'), '--help', b'--ivf')
        return {**dict.fromkeys(VVC_PROFILES, vvc), **dict.fromkeys(AV2_PROFILES, av2)}

    def submit(self, data):
        if self.load_error:
            raise ValueError(self.load_error)
        project_id = data.get('media_id')
        project = self.read_project(project_id)
        source = self.project_dir(project_id) / 'media'
        kind = data.get('kind', 'video')
        if not source.is_file() and kind != 'subtitles':
            raise ValueError('素材文件缺失，请先重新关联。')
        profile, audio = data.get('profile'), data.get('audio')
        if (profile not in PROFILES and profile not in SHARE_PROFILES and profile not in EXTRA_PROFILES) or audio not in AUDIO:
            raise ValueError('编码或音频设置无效。')
        if kind not in ('video', 'remux', 'audio', 'subtitles'):
            raise ValueError('交付类型无效。')
        quick = data.get('prores_speed', 'standard')
        if quick not in ('standard', 'fixed'):
            raise ValueError('ProRes 速度模式无效。')
        transcode = data.get('transcode', True)
        width, height, fps = (data.get(key) for key in ('output_width','output_height','output_fps'))
        if any(value is not None for value in (width,height,fps)) and (kind != 'video' or transcode is not True):
            raise ValueError('更改分辨率或帧率需要启用视频转码。')
        if (width is not None or height is not None) and not all(
            type(value) is int and 2 <= value <= 8192 and value % 2 == 0 for value in (width,height)
        ):
            raise ValueError('请填写 2 到 8192 的偶数宽度和高度。')
        if fps is not None and fps not in ('24000/1001','24','25','30000/1001','30','50','60000/1001','60','120'):
            raise ValueError('输出帧率无效。')
        target_size = data.get('target_size_mb')
        if target_size is not None:
            if kind != 'video' or profile not in HARDWARE_PROFILES or not (
                type(target_size) in (int,float) and math.isfinite(target_size) and target_size > 0):
                raise ValueError('目标体积或压缩编码无效。')
            if not (transcode or data.get('transform') or data.get('subtitle_mode') == 'burn'):
                raise ValueError('按目标体积需要启用转码。')
        subtitle_mode = data.get('subtitle_mode', 'none')
        caption_style = data.get('caption_style') if subtitle_mode == 'burn' else None
        caption_font = data.get('caption_font') if subtitle_mode == 'burn' else None
        caption_position = data.get('caption_position') if subtitle_mode == 'burn' else None
        caption_size = data.get('caption_size', 100) if subtitle_mode == 'burn' else 100
        if type(caption_size) is not int or not 50 <= caption_size <= 175:
            raise ValueError('字幕字号无效。')
        if caption_style is not None and (not isinstance(caption_style, str) or caption_style not in CAPTION_STYLES):
            raise ValueError('字幕样式无效。')
        if caption_font is not None and (not isinstance(caption_font, str) or not caption_font.strip()
                                         or len(caption_font) > 120 or re.search(r'[,\x00-\x1f\x7f]', caption_font)):
            raise ValueError('字幕字体无效。')
        if caption_position is not None and (not isinstance(caption_position, list) or len(caption_position) != 2
              or any(type(n) not in (int,float) or not lo <= n <= hi
                     for n,lo,hi in zip(caption_position,(.1,.12),(.9,.98)))):
            raise ValueError('字幕位置无效。')
        has_subtitles = subtitle_mode != 'none' or kind == 'subtitles'
        subtitles = data.get('subtitles', []) if has_subtitles else []
        if not isinstance(transcode, bool) or subtitle_mode not in ('none', 'soft', 'burn'):
            raise ValueError('导出步骤无效。')
        if has_subtitles and (not isinstance(subtitles, list) or not subtitles):
            raise ValueError('当前素材没有可用字幕。')
        for row in subtitles:
            if not isinstance(row, dict) or not isinstance(row.get('text'), str) or not isinstance(row.get('start'), (int, float)) or not isinstance(row.get('end'), (int, float)) or not (0 <= row['start'] < row['end'] < 1e8):
                raise ValueError('字幕时间或内容无效。')
        color = data.get('color') if data.get('transform') else None
        catalog_color = isinstance(color, dict) and ('input_id' in color or 'output_id' in color)
        if catalog_color:
            color = validate_color(color)
            if color['gamma'] in ('Rec.2100 HLG','Rec.2100 PQ') and profile not in HDR_PROFILES:
                raise ValueError('HDR 请选择 10-bit H.265 或 AV1。')
        reverse = isinstance(color, dict) and color.get('direction') == 'to_log'
        if reverse and profile not in PROFILES:
            raise ValueError('转为 Log 请选择 ProRes MOV。')
        if reverse and not catalog_color and (color.get('gamut') != 'Rec.709' or color.get('curve') not in ('Rec.709','Gamma 2.2','Gamma 2.4')
                        or color.get('range') not in ('limited','full') or color.get('matrix') != 'bt709'
                        or color.get('output') != 'Canon Cinema Gamut' or color.get('gamma') != 'Canon Log 3'
                        or profile not in PROFILES):
            raise ValueError('转为 Log 请确认 Rec.709 输入曲线与电平，并选择 10-bit ProRes MOV。')
        if data.get('transform') and not catalog_color and not reverse and (
                not isinstance(color, dict)
                or color.get('gamut') != 'Canon Cinema Gamut'
                or color.get('curve') != 'Canon Log 3'
                or color.get('output') != 'Rec.709'
                or color.get('gamma') not in ('Rec.709', 'Gamma 2.2', 'Gamma 2.4')
                or color.get('range') not in ('limited', 'full')
                or color.get('matrix') not in ('bt709', 'bt2020')):
            raise ValueError('请确认 Canon Cinema Gamut、Canon Log 3、输入范围、YCbCr 矩阵及 Rec.709 输出。')
        container = data.get('container') or ('mp4' if profile in SHARE_PROFILES else 'mov')
        if kind == 'remux':
            container, transcode, color = 'mkv', False, None
        elif kind == 'audio':
            if container not in AUDIO_OUTPUT:
                raise ValueError('请选择 WAV、FLAC 或 MP3。')
            transcode, color = False, None
        elif kind == 'subtitles':
            if container != 'srt' or subtitle_mode != 'none':
                raise ValueError('独立字幕请选择 SRT。')
            transcode, color = False, None
        if kind != 'video' and (color or subtitle_mode == 'burn' or kind == 'audio' and subtitle_mode != 'none'):
            raise ValueError('当前交付类型无法处理画面或烧录字幕。')
        if kind == 'video':
            containers = EXTRA_PROFILES[profile][0] if profile in EXTRA_PROFILES else ('mov', 'mp4')
            if container not in containers:
                raise ValueError('所选编码与容器不兼容。')
        if container == 'mxf' and subtitle_mode == 'soft':
            raise ValueError('MXF 不支持此软字幕交付方式。')
        if kind == 'video' and profile in AV2_PROFILES and (not transcode or color or subtitle_mode != 'none' or audio != '不输出音频'):
            raise ValueError('AV2 IVF 当前只支持视频：启用转码、关闭色彩转换和字幕，并选择不输出音频。')
        mux_audio = data.get('mux_audio', 'none' if audio == '不输出音频' else 'selected')
        if mux_audio not in ('none', 'selected', 'all'):
            raise ValueError('封装音轨选项无效。')
        if container == 'mp4' and profile in PROFILES and (transcode or color or subtitle_mode == 'burn'):
            raise ValueError('ProRes 编码请选择 MOV 容器。')
        track = data.get('track', 0)
        if not isinstance(track, int) or not 0 <= track < 128:
            raise ValueError('音轨编号无效。')
        threads = data.get('threads', 'auto')
        if threads != 'auto' and (not isinstance(threads, int) or isinstance(threads, bool) or not 1 <= threads <= 64):
            raise ValueError('线程数须为自动或 1 到 64。')
        destination = Path(str(data.get('destination', ''))).expanduser()
        if not destination.is_absolute() or not destination.is_dir():
            raise ValueError('请选择存在的输出文件夹。')
        if kind != 'subtitles' and shutil.disk_usage(destination).free < 512 * 1024**2:
            raise ValueError('输出磁盘可用空间不足 512 MiB。')
        template = str(data.get('template') or '{name}_{profile}')
        if len(template) > 160 or re.search(r'\{(?!name\}|profile\})|(?<!\{name)(?<!\{profile)\}', template):
            raise ValueError('文件名模板只支持 {name} 和 {profile}。')
        output_label = profile if kind == 'video' else 'Copy' if kind == 'remux' else container.upper()
        base = template.replace('{name}', Path(project['name']).stem).replace('{profile}', output_label.replace(' ', '_'))
        base = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', base).strip(' .')[:180]
        if not base or base.upper().split('.')[0] in ('CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1,10)), *(f'LPT{i}' for i in range(1,10))):
            raise ValueError('输出文件名无效。')
        collision = data.get('collision', 'number')
        if collision not in ('number', 'skip'):
            raise ValueError('重名处理方式无效。')
        encoding = self.encoder_plan({**data, 'kind':kind, 'transcode':transcode, 'subtitle_mode':subtitle_mode})
        if encoding['engine'] is None:
            raise ValueError(encoding['reason'])
        with self.lock:
            identifier = secrets.token_hex(16)
            job = {'id': identifier, 'media_id': project_id, 'name': project['name'],
                   'profile': profile, 'audio': audio, 'track': track, 'threads': threads,
                   'transcode': transcode, 'subtitle_mode': subtitle_mode, 'subtitles': subtitles, 'color': color,
                   'caption_style': caption_style,
                   'caption_font': caption_font, 'caption_position': caption_position,
                   'caption_size': caption_size,
                   'encoder_mode': data.get('encoder_mode', 'cpu'), 'encoder_engine': encoding['engine'],
                   'studio_id': data.get('studio_id',project.get('studio_id','default')),
                   'target_size_mb': target_size,
                   'output_width': width, 'output_height': height, 'output_fps': fps,
                   'encoder_reason': encoding['reason'],
                   'container': container, 'kind': kind, 'prores_speed': quick,
                   'copy_subtitles': data.get('copy_subtitles') is True, 'mux_audio': mux_audio,
                   'destination': str(destination.resolve()), 'base': base, 'collision': collision,
                   'template': template,
                   'state': '排队', 'message': '等待处理资源', 'progress': None,
                   'created': time.time(), 'output': None, 'source_info': data.get('source_info')}
            self.jobs.append(job)
            self._save()
            self.pending.put(identifier)
            return dict(job)

    def cancel(self, identifier):
        with self.lock:
            job = self._get(identifier)
            if not job or job['state'] not in ('排队', '运行中'):
                raise ValueError('该任务无法取消。')
            job['state'] = '取消中' if job['state'] == '运行中' else '已取消'
            job['message'] = '正在取消' if job['state'] == '取消中' else '已取消'
            process = self.processes.get(identifier)
            if process and process.poll() is None:
                process.terminate()
            self._save()

    def retry(self, identifier):
        with self.lock:
            job = self._get(identifier)
            if not job or job['state'] not in ('失败', '已取消', '中断'):
                raise ValueError('该任务无法重试。')
            job.update(state='排队', message='等待处理资源', progress=None, output=None)
            job.pop('speed', None)
            job.pop('eta', None)
            self._save()
            self.pending.put(identifier)

    def output(self, identifier):
        with self.lock:
            job = self._get(identifier)
            if not job or job['state'] != '已完成' or not job.get('output'):
                raise ValueError('输出文件尚不可用。')
            path = Path(job['output'])
            if not path.is_file():
                raise ValueError('输出文件不存在。')
            return path

    def preview_path(self, identifier, side):
        if side not in ('source', 'output'):
            raise ValueError('预览类型无效。')
        with self.lock:
            job = self._get(identifier)
            if not job or job.get('preview_state') != '已完成':
                raise ValueError('预览尚未生成。')
            sources = (self.project_dir(job['media_id']) / 'media', Path(job['output']))
            current = [[path.stat().st_size, path.stat().st_mtime_ns] for path in sources]
            if current != job.get('preview_sources'):
                raise ValueError('预览已过期，请重新生成。')
            generation = job.get('preview_generation')
        if not isinstance(generation, str) or not re.fullmatch('[0-9a-f]{16}', generation):
            raise ValueError('预览编号无效。')
        path = self.work_root / 'previews' / identifier / generation / (side + '.mp4')
        if not path.is_file():
            raise ValueError('预览文件不存在。')
        return path

    def request_preview(self, identifier):
        with self.lock:
            job = self._get(identifier)
            if not job or job['state'] != '已完成':
                raise ValueError('请先完成导出。')
            if job.get('preview_state') in ('排队', '运行中'):
                raise ValueError('预览正在生成。')
            job['preview_state'] = '排队'
            job['preview_generation'] = secrets.token_hex(8)
            job.pop('preview_error', None)
            self._save()
        threading.Thread(target=self._make_preview, args=(identifier,), daemon=True).start()

    def _make_preview(self, identifier):
        with self.compute_lock:
            with self.lock:
                job = self._get(identifier)
                if not job or self.stopping:
                    return
                job['preview_state'] = '运行中'; self._save()
            folder = self.work_root / 'previews' / identifier / job['preview_generation']
            try:
                folder.mkdir(parents=True, exist_ok=True)
                sources = {'source': self.project_dir(job['media_id']) / 'media', 'output': self.output(identifier)}
                source_stats = [[path.stat().st_size, path.stat().st_mtime_ns] for path in sources.values()]
                for side, source in sources.items():
                    target = folder / (side + '.mp4')
                    if target.is_file():
                        continue
                    temporary = folder / (side + '.partial.mp4')
                    if temporary.exists():
                        raise ValueError('上次中断的预览临时文件仍存在：' + str(temporary))
                    try:
                        command = [find_ffmpeg(self.root, 'ffmpeg'), '-v', 'error', '-nostdin', '-n',
                                   '-threads', '2', '-i', str(source), '-map', '0:v:0', '-an', '-c:v', 'libx264',
                                   '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '2',
                                   '-fps_mode', 'passthrough', '-movflags', '+faststart', str(temporary)]
                        with self.lock:
                            if self.stopping:
                                raise ValueError('程序正在关闭。')
                            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                       stderr=subprocess.PIPE, **subprocess_kwargs())
                            self.processes['preview-' + identifier] = process
                        _, error = process.communicate()
                        with self.lock: self.processes.pop('preview-' + identifier, None)
                        if process.returncode or not temporary.is_file() or not temporary.stat().st_size:
                            raise ValueError(error.decode('utf-8', errors='replace')[-800:] or '预览生成失败。')
                        os.replace(temporary, target)
                    finally:
                        try: temporary.unlink(missing_ok=True)
                        except OSError: pass
                with self.lock:
                    job['preview_sources'] = source_stats
                    job['preview_state'] = '中断' if self.stopping else '已完成'; self._save()
            except Exception as exc:
                with self.lock:
                    job['preview_state'] = '中断' if self.stopping else '失败'
                    job['preview_error'] = str(exc); self._save()

    def stop(self):
        self.stopping = True
        with self.lock:
            for process in list(self.processes.values()):
                if process.poll() is None:
                    process.terminate()

    def _worker(self):
        while True:
            identifier = self.pending.get()
            try:
                try:
                    self._run(identifier)
                except HardwareEncodingError as exc:
                    with self.lock:
                        job = self._get(identifier)
                        if (job.get('encoder_mode') != 'auto' or job.get('encoder_engine') not in HARDWARE_ENGINES
                                or job['state'] != '运行中' or self.stopping):
                            raise
                        job.update(state='排队', encoder_engine='cpu', encoder_reason=str(exc), progress=None,
                                   message='硬件编码失败，正在改用 CPU')
                        self._save()
                    self._run(identifier)
            except Exception as exc:
                with self.lock:
                    job = self._get(identifier)
                    if job and job['state'] not in ('已取消', '中断'):
                        if job['state'] == '取消中':
                            job.update(state='已取消', message='已取消')
                        elif self.stopping:
                            job.update(state='中断', message='程序关闭，任务已中断。')
                        else:
                            job.update(state='失败', message=str(exc))
                        self._save()

    def _run(self, identifier):
        with self.lock:
            job = self._get(identifier)
            if not job or job['state'] != '排队':
                return
        if job.get('kind') == 'subtitles':
            return self._run_subtitles(job)
        with self.compute_lock:
            with self.lock:
                if job['state'] != '排队' or self.stopping:
                    return
                job.update(state='运行中', message='准备媒体', progress=None)
                self._save()
            source = self.project_dir(job['media_id']) / 'media'
            info = self.probe(source)
            kind = job.get('kind', 'video')
            if kind != 'audio' and not info.get('video'):
                raise ValueError('素材没有可转码的视频轨。')
            if kind == 'audio' and not info.get('audio'):
                raise ValueError('素材没有可导出的音轨。')
            mux_audio = job.get('mux_audio', 'selected' if AUDIO[job['audio']] else 'none')
            use_selected_audio = (mux_audio == 'selected' if kind == 'remux' else kind == 'audio' or bool(AUDIO[job['audio']]))
            if use_selected_audio and info.get('audio') and job['track'] >= len(info['audio']):
                raise ValueError('所选音轨不存在。')
            dest = Path(job['destination'])
            if not dest.is_dir() or shutil.disk_usage(dest).free < 512 * 1024**2:
                raise ValueError('输出目录不可用或磁盘剩余空间不足。')
            extension = job.get('container', 'mp4' if job['profile'] in SHARE_PROFILES else 'mov')
            temporary = dest / ('.localpost-' + identifier + '-' + secrets.token_hex(4) + '.partial.' + extension)
            with self.lock:
                job['temporary'] = str(temporary)
                self._save()
            requested_threads = job.get('threads', 'auto')
            threads = max(1, min(10, (os.cpu_count() or 2) - 2)) if requested_threads == 'auto' else requested_threads
            mode = job.get('subtitle_mode', 'none')
            assets = self.work_root / 'export-assets' / identifier
            assets.mkdir(parents=True, exist_ok=True)
            if mode != 'none':
                duration = info['video'].get('duration') or info.get('duration')
                (assets / 'caption.srt').write_text(srt_text(job['subtitles'], duration), encoding='utf-8')
            vvc = kind == 'video' and job['profile'] in VVC_PROFILES and (
                job.get('transcode',True) or job.get('color') or mode == 'burn')
            av2 = kind == 'video' and job['profile'] in AV2_PROFILES
            av2_depth = 8 if job['profile'] == 'AV2 8-bit' else 10
            command = [find_ffmpeg(self.root, 'vvc' if vvc else 'ffmpeg'), '-hide_banner', '-v', 'error', '-nostdin',
                       '-n', '-threads', str(threads), '-i', str(source)]
            if mode == 'soft':
                command += ['-f', 'srt', '-i', 'caption.srt']
            command += ['-map_metadata', '0', '-map_chapters', '0']
            if kind != 'audio':
                command += ['-map', '0:v:0']
            color = job.get('color')
            encode = job.get('transcode', True) or mode == 'burn' or bool(color)
            engine = job.get('encoder_engine', 'cpu')
            hardware = kind == 'video' and encode and engine in HARDWARE_ENGINES
            compression = job.get('target_size_mb') is not None
            verify_spec = hardware or (kind == 'video' and encode and (compression or job['profile'].startswith('AV1')))
            tags = output_tags(color,info.get('video'))
            pixel_format = 'yuv422p10le'
            if kind == 'audio':
                command += ['-map', '0:a:' + str(job['track']), '-vn', '-c:a', AUDIO_OUTPUT[extension]]
            elif not encode:
                source_codec = info['video'].get('codec')
                if kind == 'remux' and source_codec not in ('h264', 'hevc'):
                    raise ValueError('MKV 直接封装目前支持 H.264 和 H.265。')
                copy_codecs = {'mp4': ('h264','hevc','av1','mpeg4'), 'webm': ('vp8','vp9','av1'), 'mxf': ('dnxhd',)}
                if extension in copy_codecs and source_codec not in copy_codecs[extension]:
                    raise ValueError(f'该源视频编码不在 {extension.upper()} 的直通范围内，请启用转码。')
                command += ['-c:v', 'copy']
            elif hardware:
                device, options, pixel_format = encoder_args(job['profile'],engine,info['video'])
                command[1:1] = device
                command += options
            else:
                options, pixel_format = video_encoding(job, info)
                if compression:
                    if '-crf' in options:
                        at = options.index('-crf')
                        del options[at:at+2]
                    options += ['-b:v',str(target_video_bitrate(job,info,extension))]
                command += options
            filters = []
            if job.get('output_fps'):
                filters.append(f"fps={job['output_fps']}")
            if color:
                (write_transform if color.get('input_id') else write_canon_transform)(assets / 'canon.cube', color)
                output_matrix = 'bt2020' if tags[2] == 9 else 'bt709'
                output_range = 'full' if tags[3] == 2 else 'limited'
                filters.extend(color_input_filters(color))
                filters.extend([f'scale=in_range=full:out_range={output_range}:out_color_matrix={output_matrix}',
                                f'format={pixel_format or "yuv444p10le"}'])
            if job.get('output_width'):
                width,height = job['output_width'],job['output_height']
                filters.extend([
                    f'scale={width}:{height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1',
                    f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black'
                ])
            if mode == 'burn':
                caption_file = 'caption.srt'
                style = CAPTION_STYLES.get(job.get('caption_style'), '')
                if job.get('caption_position') or job.get('caption_font'):
                    video = info['video']
                    if job.get('output_width'):
                        video = {**video,'width':job['output_width'],'height':job['output_height']}
                    write_positioned_captions(command[0], assets, job, video)
                    caption_file = 'caption.ass'
                else:
                    style = f'FontName={default_caption_font()}' + (',' + style if style else '')
                if job.get('caption_size', 100) != 100:
                    font_size = 16 * job['caption_size'] / 100
                    style = ','.join(filter(None, (style, f'FontSize={font_size:g}')))
                filters.append(f"subtitles={caption_file}:charenc=UTF-8" + (f":force_style='{style}'" if style else ''))
            if (color or verify_spec) and any(value is not None for value in tags):
                command += tag_flags(tags)
                filters.append(tag_filter(tags))
            if filters:
                command += ['-vf', ','.join(filters)]
            if encode:
                command += ['-threads', str(threads), '-fps_mode', 'passthrough']
            first_pass = None
            if compression and job['profile'].startswith('AV1'):
                first_pass = command + ['-pass','1','-passlogfile','size-pass','-an','-sn',
                                        '-progress','pipe:1','-nostats','-f','null',os.devnull]
                command += ['-pass','2','-passlogfile','size-pass']
            if kind == 'remux':
                if mux_audio == 'all':
                    command += ['-map', '0:a?', '-c:a', 'copy']
                elif mux_audio == 'selected' and info.get('audio'):
                    command += ['-map', '0:a:' + str(job['track']), '-c:a', 'copy']
            elif kind == 'video' and AUDIO[job['audio']] and info.get('audio'):
                audio_codec = {'mp4':'aac','webm':'libopus','mxf':'pcm_s24le'}.get(extension, AUDIO[job['audio']])
                command += ['-map', '0:a:' + str(job['track']), '-c:a', audio_codec]
                if compression and audio_codec == 'aac':
                    command += ['-b:a','160k']
                if extension == 'mxf':
                    command += ['-ar', '48000']
            if kind == 'remux' and job.get('copy_subtitles'):
                unsupported = {track['codec'] for track in info.get('subtitles', [])} - {
                    'mov_text', 'subrip', 'ass', 'ssa', 'webvtt', 'hdmv_pgs_subtitle', 'dvd_subtitle'
                }
                if unsupported:
                    raise ValueError('MKV 封装不支持以下源字幕编码：' + ', '.join(sorted(unsupported)))
                command += ['-map', '0:s?']
                for index, track in enumerate(info.get('subtitles', [])):
                    command += [f'-c:s:{index}', 'srt' if track['codec'] == 'mov_text' else 'copy']
            if mode == 'soft':
                index = len(info.get('subtitles', [])) if kind == 'remux' and job.get('copy_subtitles') else 0
                command += ['-map', '1:0', f'-c:s:{index}', {'mkv':'srt','webm':'webvtt'}.get(extension, 'mov_text')]
            movflags = []
            if extension == 'mp4':
                movflags.append('faststart')
            if (color or verify_spec) and extension in ('mp4', 'mov'):
                movflags.append('write_colr')
            if movflags:
                command += ['-movflags', ''.join('+' + flag for flag in movflags)]
            command += ['-progress', 'pipe:1', '-nostats', '-f', MUXER_NAMES.get(extension, extension), str(temporary)]
            if av2:
                # AVM consumes Y4M and writes an AV2 IVF stream. IVF carries video only.
                command[-3:] = ['-f','yuv4mpegpipe','input.y4m']
                command[command.index('-pix_fmt'):command.index('-pix_fmt')] = ['-strict','-1']
                first_pass = command
                command = [find_ffmpeg(self.root, 'avm'),'--ivf','--passes=1','--end-usage=q',
                           '--qp=160','--cpu-used=6',f'--bit-depth={av2_depth}',f'--input-bit-depth={av2_depth}',
                           f'--threads={threads}', '-o',str(temporary),'input.y4m']
            log = self.work_root / ('export-' + identifier + '.log')
            try:
                with log.open('wb') as diagnostics:
                    passes = [first_pass,command] if first_pass else [command]
                    for index,argv in enumerate(passes):
                        with self.lock:
                            if job['state'] == '取消中' or self.stopping:
                                job.update(state='已取消', message='已取消'); self._save(); return
                            process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                                       stderr=diagnostics, text=True, encoding='utf-8', errors='replace',
                                                       cwd=str(assets), **subprocess_kwargs())
                            self.processes[identifier] = process
                        duration = info.get('duration') or 0
                        for line in process.stdout:
                            key, _, value = line.strip().partition('=')
                            if key == 'speed':
                                try:
                                    speed = float(value.strip().removesuffix('x'))
                                except ValueError:
                                    continue
                                with self.lock:
                                    if job['state'] == '运行中' and 0 < speed < float('inf'):
                                        job['speed'] = speed
                                        progress = job.get('progress')
                                        if duration and isinstance(progress, (int, float)):
                                            job['eta'] = max(0, duration * (1 - progress / 100) * len(passes) / speed)
                            elif key == 'out_time_us' and duration:
                                try:
                                    progress = min(99, max(0, int((index + int(value) / 1_000_000 / duration) * 100 / len(passes))))
                                except ValueError:
                                    continue
                                with self.lock:
                                    if job['state'] == '运行中':
                                        job['progress'] = progress
                                        job['message'] = ('正在分析码率' if first_pass and not index else
                                                              '正在编码' if encode or kind == 'audio' else '正在封装')
                        code = process.wait()
                        if code:
                            break
                with self.lock:
                    self.processes.pop(identifier, None)
                    if self.stopping:
                        job.update(state='中断', message='程序关闭，任务已中断。'); self._save(); return
                    if job['state'] == '取消中':
                        job.update(state='已取消', message='已取消'); self._save(); return
                if code or not temporary.is_file() or not temporary.stat().st_size:
                    detail = log.read_text(encoding='utf-8', errors='replace')[-1200:]
                    error = HardwareEncodingError if hardware else ValueError
                    raise error('编码失败：' + (detail.strip() or '未生成有效输出。'))
                output_info = None
                if av2:
                    with temporary.open('rb') as stream:
                        header = stream.read(32)
                    if len(header) != 32 or header[:4] != b'DKIF' or header[8:12] != b'AV02':
                        raise ValueError('AV2 编码器没有生成有效的 IVF 文件。')
                    width, height, rate, scale, frames = struct.unpack_from('<HHIII',header,12)
                    if not (width and height and rate and scale):
                        raise ValueError('AV2 IVF 的分辨率或时间基无效。')
                    output_info = {'container':'ivf','duration':frames*scale/rate if frames else None,
                                   'video':{'codec':'av2','width':width,'height':height,'frame_rate':f'{rate}/{scale}',
                                            'pixel_format':EXTRA_PROFILES[job['profile']][1],'bit_depth':av2_depth},'audio':[],'subtitles':[]}
                if job['profile'] == 'H.266 / VVC 8-bit' and vvc:
                    output_info = self.probe(temporary)
                    video = output_info.get('video') or {}
                    if video.get('codec') != 'vvc' or video.get('bit_depth') != 8 or video.get('pixel_format') not in ('yuv420p','yuvj420p'):
                        raise ValueError('H.266 成片未通过 8-bit 4:2:0 规格检查。')
                if verify_spec:
                    try:
                        output_info = self.probe(temporary)
                    except (ValueError, OSError, subprocess.SubprocessError) as exc:
                        raise HardwareEncodingError('无法确认成片的规格。') from exc
                    verify_encoding(job['profile'],tags,output_info)
                with self.lock:
                    if job['state'] == '取消中' or self.stopping:
                        job.update(state='中断' if self.stopping else '已取消', message='已停止'); self._save(); return
                    job.update(state='正在完成', message='正在安全提交输出'); self._save()
                output = self._commit_output(job, temporary, dest, extension)
                if output is None:
                    return
                if output_info is None:
                    try:
                        output_info = self.probe(output)
                    except Exception:
                        output_info = None
                with self.lock:
                    job.update(state='已完成', progress=100, message='已导出', output=str(output),
                               source_info=info, output_info=output_info)
                    self._save()
            finally:
                with self.lock:
                    self.processes.pop(identifier, None)
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
                for name in ('caption.srt', 'caption.ass', 'canon.cube', 'size-pass-0.log','input.y4m'):
                    try:
                        (assets / name).unlink(missing_ok=True)
                    except OSError:
                        pass
                try:
                    assets.rmdir()
                except OSError:
                    pass

    def _commit_output(self, job, temporary, destination, extension):
        for number in range(10000):
            output = destination / (job['base'] + (f'_{number}' if number else '') + '.' + extension)
            try:
                if os.name == 'nt':
                    os.rename(temporary, output)
                else:
                    try:
                        os.link(temporary, output)
                    except OSError as exc:
                        # exFAT / FAT32 volumes on macOS do not support hard links (ENOTSUP / EPERM).
                        if isinstance(exc, FileExistsError):
                            raise
                        if output.exists():
                            raise FileExistsError(str(output))
                        os.rename(temporary, output)
                return output
            except FileExistsError:
                if job['collision'] == 'skip':
                    with self.lock:
                        job.update(state='已跳过', message='同名文件已存在。')
                        self._save()
                    return None
        raise ValueError('无法找到可用的输出文件名。')

    def _run_subtitles(self, job):
        with self.lock:
            if job['state'] != '排队' or self.stopping:
                return
            job.update(state='运行中', message='写入字幕')
            self._save()
        destination = Path(job['destination'])
        temporary = destination / ('.localpost-' + job['id'] + '-' + secrets.token_hex(4) + '.partial.srt')
        try:
            temporary.write_text(srt_text(job['subtitles']), encoding='utf-8', newline='\n')
            with self.lock:
                if self.stopping or job['state'] == '取消中':
                    job.update(state='中断' if self.stopping else '已取消', message='已停止')
                    self._save()
                    return
                job.update(state='正在完成', temporary=str(temporary))
                self._save()
            output = self._commit_output(job,temporary,destination,'srt')
            if output is not None:
                with self.lock:
                    job.update(state='已完成', progress=100, message='已导出', output=str(output))
                    self._save()
        finally:
            temporary.unlink(missing_ok=True)
