# Static PSD inspection — 2026-09-21

This is a bounded, read-only binary inspection performed in the planning session. Photoshop was not launched or controlled. No package was installed. `psd_tools` and Pillow were unavailable in the default Python runtime; the inspection used Python's standard library and a read-only memory map. The original file was not changed. This is not live Photoshop qualification.

## Observed file identity and structure

| Property | Observed value |
|---|---|
| Source | `/Users/tsunanory/Downloads/мокап_готово.psd` |
| Bytes | `414738410` |
| SHA-256 | `1d14b685b6b9068f55e582c400b29429793f4c6eed8f761447163bbe5dd3bfcd` |
| Header | `8BPS`, PSD version 1, 1500 × 2000, depth 8, color-mode code 3 (RGB) |
| Outer layer records | 73, including group divider records; this is not 73 visible art layers |
| Raw clipped layer records | 11 |
| Named variant group records | `1 картинка` ID 1098; `2 картинка` ID 1128; `3 картинка` ID 1147 |
| Target candidate | `МЕНЯТЬ ЗДЕСЬ!`, ID 1153, record index 72, `PlLd` and `SoLd` tagged blocks |
| Target candidate raw bounds | left −364, top 428, right 1750, bottom 1972 |
| Repeated names | Includes `фон`, `Прямоугольник 4 копия`, `Прямоугольник 5 копия` |

IDs and names above describe this saved file only. They are not approved selectors and may change on reopening. Raw PSD layer-record bounds are stored as `top,left,bottom,right`; the inspection explicitly reorders output arrays to `[left,top,right,bottom]`.

Five internally parseable PSB header/layer-record candidates were found among seven `8BPS` signature hits:

| Byte offset from start | Canvas | Layer records |
|---|---|---|
| 279297348 | 2835 × 1104 | `Прямоугольник 5`; `Слой 1` |
| 301951000 | 2835 × 1063 | `Прямоугольник 4`; `Слой 1`; `Слой 2` |
| 335668228 | 2835 × 1063 | `Прямоугольник 4`; `Слой 1` |
| 358315676 | 3190 × 1418 | `Прямоугольник 3`; `Слой 4` |
| 372600144 | 2835 × 1104 | `Прямоугольник 5`; `Слой 1`; `Слой 2` |

The 3190 × 1418 PSB candidate has:

| Layer | Saved ID | Raw bounds `[left,top,right,bottom]` | Clipping byte | Relevant tags |
|---|---|---|---|---|
| `Прямоугольник 3` | 1080 | `[0,0,0,0]` | 0 | `SoCo`, `vmsk`, `vowv`, `vogk` |
| `Слой 4` | 1088 | `[0,-19,3190,1437]` | 1 | pixel-layer records, no `SoLd` observed |

The first layer has vector-shape metadata. Its zero raw pixel bounds do not prove an empty visible shape. Live effective bounds, vector mask and alpha behavior must be checked in Photoshop. Never substitute the 3190 × 1418 canvas rectangle for this reference's bounds. `Слой 4` is not proven to be an existing replaceable Smart Object placeholder; the observed records describe a pixel layer. A prepared copy may need conversion/replacement once, preserving the original file.

## Evidence boundary

Observed: header values, layer names/record IDs, raw bounds, clipping bytes, tagged-block names, and embedded PSB candidates above. These observations agree with several structural claims in the supplied report.

Unproven: the mapping from `МЕНЯТЬ ЗДЕСЬ!` to the 3190 × 1418 PSB; whether variant instances share one content resource; whether all relevant objects are embedded or some are externally linked; complete dependency closure; effective vector bounds; actual rendering; source color profile; visibility after ancestor composition; MCP capabilities and platform behavior. The parser does not decode `SoLd`/`PlLd` descriptors, link-resource records, vector paths or color profiles, nor raster pixels. Matching names or equal outer bounds is insufficient evidence of shared content. Finding embedded bytes does not rule out linked objects elsewhere.

Report-only claims: alisaitteke tool names/semantics, uniform-only scale API, licenses, update activity, DCC capabilities, Joonas capabilities and licensing status. No GitHub or npm claim was freshly verified in this inspection. The supplied report's citation tokens are not independently resolvable project evidence.

## Exact inspection command

The command below is the command used for the observations. It has no write operation. Header search is capped at 100 signature hits, layer counts at 10000, and parsed sections must remain within the mapped file. It is an inspection aid, not a production PSD reader.

