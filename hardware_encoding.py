"""Probe hardware encoders by encoding and inspecting a disposable sample."""
from functools import lru_cache
from pathlib import Path
import subprocess
import tempfile
import threading

from platform_mac import IS_MAC, data_root, find_ffmpeg, subprocess_kwargs


TAG_KEYS = ('primaries', 'transfer', 'matrix', 'range')
FLAG_KEYS = ('color_primaries', 'color_trc', 'colorspace', 'color_range')
MODES = ('auto', 'cpu', 'gpu')
HARDWARE_ENGINES = ('videotoolbox', 'qsv', 'nvenc', 'amf')
PROFILES = {
    'H.264 8-bit 4:2:0': ('h264', 'yuv420p'),
    'H.264 10-bit 4:2:2': ('h264', 'yuv422p10le'),
    'H.265 8-bit 4:2:0': ('hevc', 'yuv420p'),
    'H.265 10-bit 4:2:0': ('hevc', 'yuv420p10le'),
    'H.265 10-bit 4:2:2': ('hevc', 'yuv422p10le'),
    'AV1 10-bit': ('av1', 'yuv420p10le'),
    'AV1 8-bit': ('av1', 'yuv420p'),
    'AV1 10-bit 4:2:2': ('av1', 'yuv422p10le'),
}


class HardwareEncodingError(ValueError):
    pass


def output_tags(color, video):
    if color:
        transfer = {'Rec.709': 1, 'BT.2020 SDR': 14, 'sRGB': 13, 'Rec.2100 HLG': 18, 'Rec.2100 PQ': 16}
        wide = color['output'] == 'BT.2020'
        primaries = 9 if wide else 12 if color['output'] == 'Display P3' else 2 if color.get('direction') == 'to_log' else 1
        matrix = {'bt709': 1, 'bt2020': 9}.get(color.get('output_matrix'), 9 if wide else 1)
        return primaries, transfer.get(color['gamma'], 2), matrix, 2 if color.get('output_range') == 'full' else 1
    if video:
        values = []
        for name in TAG_KEYS:
            value = tag_number(video.get(name))
            values.append(value if value not in ((0,) if name == 'range' else (0, 2)) else None)
        return tuple(values)
    return (None,) * 4


def tag_number(value):
    value = str(value)
    return int(value) if value.isascii() and value.isdecimal() and len(value) <= 3 and int(value) <= 255 else None


def tag_flags(tags):
    return [item for name, value in zip(FLAG_KEYS, tags) if value is not None for item in ('-' + name, str(value))]


def tag_filter(tags):
    return 'setparams=' + ':'.join(
        f'{name}={value}' for name, value in zip(('color_primaries', 'color_trc', 'colorspace', 'range'), tags)
        if value is not None)


def encoder_args(profile, vendor, video=None):
    codec, expected = PROFILES[profile]
    depth = 10 if expected.endswith('10le') else 8
    is_422 = '422' in expected

    if vendor == 'videotoolbox':
        if codec == 'av1' or (codec == 'h264' and (depth == 10 or is_422)):
            return None
        pixel = 'yuv422p10le' if is_422 else 'p010le' if depth == 10 else 'nv12'
        profile_value = {
            'h264': 'high',
            'hevc': 'main42210' if is_422 else 'main10' if depth == 10 else 'main',
        }[codec]
        encoder = f'{codec}_videotoolbox'
        args = ['-c:v', encoder, '-pix_fmt', pixel, '-profile:v', profile_value, '-q:v', '65', '-allow_sw', '0']
        if codec == 'hevc':
            args += ['-tag:v', 'hvc1']
        return [], args, pixel

    if is_422 and (codec == 'av1' or vendor == 'amf' or (vendor == 'qsv' and codec == 'h264')):
        return None
    device = []
    pixel = ('y210le' if vendor == 'qsv' else 'p210le') if is_422 else 'p010le' if depth == 10 else 'nv12'
    profile_value = {'av1': 'main', 'hevc': 'rext' if is_422 else 'main10' if depth == 10 else 'main',
                     'h264': 'high422' if is_422 else 'high'}[codec]
    encoder = f'{codec}_{vendor}'
    args = ['-c:v', encoder, '-pix_fmt', pixel, '-profile:v', profile_value]
    if vendor == 'qsv':
        device = ['-init_hw_device', 'qsv=enc:hw_any,child_device_type=d3d11va', '-filter_hw_device', 'enc']
        args += ['-preset', 'medium', '-global_quality', '23', '-flags', '+qscale']
    elif vendor == 'nvenc':
        args += ['-preset', 'p4', '-rc', 'vbr', '-cq', '22', '-b:v', '0']
    else:
        video = video or {}
        pixels = (video.get('width') or 1920) * (video.get('height') or 1080)
        args += ['-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', str(max(400_000, round(8_000_000 * pixels / (1920 * 1080))))]
    if codec == 'hevc':
        args += ['-tag:v', 'hvc1']
    return device, args, pixel


