"""Shared UI/export catalog for technical, D65 colour conversions."""
import math
import re
import tempfile
from functools import lru_cache
from pathlib import Path
from platform_mac import data_root


def preset(id, group, gamut, curve, brand='', *, ready=True, note='', asset=None, output_only=False):
    return dict(id=id, group=group, gamut=gamut, curve=curve, brand=brand,
                input=ready and not output_only, output=ready and not asset, note=note, asset=asset)


PRESETS = {item['id']: item for item in [
    preset('canon3', 'log', 'Canon Cinema Gamut', 'Canon Log 3', 'Canon'),
    preset('sony-cine', 'log', 'S-Gamut3.Cine', 'S-Log3', 'Sony'),
    preset('sony-wide', 'log', 'S-Gamut3', 'S-Log3', 'Sony'),
    preset('nikon', 'log', 'BT.2020', 'N-Log', 'Nikon'),
    preset('nikon-red', 'log', 'REDWideGamutRGB', 'Log3G10', 'Nikon', note='适用于已解码为此色域与曲线的素材'),
    preset('lumix', 'log', 'V-Gamut', 'V-Log', 'LUMIX'),
    preset('fuji1', 'log', 'BT.2020', 'F-Log', 'Fujifilm'),
    preset('fuji2', 'log', 'BT.2020', 'F-Log2', 'Fujifilm'),
    preset('fuji2c', 'log', 'F-Gamut C', 'F-Log2', 'Fujifilm'),
    preset('dji', 'log', 'D-Gamut', 'D-Log', 'DJI'),
    preset('apple1', 'log', 'BT.2020', 'Apple Log', 'Apple'),
    preset('canon2', 'log', 'Canon Cinema Gamut', 'Canon Log 2', 'Canon'),
    preset('canon1', 'log', 'Canon Cinema Gamut', 'Canon Log', 'Canon'),
    preset('sony2','log','S-Gamut','S-Log2','Sony'),
    preset('sony1','log','S-Gamut','S-Log','Sony'),
    preset('dji-mavic3pro', 'log', 'Mavic 3 Pro（原机设置）', 'D-Log M', 'DJI',
           asset='dji-mavic3pro-dlogm.cube', note='厂商 LUT／仅输入 · Rec.709'),
    preset('dji-m', 'log', '其他机型', 'D-Log M', 'DJI', asset='user-dlogm.cube', note='导入对应机型的官方 Rec.709 LUT'),
    preset('insta', 'log', '其他机型', 'I-Log', 'Insta360', asset='user-insta-ilog.cube', note='导入对应机型的官方 Rec.709 LUT'),
    preset('insta-acepro2', 'log', 'Ace Pro 2', 'I-Log', 'Insta360', asset='insta-acepro2-ilog.cube', note='厂商 LUT／仅输入 · Rec.709'),
    preset('insta-x5', 'log', 'X5', 'I-Log', 'Insta360', asset='insta-x5-ilog.cube', note='厂商 LUT／仅输入 · Rec.709'),
    preset('insta-goultra', 'log', 'GO Ultra', 'I-Log', 'Insta360', asset='insta-goultra-ilog.cube', note='厂商 LUT／仅输入 · Rec.709'),
    preset('insta-luna','log','BT.2020','I-Log 10-bit','Insta360',note='Luna 系列，2026 白皮书曲线'),
    preset('gopro', 'log', '按机型及固件确认', 'GP-Log', 'GoPro', asset='user-gopro-gplog.cube', note='导入对应固件的官方 Rec.709 技术 LUT'),
    preset('gopro-hero12', 'log', 'HERO12 Black', 'GP-Log', 'GoPro',
           asset='user-gopro-hero12.cube', note='导入对应固件的官方 Rec.709 技术 LUT'),
    preset('gopro-hero13', 'log', 'HERO13 Black', 'GP-Log', 'GoPro',
           asset='user-gopro-hero13.cube', note='导入对应固件的官方 Rec.709 技术 LUT'),
    preset('gopro-max2', 'log', 'MAX2', 'GP-Log', 'GoPro',
           asset='user-gopro-max2.cube', note='导入对应固件的官方 Rec.709 技术 LUT'),
    preset('gopro2', 'log', 'BT.2020', 'GP-Log2', 'GoPro', note='Log₆₀₀ · GoPro Labs 参考曝光 +1.8 EV'),
    preset('apple2', 'log', 'Apple Wide Gamut', 'Apple Log 2', 'Apple'),
    preset('dji-pocket4p-dlog2', 'log', 'Osmo Pocket 4P', 'D-Log 2', 'DJI',
           asset='dji-pocket4p-dlog2.cube', note='厂商 LUT／仅输入 · Rec.709'),
    preset('dji-pocket4-dlog', 'log', 'Osmo Pocket 4', 'D-Log', 'DJI',
           asset='dji-pocket4-dlog.cube', note='厂商 LUT／仅输入 · Rec.709'),
    preset('dji-pocket4p-dlog', 'log', 'Osmo Pocket 4P', 'D-Log', 'DJI',
           asset='dji-pocket4p-dlog.cube', note='厂商 LUT／仅输入 · Rec.709'),
    preset('dji-mavic2-air2s', 'log', 'Mavic 2 Pro / Air 2S', 'D-Log M', 'DJI',
           asset='dji-mavic2-air2s-dlogm.cube', note='厂商 LUT／仅输入 · Rec.709'),
    preset('709', 'sdr', 'Rec.709', 'Rec.709'),
    preset('709-22', 'sdr', 'Rec.709', 'Gamma 2.2'),
    preset('709-24', 'sdr', 'Rec.709', 'Gamma 2.4'),
    preset('2020', 'sdr', 'BT.2020', 'BT.2020 SDR'),
    preset('p3', 'sdr', 'Display P3', 'sRGB'),
    preset('hlg', 'hdr', 'BT.2020', 'Rec.2100 HLG', output_only=True, note='参考白 75% 信号，超限裁切'),
    preset('pq', 'hdr', 'BT.2020', 'Rec.2100 PQ', output_only=True, note='参考白 203 nit，最高 1000 nit'),
]}
DJI_LUT_MODELS = {
    'mavic4pro':'Mavic 4 Pro', 'mini5pro':'Mini 5 Pro', 'lito-x1':'Lito X1', 'avata360':'Avata 360',
    'avata2':'Avata 2', 'flip':'Flip', 'mini4pro':'Mini 4 Pro', 'air3s':'Air 3S',
    'air3':'Air 3', 'o4':'O4 Air Unit Series', 'action6':'Osmo Action 6', 'nano':'Osmo Nano',
    'osmo360':'Osmo 360', 'action5pro':'Osmo Action 5 Pro', 'action4':'Osmo Action 4',
    'pocket3':'Osmo Pocket 3',
}
for key, model in DJI_LUT_MODELS.items():
    PRESETS['dji-'+key] = preset('dji-'+key,'log',model,'D-Log M','DJI',
                                asset='dji-'+key+'-dlogm.cube',note='厂商 LUT／仅输入 · Rec.709')
