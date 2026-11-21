"""Cross-platform and macOS-native runtime helpers for Local Post Studio."""
from functools import lru_cache
import ctypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading

IS_MAC = sys.platform == 'darwin'
IS_WINDOWS = os.name == 'nt'

_resource_lock = threading.Lock()
_previous_cpu = None


def bootstrap_pydeps(app_root: Path | None = None) -> None:
    """Allow isolated (-I) Python workers inside a relocatable macOS .app bundle to load bundled packages."""
    candidates = []
    env_deps = os.environ.get('LOCAL_POST_PYDEPS')
    if env_deps:
        candidates.append(Path(env_deps))
    if app_root is not None:
        candidates.append(app_root / 'pydeps')
        candidates.append(app_root.parent / 'pydeps')
    for candidate in candidates:
        if candidate.is_dir():
            text = str(candidate)
            if text not in sys.path:
                sys.path.insert(0, text)


def data_root(app_root: Path) -> Path:
    """Return writable data root (work dir). Uses Application Support when inside a macOS .app bundle."""
    override = os.environ.get('LOCAL_POST_DATA_DIR')
    if override:
        path = Path(override).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path
    if IS_MAC and '.app/Contents/' in str(app_root.resolve()):
        path = Path.home() / 'Library' / 'Application Support' / 'Local Post Studio'
        path.mkdir(parents=True, exist_ok=True)
        return path
    path = app_root / 'work'
    path.mkdir(parents=True, exist_ok=True)
    return path


def subprocess_kwargs(**extra) -> dict:
    """Add CREATE_NO_WINDOW only on Windows; omit on macOS/Linux."""
    kwargs = dict(extra)
    if IS_WINDOWS and hasattr(subprocess, 'CREATE_NO_WINDOW'):
        kwargs.setdefault('creationflags', subprocess.CREATE_NO_WINDOW)
    return kwargs


def _executable_name(base: str) -> str:
    return base + '.exe' if IS_WINDOWS else base


def find_ffmpeg(app_root: Path, variant: str = 'ffmpeg') -> str:
    """Locate ffmpeg / vvc-ffmpeg / avmenc across bundled tools and system paths."""
    if variant == 'ffmpeg':
        env = os.environ.get('LOCAL_POST_FFMPEG')
        if env and Path(env).is_file():
            return env
        bundled = app_root / 'tools' / 'ffmpeg' / _executable_name('ffmpeg')
        if bundled.is_file():
            return str(bundled)
        for candidate in (
            shutil.which('ffmpeg'),
            '/opt/homebrew/bin/ffmpeg',
            '/usr/local/bin/ffmpeg',
        ):
            if candidate and Path(candidate).is_file():
                return candidate
        try:
            import imageio_ffmpeg
            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            return str(bundled)

    if variant == 'vvc':
        bundled = app_root / 'tools' / 'vvc' / _executable_name('ffmpeg')
        if bundled.is_file():
            return str(bundled)
        # Main ffmpeg build on macOS may already include libvvenc.
        return find_ffmpeg(app_root, 'ffmpeg')

    if variant == 'avm':
        bundled = app_root / 'tools' / 'avm' / _executable_name('avmenc')
        if bundled.is_file():
            return str(bundled)
        for candidate in (
            shutil.which('avmenc'),
            '/opt/homebrew/bin/avmenc',
            '/usr/local/bin/avmenc',
        ):
            if candidate and Path(candidate).is_file():
                return candidate
        return str(bundled)

    raise ValueError(f'Unknown tool variant: {variant}')


def default_caption_font() -> str:
    if IS_MAC:
        return 'PingFang SC'
    if IS_WINDOWS:
        return 'Microsoft YaHei'
    return 'Noto Sans CJK SC'