```bash
python3 - <<'PY'
from pathlib import Path
import mmap, struct, json, hashlib
p=Path('/Users/tsunanory/Downloads/мокап_готово.psd')
with p.open('rb') as f:
 d=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)
 def u16(i): return struct.unpack_from('>H',d,i)[0]
 def u32(i): return struct.unpack_from('>I',d,i)[0]
 def u64(i): return struct.unpack_from('>Q',d,i)[0]
 def psd(base):
  v=u16(base+4); ch=u16(base+12); h=u32(base+14); w=u32(base+18); depth=u16(base+22); mode=u16(base+24)
  assert d[base:base+4]==b'8BPS' and v in (1,2) and d[base+6:base+12]==bytes(6) and 0<ch<57 and 0<w<300001 and 0<h<300001 and depth in (1,8,16,32) and mode<=9
  n=8 if v==2 else 4; size=lambda i:u64(i) if n==8 else u32(i)
  q=base+26; q+=4+u32(q); q+=4+u32(q); lm_start=q+n; lm_end=lm_start+size(q); assert lm_end<=len(d)
  q=lm_start; layer_len=size(q); q+=n; assert q+layer_len<=lm_end
  if not layer_len:return {'offset':base,'version':v,'width':w,'height':h,'depth':depth,'mode':mode,'layers':[]}
  count=abs(struct.unpack_from('>h',d,q)[0]);q+=2;assert count<10000
  layers=[]
  for idx in range(count):
   top,left,bottom,right=struct.unpack_from('>iiii',d,q);q+=16
   chans=u16(q);q+=2+chans*(2+n)
   assert d[q:q+4]==b'8BIM';q+=8
   opacity,clipping,flags=struct.unpack_from('>BBB',d,q);q+=4
   extra=u32(q);q+=4;end=q+extra
   q+=4+u32(q);q+=4+u32(q)
   namelen=d[q];name=d[q+1:q+1+namelen].decode('macroman');q+=(1+namelen+3)//4*4
   keys=[];lid=None;section=None
   while q+12<=end:
    sig=d[q:q+4];key=d[q+4:q+8].decode('ascii',errors='replace');q+=8
    size_len=8 if sig==b'8B64' or (v==2 and key in ('LMsk','Lr16','Lr32','Layr','Mt16','Mt32','Mtrn','Alph','FMsk','lnk2','FEid','FXid','PxSD')) else 4
    length=u64(q) if size_len==8 else u32(q);q+=size_len;start=q
    assert q+length<=end
    keys.append(key)
    if key=='luni': name=d[q+4:q+4+2*u32(q)].decode('utf-16-be')
    if key=='lyid': lid=u32(q)
    if key in ('lsct','lsdk'):section=u32(q)
    q=start+length+(length%2)
   q=end
   layers.append({'index':idx,'id':lid,'name':name,'bounds':[left,top,right,bottom],'clipping':clipping,'visible':not bool(flags&2),'section':section,'keys':keys})
  return {'offset':base,'version':v,'width':w,'height':h,'depth':depth,'mode':mode,'layerCount':count,'layerMaskEnd':lm_end,'layers':layers}
 outer=psd(0)
 print(json.dumps({'path':str(p),'bytes':len(d),'sha256':hashlib.file_digest(p.open('rb'),'sha256').hexdigest(),'header':{k:v for k,v in outer.items() if k!='layers'}},ensure_ascii=False))
 selected=[x for x in outer['layers'] if x['section'] in (1,2) or 'SoLd'in x['keys'] or 'SoLE'in x['keys'] or x['name'] in ('МЕНЯТЬ ЗДЕСЬ!','1 картинка','2 картинка','3 картинка')]
 print('SELECTED_LAYERS',json.dumps(selected,ensure_ascii=False))
 print('OUTER_CLIPPED_COUNT',sum(x['clipping']==1 for x in outer['layers']))
 pos=1;hits=0
 while hits<100:
  pos=d.find(b'8BPS',pos)
  if pos<0:break
  hits+=1
  try:
   item=psd(pos)
   if len(item['layers'])<20:print('EMBEDDED_CANDIDATE',json.dumps(item,ensure_ascii=False))
   else: print('EMBEDDED_CANDIDATE',json.dumps({k:v for k,v in item.items() if k!='layers'},ensure_ascii=False))
  except (AssertionError,struct.error,UnicodeError):pass
  pos+=4
 print('MAGIC_HITS',hits)
PY
```