HDR_PROFILES = ('H.265 10-bit 4:2:0', 'H.265 10-bit 4:2:2', 'AV1 10-bit')

# D65 xy primaries, from the respective manufacturer specifications.
PRIMARIES = {
    'Rec.709': ((.64,.33),(.30,.60),(.15,.06)),
    'BT.2020': ((.708,.292),(.170,.797),(.131,.046)),
    'Canon Cinema Gamut': ((.74,.27),(.17,1.14),(.08,-.10)),
    'S-Gamut3.Cine': ((.766,.275),(.225,.800),(.089,-.087)),
    'S-Gamut3': ((.730,.280),(.140,.855),(.100,-.050)),
    'V-Gamut': ((.730,.280),(.165,.840),(.100,-.030)),
    'F-Gamut C': ((.73470,.26530),(.02630,.97370),(.11730,-.02240)),
    'D-Gamut': ((.71,.31),(.21,.88),(.09,-.08)),
    'S-Gamut': ((.730,.280),(.140,.855),(.100,-.050)),
    'Apple Wide Gamut': ((.725,.301),(.221,.814),(.068,-.076)),
    'REDWideGamutRGB': ((.780308,.304253),(.121595,1.493994),(.095612,-.084589)),
    'Display P3': ((.680,.320),(.265,.690),(.150,.060)),
}
WHITE_POINTS = dict.fromkeys(PRIMARIES, (.3127, .329))