@lru_cache(maxsize=1)
def caption_font_names() -> list[str]:
    """Return installed system font family names."""
    if IS_MAC:
        names = _macos_coretext_fonts()
        if names:
            return names
        return _scan_font_files()
    if IS_WINDOWS:
        powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
        script = ("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "
                  "Add-Type -AssemblyName System.Drawing; "
                  "$fonts=New-Object System.Drawing.Text.InstalledFontCollection; "
                  "try { foreach ($family in $fonts.Families) { $family.Name } } finally { $fonts.Dispose() }")
        result = subprocess.run(
            [str(powershell), '-NoProfile', '-NonInteractive', '-Command', script],
            capture_output=True, text=True, encoding='utf-8', timeout=8,
            check=True, **subprocess_kwargs(),
        )
        return sorted(
            {name for name in result.stdout.splitlines() if name and len(name) <= 120 and ',' not in name},
            key=str.casefold,
        )
    return _scan_font_files()


def _macos_coretext_fonts() -> list[str]:
    try:
        ct = ctypes.CDLL('/System/Library/Frameworks/CoreText.framework/CoreText')
        cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        ct.CTFontManagerCopyAvailableFontFamilyNames.restype = ctypes.c_void_p
        cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
        cf.CFArrayGetCount.restype = ctypes.c_long
        cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
        cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
        cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
        cf.CFStringGetCString.restype = ctypes.c_bool
        cf.CFRelease.argtypes = [ctypes.c_void_p]

        arr = ct.CTFontManagerCopyAvailableFontFamilyNames()
        if not arr:
            return []
        try:
            count = cf.CFArrayGetCount(arr)
            buf = ctypes.create_string_buffer(512)
            names = set()
            kCFStringEncodingUTF8 = 0x08000100
            for index in range(count):
                cf_str = cf.CFArrayGetValueAtIndex(arr, index)
                if cf_str and cf.CFStringGetCString(cf_str, buf, 512, kCFStringEncodingUTF8):
                    name = buf.value.decode('utf-8', errors='ignore').strip()
                    if name and not name.startswith('.') and len(name) <= 120 and ',' not in name:
                        names.add(name)
            return sorted(names, key=str.casefold)
        finally:
            cf.CFRelease(arr)
    except Exception:
        return []


def _scan_font_files() -> list[str]:
    fc_list = shutil.which('fc-list')
    if fc_list:
        try:
            res = subprocess.run([fc_list, ':', 'family'], capture_output=True, text=True, encoding='utf-8', timeout=8)
            if res.returncode == 0:
                names = set()
                for line in res.stdout.splitlines():
                    for part in line.split(','):
                        name = part.strip()
                        if name and len(name) <= 120:
                            names.add(name)
                if names:
                    return sorted(names, key=str.casefold)
        except Exception:
            pass
    return ['PingFang SC', 'Hiragino Sans GB', 'Helvetica Neue', 'SF Pro Text'] if IS_MAC else []


def system_usage() -> dict:
    """Return {'cpu': int|None, 'memory': int|None} percentages."""
    if IS_MAC:
        return _macos_system_usage()
    if IS_WINDOWS:
        return _windows_system_usage()
    return {'cpu': None, 'memory': None}