def verify_encoding(profile, tags, info):
    codec, pixel = PROFILES[profile]
    actual = info.get('video') or {}
    decoder = actual.get('codec')
    actual_codec = {'libdav1d': 'av1', 'libaom-av1': 'av1'}.get(decoder, decoder)
    if actual_codec != codec or actual.get('pixel_format') != pixel:
        raise HardwareEncodingError('硬件输出编码或采样与所选档位不一致。')
    if any(value is not None and tag_number(actual.get(key)) != value for key, value in zip(TAG_KEYS, tags)):
        raise HardwareEncodingError('硬件输出色彩标记与所选设置不一致。')


class HardwareEncoderProbe:
    def __init__(self, root, probe):
        self.root, self.probe = root, probe
        self.work_root = data_root(root)
        self.ffmpeg = find_ffmpeg(root, 'ffmpeg')
        self.lock = threading.Lock()
        self.failed_devices = set()

    @lru_cache(maxsize=96)
    def _try(self, profile, vendor, tags):
        configuration = encoder_args(profile, vendor)
        if not configuration or vendor in self.failed_devices:
            return False
        device, options, pixel = configuration
        try:
            with tempfile.TemporaryDirectory(prefix='encode-check-', dir=self.work_root) as folder:
                sample = Path(folder) / 'probe.mp4'
                filters = [f'format={pixel}']
                if any(value is not None for value in tags):
                    filters.append(tag_filter(tags))
                result = subprocess.run(
                    [self.ffmpeg, '-hide_banner', '-v', 'error', '-nostdin', *device,
                     '-f', 'lavfi', '-i', 'testsrc2=size=320x192:rate=24', '-frames:v', '6', '-an',
                     '-vf', ','.join(filters), *options, *tag_flags(tags), '-movflags', '+write_colr', str(sample)],
                    capture_output=True, timeout=12, **subprocess_kwargs())
                if result.returncode:
                    message = result.stderr.lower()
                    if any(word in message for word in (b'cannot load nvcuda', b'cannot load nvencodeapi',
                                                       b'amfrt64.dll', b'no capable devices found')):
                        self.failed_devices.add(vendor)
                    return False
                verify_encoding(profile, tags, self.probe(sample))
                return True
        except (OSError, ValueError, subprocess.SubprocessError):
            return False

    def resolve(self, mode, profile, tags):
        if mode == 'cpu':
            return {'engine': 'cpu', 'reason': ''}
        if profile in PROFILES:
            candidates = ('videotoolbox',) if IS_MAC else ('qsv', 'nvenc', 'amf')
            with self.lock:
                for candidate in candidates:
                    if self._try(profile, candidate, tags):
                        return {'engine': candidate, 'reason': ''}
        reason = '所选规格未通过本机硬件编码测试' if profile in PROFILES else '所选档位使用 CPU 编码'
        return {'engine': 'cpu' if mode == 'auto' else None, 'reason': reason}