def multiply(left, right):
    return tuple(tuple(sum(a*b for a,b in zip(row,col)) for col in zip(*right)) for row in left)


def white_xyz(xy):
    x, y = xy
    return (x/y, 1., (1-x-y)/y)


def inverse(matrix):
    def cross(a, b):
        return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
    a, b, c = matrix
    adjugate = tuple(zip(cross(b,c), cross(c,a), cross(a,b)))
    determinant = sum(x*y for x,y in zip(a, (row[0] for row in adjugate)))
    return tuple(tuple(x/determinant for x in row) for row in adjugate)


@lru_cache
def rgb_to_xyz(gamut):
    white = white_xyz(WHITE_POINTS[gamut])
    unscaled = tuple(zip(*[(x/y, 1, (1-x-y)/y) for x,y in PRIMARIES[gamut]]))
    factors = [sum(a*b for a,b in zip(row, white)) for row in inverse(unscaled)]
    return tuple(tuple(x*s for x,s in zip(row, factors)) for row in unscaled)


def conversion_matrix(source, target, adapt):
    left, right = inverse(rgb_to_xyz(target)), rgb_to_xyz(source)
    if adapt and WHITE_POINTS[source] != WHITE_POINTS[target]:
        bradford = ((.8951,.2664,-.1614),(-.7502,1.7135,.0367),(.0389,-.0685,1.0296))
        def cone(gamut):
            white = white_xyz(WHITE_POINTS[gamut])
            return [sum(a*b for a,b in zip(row,white)) for row in bradford]
        ratios = [dest/src for src,dest in zip(cone(source),cone(target))]
        adaptation = multiply(inverse(bradford), tuple(tuple(x*s for x in row) for s,row in zip(ratios,bradford)))
        right = multiply(adaptation,right)
    return multiply(left,right)


# Full-swing camera code / 1023. Limited-range expansion is undone once at the
# filter boundary, matching the existing Canon path and vendor code-value tables.
FUJI = {
    'F-Log': (.00089,.100537775223865,.555556,.009468,.344676,.790453,8.735631,.092864),
    'F-Log2': (.000889,.100686685370811,5.555556,.064829,.245281,.384316,8.799461,.092864),
}