def _macos_system_usage() -> dict:
    global _previous_cpu
    with _resource_lock:
        try:
            libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
            libc.mach_host_self.restype = ctypes.c_uint32
            host = libc.mach_host_self()

            class HostCpuLoadInfo(ctypes.Structure):
                _fields_ = [('cpu_ticks', ctypes.c_uint32 * 4)]

            cpu_info = HostCpuLoadInfo()
            count = ctypes.c_uint32(4)
            cpu = None
            # HOST_CPU_LOAD_INFO = 3; ticks order: USER=0, SYSTEM=1, IDLE=2, NICE=3
            if libc.host_statistics(host, 3, ctypes.byref(cpu_info), ctypes.byref(count)) == 0:
                ticks = tuple(int(x) for x in cpu_info.cpu_ticks)
                if _previous_cpu is not None:
                    deltas = [(cur - prev) & 0xFFFFFFFF for cur, prev in zip(ticks, _previous_cpu)]
                    total = sum(deltas)
                    if total > 0:
                        cpu = min(100, max(0, round(100 * (1 - deltas[2] / total))))
                _previous_cpu = ticks

            memsize = ctypes.c_uint64(0)
            pagesize = ctypes.c_uint64(0)
            size_t = ctypes.c_size_t(8)
            memory = None
            if (
                libc.sysctlbyname(b'hw.memsize', ctypes.byref(memsize), ctypes.byref(size_t), None, 0) == 0
                and libc.sysctlbyname(b'hw.pagesize', ctypes.byref(pagesize), ctypes.byref(size_t), None, 0) == 0
                and memsize.value > 0
            ):
                class VMStatistics64(ctypes.Structure):
                    _fields_ = [
                        ('free_count', ctypes.c_uint32),
                        ('active_count', ctypes.c_uint32),
                        ('inactive_count', ctypes.c_uint32),
                        ('wire_count', ctypes.c_uint32),
                        ('zero_fill_count', ctypes.c_uint64),
                        ('reactivations', ctypes.c_uint64),
                        ('pageins', ctypes.c_uint64),
                        ('pageouts', ctypes.c_uint64),
                        ('faults', ctypes.c_uint64),
                        ('cow_faults', ctypes.c_uint64),
                        ('lookups', ctypes.c_uint64),
                        ('hits', ctypes.c_uint64),
                        ('purges', ctypes.c_uint64),
                        ('purgeable_count', ctypes.c_uint32),
                        ('speculative_count', ctypes.c_uint32),
                        ('decompressions', ctypes.c_uint64),
                        ('compressions', ctypes.c_uint64),
                        ('swapins', ctypes.c_uint64),
                        ('swapouts', ctypes.c_uint64),
                        ('compressor_page_count', ctypes.c_uint32),
                        ('throttled_count', ctypes.c_uint32),
                        ('external_page_count', ctypes.c_uint32),
                        ('internal_page_count', ctypes.c_uint32),
                        ('total_uncompressed_pages_in_compressor', ctypes.c_uint64),
                    ]

                vm = VMStatistics64()
                vm_count = ctypes.c_uint32(ctypes.sizeof(vm) // 4)
                # HOST_VM_INFO64 = 4
                if libc.host_statistics64(host, 4, ctypes.byref(vm), ctypes.byref(vm_count)) == 0:
                    used_pages = max(0, vm.internal_page_count + vm.wire_count + vm.compressor_page_count - vm.purgeable_count)
                    memory = min(100, max(0, round(100 * (used_pages * pagesize.value) / memsize.value)))
            return {'cpu': cpu, 'memory': memory}
        except Exception:
            return {'cpu': None, 'memory': None}


def _windows_system_usage() -> dict:
    global _previous_cpu
    from ctypes import wintypes

    class MemoryStatus(ctypes.Structure):
        _fields_ = [('length', wintypes.DWORD), ('load', wintypes.DWORD)] + [
            (name, ctypes.c_ulonglong) for name in (
                'total_phys', 'avail_phys', 'total_page', 'avail_page',
                'total_virtual', 'avail_virtual', 'avail_extended_virtual')
        ]

    with _resource_lock:
        kernel = ctypes.windll.kernel32
        idle, system, user = (wintypes.FILETIME() for _ in range(3))
        cpu = None
        if kernel.GetSystemTimes(ctypes.byref(idle), ctypes.byref(system), ctypes.byref(user)):
            idle_ticks, system_ticks, user_ticks = [
                (value.dwHighDateTime << 32) | value.dwLowDateTime for value in (idle, system, user)
            ]
            total = system_ticks + user_ticks
            if _previous_cpu and total > _previous_cpu[0]:
                cpu = round(100 * (1 - (idle_ticks - _previous_cpu[1]) / (total - _previous_cpu[0])))
                cpu = min(100, max(0, cpu))
            _previous_cpu = (total, idle_ticks)
        memory = MemoryStatus()
        memory.length = ctypes.sizeof(memory)
        load = memory.load if kernel.GlobalMemoryStatusEx(ctypes.byref(memory)) else None
        return {'cpu': cpu, 'memory': load}