def decode(curve, v):
    if curve == 'GP-Log2':
        return math.expm1(math.log(600)*v)/599 * 2**1.8
    if curve == 'Log3G10':
        return v/15.1927-.01 if v < 0 else (10**(v/.224282)-1)/155.975327-.01
    if curve in ('Canon Log','Canon Log 2'):
        a,b,c = (.45310179,10.1596,.12512248) if curve == 'Canon Log' else (.24136077,87.099375,.092864125)
        return .9*math.copysign((10**(abs(v-c)/a)-1)/b,v-c)
    if curve in ('S-Log','S-Log2'):
        value = (v*1023-64)/876
        black = .030001222851889303
        linear = (value-black)/5 if value < black else 10**((value-.646596)/.432699)-.037584
        return .9*linear*(219/155 if curve == 'S-Log2' else 1)
    if curve == 'I-Log 10-bit':
        return (v-.09055934)/5.77837328 if v < .154402 else 10**((v-.623992)/.280055)-.01
    if curve == 'Canon Log 3':
        if v < .097465473:
            return -.9 * (10**((.12783901-v)/.36726845)-1)/14.98325
        if v <= .15277891:
            return .9 * (v-.12512219)/1.9754798
        return .9 * (10**((v-.12240537)/.36726845)-1)/14.98325
    if curve == 'S-Log3':
        code = v*1023
        return (code-95)*.01125/(171.2102946929-95) if code < 171.2102946929 else .19*10**((code-420)/261.5)-.01
    if curve == 'V-Log':
        return (v-.125)/5.6 if v < .181 else 10**((v-.598206)/.241514)-.00873
    if curve == 'N-Log':
        code = v*1023
        return (code/650)**3-.0075 if code < 452 else math.exp((code-619)/150)
    if curve in FUJI:
        _, knee,a,b,c,d,e,f = FUJI[curve]
        return (v-f)/e if v < knee else (10**((v-d)/c)-b)/a
    if curve == 'D-Log':
        return (v-.0929)/6.025 if v <= .14 else (10**((v-.584555)/.256663)-.0108)/.9892
    if curve in ('Apple Log','Apple Log 2'):
        return math.sqrt(v/47.28711236)-.05641088 if v < .20855531595438031 else 2**((v-.69336945)/.08550479)-.00964052
    if curve == 'sRGB':
        return v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4
    if curve.startswith('Gamma '):
        return v**float(curve.split()[1])
    alpha, beta = (1.0992968268,.01805396851) if curve == 'BT.2020 SDR' else (1.099,.018)
    return v/4.5 if v < 4.5*beta else ((v+alpha-1)/alpha)**(1/.45)


def encode(curve, x):
    if curve == 'GP-Log2':
        return math.copysign(math.log1p(599*abs(x)/2**1.8)/math.log(600), x)
    if curve == 'Log3G10':
        shifted = x + .01
        return shifted*15.1927 if shifted < 0 else .224282*math.log10(1+155.975327*shifted)
    if curve in ('Canon Log','Canon Log 2'):
        a,b,c = (.45310179,10.1596,.12512248) if curve == 'Canon Log' else (.24136077,87.099375,.092864125)
        return c+math.copysign(a*math.log10(1+b*abs(x)/.9),x)
    if curve in ('S-Log','S-Log2'):
        value = (x/.9)*(155/219 if curve == 'S-Log2' else 1)
        signal = 5*value+.030001222851889303 if value < 0 else .432699*math.log10(value+.037584)+.646596
        return (64+876*signal)/1023
    if curve == 'I-Log 10-bit':
        return 5.77837328*x+.09055934 if x <= .01104854 else .623992+.280055*math.log10(x+.01)
    if curve == 'Canon Log 3':
        x /= .9
        if x < -.014:
            return .12783901-.36726845*math.log10(1-14.98325*x)
        if x <= .014:
            return 1.9754798*x+.12512219
        return .36726845*math.log10(1+14.98325*x)+.12240537
    if curve == 'S-Log3':
        return ((x*(171.2102946929-95)/.01125+95) if x < .01125 else
                420+261.5*math.log10((x+.01)/.19))/1023
    if curve == 'V-Log':
        return 5.6*x+.125 if x < .01 else .241514*math.log10(x+.00873)+.598206
    if curve == 'N-Log':
        return (650*math.copysign(abs(x+.0075)**(1/3),x+.0075) if x < .328 else 150*math.log(x)+619)/1023
    if curve in FUJI:
        knee,_,a,b,c,d,e,f = FUJI[curve]
        return e*x+f if x < knee else c*math.log10(a*x+b)+d
    if curve == 'D-Log':
        return 6.025*x+.0929 if x <= .0078 else .256663*math.log10(.9892*x+.0108)+.584555
    if curve in ('Apple Log','Apple Log 2'):
        if x < -.05641088:
            return 0
        return 47.28711236*(x+.05641088)**2 if x < .01 else .08550479*math.log2(x+.00964052)+.69336945
    if curve == 'Rec.2100 HLG':
        a,b,c = .17883277,.28466892,.55991073
        reference = (math.exp((.75-c)/a)+b)/12
        scene = min(1,max(0,x*reference))
        return math.sqrt(3*scene) if scene <= 1/12 else a*math.log(12*scene-b)+c
    if curve == 'Rec.2100 PQ':
        nits = min(1000,max(0,203*x))
        m1,m2,c1,c2,c3 = 2610/16384,2523/32,3424/4096,2413/128,2392/128
        l = (nits/10000)**m1
        return ((c1+c2*l)/(1+c3*l))**m2
    x = min(1.0,max(0.0,x))
    if curve == 'sRGB':
        return 12.92*x if x <= .0031308 else 1.055*x**(1/2.4)-.055
    if curve.startswith('Gamma '):
        return x**(1/float(curve.split()[1]))
    alpha,beta = (1.0992968268,.01805396851) if curve == 'BT.2020 SDR' else (1.099,.018)
    return 4.5*x if x < beta else alpha*x**.45-(alpha-1)


def vendor_asset(preset):
    name = preset.get('asset')
    if not name:
        return None
    writable = data_root(Path(__file__).resolve().parent) / 'color-luts' / name
    if writable.is_file():
        return writable
    bundled = Path(__file__).resolve().parent / 'work' / 'color-luts' / name
    if bundled.is_file():
        return bundled
    return writable


def public_presets():
    for item in PRESETS.values():
        path = vendor_asset(item)
        public = {k:v for k,v in item.items() if k != 'asset'}
        if path:
            public.update(input=path.is_file(), fixed_output='709', import_lut=not path.is_file())
        if item['group'] == 'hdr':
            public['profiles'] = HDR_PROFILES
        yield public


def install_vendor_lut(identifier, content):
    item = PRESETS.get(identifier) if isinstance(identifier, str) else None
    path = vendor_asset(item) if item else None
    if not path or not isinstance(content,str):
        raise ValueError('请选择可以导入厂商 LUT 的预设。')
    if path.is_file():
        raise ValueError('该预设已安装 LUT。')
    size = None
    domain, values = {}, []
    for line in content.lstrip('\ufeff').splitlines():
        text = line.partition('#')[0].strip()
        if not text or text.startswith('TITLE '):
            continue
        parts = text.split()
        key = parts[0]
        if key == 'LUT_3D_SIZE':
            if size is not None or len(parts)!=2 or not re.fullmatch(r'[0-9]{1,2}', parts[1]):
                raise ValueError('无效的 LUT 网格。')
            size = int(parts[1])
            if not 2 <= size <= 65:
                raise ValueError('仅支持不超过 65 格的 3D CUBE。')
        elif key == 'LUT_3D_INPUT_RANGE':
            if len(parts) != 3:
                raise ValueError('无效的 CUBE 输入域。')
            lo, hi = map(float,parts[1:])
            if not (math.isfinite(lo) and math.isfinite(hi)):
                raise ValueError('无效的 CUBE 输入域。')
            domain['DOMAIN_MIN'], domain['DOMAIN_MAX'] = (lo,)*3, (hi,)*3
        else:
            fields = parts[1:] if key in ('DOMAIN_MIN','DOMAIN_MAX') else parts
            triplet = tuple(float(x) for x in fields)
            if len(triplet)!=3 or not all(math.isfinite(x) and abs(x)<=100 for x in triplet):
                raise ValueError('无效的 CUBE 数值。')
            if key in ('DOMAIN_MIN','DOMAIN_MAX'):
                domain[key] = triplet
            else:
                values.append(triplet)
    if size is None or len(values)!=size**3 or any(
        a>=b for a,b in zip(domain.get('DOMAIN_MIN',(0,0,0)),domain.get('DOMAIN_MAX',(1,1,1)))
    ):
        raise ValueError('CUBE 的网格数据或输入域无效。')
    # Canonicalize text before handing it to the renderer.
    lines = [f'LUT_3D_SIZE {size}']
    lines.extend(key+' '+' '.join(map(str,triple)) for key,triple in domain.items())
    lines.extend(' '.join(f'{x:.9g}' for x in triple) for triple in values)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='ascii', dir=path.parent, delete=False) as file:
        staged = Path(file.name)
        try:
            file.write('\n'.join(lines)+'\n')
            file.close()
            staged.replace(path)
        finally:
            file.close()
            staged.unlink(missing_ok=True)


def validate_color(color):
    if not isinstance(color, dict):
        raise ValueError('请确认输入和输出色彩预设。')
    source, target = (PRESETS.get(color.get(key)) for key in ('input_id', 'output_id'))
    reverse = color.get('direction') == 'to_log'
    if not source or not target or not source['input'] or not target['output'] or (
        reverse and (source['group'], target['group']) != ('sdr','log')
    ) or (not reverse and target['group'] not in ('sdr','hdr')):
        raise ValueError('所选色彩转换尚不可用。')
    if color.get('range') not in ('limited','full') or color.get('matrix') not in ('bt709','bt2020'):
        raise ValueError('请确认输入电平和 YCbCr 矩阵。')
    if color.get('strategy', 'clip') not in ('clip','compress'):
        raise ValueError('此转换策略尚不可用。')
    if color.get('highlight', 'off') not in ('off','shoulder'):
        raise ValueError('高光映射无效。')
    tone = color.get('tone', 'legacy')
    ootf = color.get('ootf', 'off')
    adapt = color.get('white_adapt', True)
    if tone not in ('legacy','none','clip','simple','luminance','freeman') or ootf not in ('off','auto','forward','inverse') or type(adapt) is not bool:
        raise ValueError('色调映射、OOTF 或白点自适应设置无效。')
    if color.get('output_range', 'auto') not in ('auto','limited','full') or color.get('output_matrix', 'auto') not in ('auto','bt709','bt2020'):
        raise ValueError('输出电平或矩阵无效。')
    path = vendor_asset(source)
    if tone not in ('legacy','none') and (path or target['group'] != 'sdr'):
        raise ValueError('色调映射仅适用于计算转换到 SDR。')
    if path and ootf not in ('auto','off'):
        raise ValueError('厂商 LUT 不支持额外应用 OOTF。')
    if tone in ('simple','luminance','freeman'):
        input_peak, output_peak = (color.get(key, default) for key,default in
                                   (('input_peak',400),('output_peak',100)))
        if not all(type(p) in (int,float) and math.isfinite(p) and 1 <= p <= 10000 for p in (input_peak,output_peak)) or input_peak <= output_peak:
            raise ValueError('峰值须在 1–10000 尼特以内，且输入峰值须高于输出峰值。')
        if tone == 'freeman' and not 48 <= output_peak <= 100:
            raise ValueError('Freeman 曲线的 SDR 输出峰值须为 48–100 尼特。')
    if (path or target['group'] != 'sdr') and (
        color.get('strategy', 'clip') != 'clip' or color.get('highlight', 'off') != 'off'
    ):
        raise ValueError('色域压缩与高光映射仅适用于计算转换到 SDR。')
    if path and (target['id'] != '709' or not path.is_file()):
        raise ValueError('此机型的厂商 LUT 文件须存在，输出须选择 Rec.709 曲线。')
    return dict(color, gamut=source['gamut'], curve=source['curve'],
                output=target['gamut'], gamma=target['curve'])


def write_transform(path, color):
    source, target = (PRESETS[color[key]] for key in ('input_id','output_id'))
    vendor = vendor_asset(source)
    if vendor:
        path.write_bytes(vendor.read_bytes())
        return
    matrix = conversion_matrix(source['gamut'],target['gamut'],color.get('white_adapt',True))
    size = 65
    # GoPro Labs defines GP-Log2 on the decoded RGB signal rather than stored YCbCr code values.
    def source_value(i):
        value = i/(size-1)
        if source['group'] == 'log' and source['curve'] != 'GP-Log2' and color['range'] == 'limited':
            value = (64+876*value)/1023
        return decode(source['curve'], value)
    grid = [source_value(i) for i in range(size)]
    target_log = target['group'] == 'log'
    compress = color.get('strategy') == 'compress'
    tone = color.get('tone', 'legacy')
    shoulder = tone == 'legacy' and color.get('highlight') == 'shoulder'
    weights = rgb_to_xyz(target['gamut'])[1]
    ootf = color.get('ootf','off')
    if ootf == 'auto':
        ootf = 'forward' if (source['group'],target['group']) == ('log','sdr') else (
            'inverse' if (source['group'],target['group']) == ('sdr','log') else 'off')
    power = {'forward':.2,'inverse':1/1.2-1}.get(ootf)
    ratio = color.get('input_peak',400) / color.get('output_peak',100) if tone in ('simple','luminance') else 1.
    if tone == 'freeman':
        # Thatcher Freeman, DaVinci Tone Mapping.dctl, MIT. See tools/Freeman-DCTL-LICENSE.txt.
        # Adaptation is fixed at 9. Linear 1.0 represents 100 nits.
        input_white = color.get('input_peak',400) / 100.
        output_white = color.get('output_peak',100) / 100.
        white_ratio = input_white / output_white
        denominator_offset = (input_white - .09 * white_ratio) / (white_ratio - 1.)
        numerator_scale = output_white * (input_white+denominator_offset) / input_white

        def freeman_channel(value):
            # Limit negative RGB before evaluation to avoid the pole at -b.
            value = max(0., min(input_white,value))
            return numerator_scale * value / (value+denominator_offset)

    def rolloff(value):
        knee = .6
        if value <= knee:
            return value
        t = min(1., (value-knee)/(ratio-knee))
        shape = (ratio-knee)/(1-knee)-1
        return knee+(1-knee)*(1-(1-t)**(shape+1))

    legacy_weights = {'BT.2020':(.2627,.6780,.0593),'Display P3':(.229,.692,.079)}.get(target['gamut'],(.2126,.7152,.0722))
    def map_values(values):
        luminance = sum(a*b for a,b in zip(weights,values)) if power is not None or tone == 'luminance' else 0.
        if power is not None and luminance > 0:
            factor = luminance**power
            values = tuple(v*factor for v in values)
            luminance *= factor
        if tone == 'clip':
            values = tuple(min(1.,max(0.,v)) for v in values)
        elif tone == 'freeman':
            values = tuple(freeman_channel(v) for v in values)
        elif tone in ('simple','luminance'):
            level = max(values) if tone == 'simple' else luminance
            if level > 0:
                factor = rolloff(level)/level
                values = tuple(v*factor for v in values)
        if shoulder:
            peak = max(values)
            if peak > .75:
                mapped = .75 + .25 * (peak - .75) / (peak - .5)
                values = tuple(v * mapped / peak for v in values)
        if compress:
            anchor = min(1.,max(0.,sum(a*b for a,b in zip(legacy_weights,values))))
            factor = 1.
            for v in values:
                if v < 0: factor = min(factor, anchor / (anchor-v))
                elif v > 1: factor = min(factor, (1-anchor)/(v-anchor))
            values = tuple(anchor + factor*(v-anchor) for v in values)
        return values
    def channel(x):
        value = encode(target['curve'], x)
        if target_log and target['curve'] != 'GP-Log2':
            value = (value*1023-64)/876
        return min(1.0,max(0.0,value))
    with path.open('w', encoding='ascii') as out:
        out.write(f'LUT_3D_SIZE {size}\n')
        for b in grid:
            for g in grid:
                for r in grid:
                    rgb = tuple(a*r+c*g+d*b for a,c,d in matrix)
                    values = (channel(v) for v in (map_values(rgb) if compress or shoulder or power is not None or tone in ('clip','simple','luminance','freeman') else rgb))
                    out.write(' '.join(f'{v:.8f}' for v in values)+'\n')
