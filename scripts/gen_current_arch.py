#!/usr/bin/env python3
# gen_current_arch.py  —  Jarvis Current Architecture SVG
# Apple iWork palette · Chinese narrative + English tech terms
# Orthogonal arrow routing only (polyline, no bezier)

W, H = 1080, 720

COL = {
    'client':  {'bg': '#EAF2FF', 'stroke': '#007AFF', 'text': '#007AFF'},
    'gateway': {'bg': '#E8F7FF', 'stroke': '#5AC8FA', 'text': '#5AC8FA'},
    'core':    {'bg': '#F3EEFF', 'stroke': '#BF5AF2', 'text': '#BF5AF2'},
    'memory':  {'bg': '#FFF4E5', 'stroke': '#FF9F0A', 'text': '#FF9F0A'},
    'data':    {'bg': '#E9F9EE', 'stroke': '#30D158', 'text': '#30D158'},
    'ops':     {'bg': '#FFF1F0', 'stroke': '#FF453A', 'text': '#FF453A'},
    'model':   {'bg': '#EDE8FF', 'stroke': '#5856D6', 'text': '#5856D6'},
}

def R(x,y,w,h,rx=8,fill='#FFFFFF',stroke='#C7C7CC',sw=1.2,extra=''):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>'

def T(x,y,s,size=10,weight='400',fill='#1D1D1F',anchor='middle',extra=''):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" font-weight="{weight}" fill="{fill}" {extra}>{s}</text>'

def card(cx, y, l1, l2, col, cw=128, ch=40, rx=7):
    c = COL[col]
    x = cx - cw // 2
    s  = R(x, y, cw, ch, rx, '#FFFFFF', c['stroke'], 1.3, 'filter="url(#s1)"')
    s += T(cx, y+15, l1, 10, '600', c['text'])
    s += T(cx, y+29, l2, 8.5, '400', '#3A3A3C')
    return s

def vcol_cards(cx, y0, items, col, cw=128, ch=40, gap=10):
    """Draw vertical column of cards with downward arrows between them."""
    out = ''
    for i, (l1, l2) in enumerate(items):
        yi = y0 + i * (ch + gap)
        out += card(cx, yi, l1, l2, col, cw, ch)
        if i < len(items) - 1:
            ay1 = yi + ch
            ay2 = yi + ch + gap
            sc = COL[col]['stroke']
            mid = f'arr-{col}'
            out += f'<line x1="{cx}" y1="{ay1}" x2="{cx}" y2="{ay2}" stroke="{sc}" stroke-width="1.2" marker-end="url(#{mid})"/>'
    return out

def poly(pts, col, dashed=False):
    sc = COL[col]['stroke']
    mid = f'arr-{col}'
    dash = 'stroke-dasharray="5,3"' if dashed else ''
    p = ' '.join(f'{x},{y}' for x,y in pts)
    return f'<polyline points="{p}" stroke="{sc}" stroke-width="1.4" fill="none" {dash} marker-end="url(#{mid})"/>'

def hline(x1, y, x2, col, dashed=False):
    sc = COL[col]['stroke']
    mid = f'arr-{col}'
    dash = 'stroke-dasharray="5,3"' if dashed else ''
    return f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{sc}" stroke-width="1.4" {dash} marker-end="url(#{mid})"/>'

lines = []

# ── DEFS ──────────────────────────────────────
lines.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="\'SF Pro Display\',\'SF Pro Text\',\'Helvetica Neue\',Arial,sans-serif">')
lines.append('<defs>')
for cid, col_hex in [('client','#007AFF'),('gateway','#5AC8FA'),('core','#BF5AF2'),
                      ('memory','#FF9F0A'),('data','#30D158'),('ops','#FF453A'),
                      ('model','#5856D6'),('gray','#8E8E93')]:
    lines.append(f'<marker id="arr-{cid}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="{col_hex}"/></marker>')
lines.append('<filter id="s1"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#00000012"/></filter>')
lines.append('<filter id="s2"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#00000018"/></filter>')
lines.append('</defs>')

# Background
lines.append(R(0, 0, W, H, 0, '#F5F5F7', 'none', 0))

# Title
lines.append(T(W//2, 28, 'Jarvis 当前系统架构', 14, '700', '#1D1D1F'))
lines.append(T(W//2, 46, 'Personal Memory System · v1 Production · 自托管部署', 10, '400', '#8E8E93'))

# ══════════════════════════════════════════════
# LAYOUT CONSTANTS
# 5 zones, each zone center-x = top-lane node center-x
# Zone layout (x, width, center):
#   Z1 CLIENT:   x=36,  w=152, cx=112
#   Z2 GATEWAY:  x=200, w=116, cx=258
#   Z3 CORE:     x=328, w=228, cx=442  (has 2 sub-zones)
#   Z4 DATA:     x=568, w=188, cx=662
#   Z5 OPS:      x=768, w=276, cx=906
# ══════════════════════════════════════════════
ZX = [36,  200, 328, 568, 768]
ZW = [152, 116, 228, 188, 276]
ZCX = [ZX[i] + ZW[i]//2 for i in range(5)]  # [112, 258, 442, 662, 906]

# TOP LANE  y=58..130
TY = 58; TH = 72
lines.append(R(20, TY, 1040, TH, 10, '#FFFFFF', '#D2D2D7', 1, 'filter="url(#s1)"'))
lines.append(T(38, TY+15, '同步请求路径  Sync Request Path', 8, '700', '#8E8E93', 'start', 'letter-spacing="0.6"'))

top_nodes = [
    (ZCX[0], '客户端应用', 'Client Apps',   'client'),
    (ZCX[1], '对话网关',   'Gateway API',   'gateway'),
    (ZCX[2], '核心回复',   'Core Reply',    'core'),
    (ZCX[3], '状态持久化', 'State Write',   'data'),
]
NW, NH = 126, 38
NY = TY + 17
for cx, l1, l2, col in top_nodes:
    c = COL[col]
    lines.append(R(cx-NW//2, NY, NW, NH, 7, c['bg'], c['stroke'], 1.5, 'filter="url(#s1)"'))
    lines.append(T(cx, NY+14, l1, 10, '600', c['text']))
    lines.append(T(cx, NY+28, l2, 8.5, '400', '#3A3A3C'))

AY = NY + NH // 2  # arrow y through top lane
for i in range(3):
    x1 = top_nodes[i][0] + NW//2
    x2 = top_nodes[i+1][0] - NW//2
    col = top_nodes[i][3]
    lines.append(hline(x1, AY, x2, col))

# ── PLATFORM CONTAINER  y=140..604 ──
PY = 140; PH = 462
lines.append(R(20, PY, 1040, PH, 12, '#FAFAFA', '#D2D2D7', 1.2, 'filter="url(#s2)"'))
lines.append(T(38, PY+16, 'PLATFORM', 8, '700', '#6E6E73', 'start', 'letter-spacing="1.6"'))

ZY = PY + 24        # zone top y
ZH = PH - 34        # zone height  448

zone_meta = [
    ('client',  '本地客户端层'),
    ('gateway', '对话网关层'),
    ('core',    '核心编排层'),
    ('data',    '持久化层'),
    ('ops',     '部署运维层'),
]
for i, (col, label) in enumerate(zone_meta):
    c = COL[col]
    lines.append(R(ZX[i], ZY, ZW[i], ZH, 10, c['bg'], c['stroke'], 1.4, 'filter="url(#s1)"'))
    lines.append(T(ZCX[i], ZY+14, label, 7.5, '700', c['stroke'], 'middle', 'letter-spacing="0.5"'))

# ─── ZONE 1: 本地客户端层 ───
CW1 = ZW[0] - 18; CX1 = ZCX[0]
z1_items = [
    ('Jarvis iPhone',  'SwiftUI · SSE 流式'),
    ('Jarvis macOS',   'SwiftUI · 状态恢复'),
    ('本地缓存 Cache', ' 离线 UI · 恢复'),
]
lines.append(vcol_cards(CX1, ZY+24, z1_items, 'client', CW1, 40, 10))

# ─── ZONE 2: 对话网关层 ───
CW2 = ZW[1] - 14; CX2 = ZCX[1]
z2_items = [
    ('HTTP Server',  'API · Auth · 限流'),
    ('State Sync',   'CRUD · SSE · 恢复'),
]
lines.append(vcol_cards(CX2, ZY+24, z2_items, 'gateway', CW2, 40, 10))

# ─── ZONE 3: 核心编排层 (两个 sub-zone 并排) ───
# Sub-A 对话循环  x=336, w=100, cx=386
# Sub-B 记忆信号  x=448, w=100, cx=498
# (ZX[2]=328, ZW[2]=228 → inner 8px margin each side)
SA_X = ZX[2] + 8;  SA_W = 102; SA_CX = SA_X + SA_W//2   # 337+51=388
SB_X = SA_X + SA_W + 8; SB_W = ZW[2] - 18 - SA_W - 8
SB_CX = SB_X + SB_W//2

SZ_Y = ZY + 22; SZ_H = ZH - 30

# sub-zone backgrounds
lines.append(R(SA_X, SZ_Y, SA_W, SZ_H, 8, '#FFFFFF', COL['core']['stroke'], 1, 'filter="url(#s1)"'))
lines.append(T(SA_CX, SZ_Y+12, '对话循环', 7.5, '700', COL['core']['stroke']))

lines.append(R(SB_X, SZ_Y, SB_W, SZ_H, 8, '#FFFFFF', COL['memory']['stroke'], 1, 'filter="url(#s1)"'))
lines.append(T(SB_CX, SZ_Y+12, '记忆信号', 7.5, '700', COL['memory']['text']))

# sub-zone A cards
SA_CW = SA_W - 12
for i, (l1, l2, col) in enumerate([
    ('Chat Service',    '解析 · 回复编排', 'core'),
    ('Model Provider',  'LLM · 回退策略', 'core'),
]):
    yi = SZ_Y + 22 + i * 50
    lines.append(card(SA_CX, yi, l1, l2, col, SA_CW, 38))
    if i == 0:
        sc = COL['core']['stroke']
        lines.append(f'<line x1="{SA_CX}" y1="{yi+38}" x2="{SA_CX}" y2="{yi+50}" stroke="{sc}" stroke-width="1.1" marker-end="url(#arr-core)"/>')

CHAT_Y = SZ_Y + 22   # Chat Service top
CHAT_CY = CHAT_Y + 19  # Chat Service center-y
MP_Y = SZ_Y + 72    # Model Provider top
MP_CY = MP_Y + 19

# sub-zone B cards
SB_CW = SB_W - 12
mem_items = [
    ('Retrieval Builder', '事实 · 历史召回', 'memory'),
    ('Turn Extraction',   '事实 · 事件抽取', 'memory'),
    ('Daily Reflection',  '开放问题沉淀',   'memory'),
]
for i, (l1, l2, col) in enumerate(mem_items):
    yi = SZ_Y + 22 + i * 50
    lines.append(card(SB_CX, yi, l1, l2, col, SB_CW, 38))
    if i < 2:
        sc = COL['memory']['stroke']
        lines.append(f'<line x1="{SB_CX}" y1="{yi+38}" x2="{SB_CX}" y2="{yi+50}" stroke="{sc}" stroke-width="1.1" marker-end="url(#arr-memory)"/>')

RET_Y = SZ_Y + 22; RET_CY = RET_Y + 19
EXT_Y = SZ_Y + 72; EXT_CY = EXT_Y + 19
REF_Y = SZ_Y + 122; REF_CY = REF_Y + 19

# ─── ZONE 4: 持久化层 ───
CW4 = ZW[3] - 14; CX4 = ZCX[3]
z4_items = [
    ('SQLite Memory DB', '消息 · 事实 · 日志'),
    ('Core Tables',      'Schema · Indexes'),
]
lines.append(vcol_cards(CX4, ZY+24, z4_items, 'data', CW4, 50, 10))
SQL_CY = ZY + 24 + 25   # SQLite center-y

# ─── ZONE 5: 部署运维层 ───
CW5 = ZW[4] - 16; CX5 = ZCX[4]
z5_items = [
    ('Cloud Host',       '云端 / DigitalOcean'),
    ('Caddy HTTPS',      'Ingress · TLS · 反向代理'),
    ('Docker Compose',   '运行时 · 服务编排'),
    ('Backup / Restore', 'SQLite · 安全备份'),
    ('Model Endpoint',   'OpenAI-compatible API'),
]
for i, (l1, l2) in enumerate(z5_items):
    yi = ZY + 24 + i * 50
    lines.append(card(CX5, yi, l1, l2, 'ops', CW5, 40))
    if i < 3:  # Cloud -> Caddy -> Docker (not Backup -> ME)
        sc = COL['ops']['stroke']
        lines.append(f'<line x1="{CX5}" y1="{yi+40}" x2="{CX5}" y2="{yi+50}" stroke="{sc}" stroke-width="1" marker-end="url(#arr-ops)"/>')

BACKUP_CY = ZY + 24 + 3*50 + 20   # Backup center-y
ME_CY = ZY + 24 + 4*50 + 20       # Model Endpoint center-y

# ══════════════════════════════════════════════
# CROSS-ZONE CONNECTIONS  (orthogonal polylines)
# routing corridors: vertical corridors between zones at x = ZX[n]+ZW[n]+n*gap
# ══════════════════════════════════════════════

# gap corridors (x midpoints between zones)
G12 = (ZX[0]+ZW[0] + ZX[1]) // 2       # between Z1 and Z2  ≈ 188
G23 = (ZX[1]+ZW[1] + ZX[2]) // 2       # between Z2 and Z3  ≈ 264
G34 = (ZX[2]+ZW[2] + ZX[3]) // 2       # between Z3 and Z4  ≈ 548
G45 = (ZX[3]+ZW[3] + ZX[4]) // 2       # between Z4 and Z5  ≈ 753

# 1. Local Cache (right) → HTTP Server (left)  [Z1→Z2]
LC_RIGHT = CX1 + CW1//2
LC_CY    = ZY + 24 + 2*50 + 20   # Local Cache center-y (3rd card)
HTTP_LEFT = CX2 - CW2//2
HTTP_CY   = ZY + 24 + 20          # HTTP Server center-y
lines.append(poly([(LC_RIGHT, LC_CY), (G12, LC_CY), (G12, HTTP_CY), (HTTP_LEFT, HTTP_CY)], 'client'))

# 2. State Sync (right) → Chat Service (left of sub-A)  [Z2→Z3]
SS_RIGHT = CX2 + CW2//2
SS_CY    = ZY + 24 + 50 + 20   # State Sync center-y
CHAT_LEFT = SA_X + 6
lines.append(poly([(SS_RIGHT, SS_CY), (G23, SS_CY), (G23, CHAT_CY), (CHAT_LEFT, CHAT_CY)], 'gateway'))

# 3. Chat Service (right) → Retrieval Builder (left of sub-B)  [SA→SB, internal]
CHAT_RIGHT = SA_X + SA_W - 6
RET_LEFT = SB_X + 6
lines.append(poly([(CHAT_RIGHT, CHAT_CY), (CHAT_RIGHT+6, CHAT_CY), (CHAT_RIGHT+6, RET_CY), (RET_LEFT, RET_CY)], 'core'))

# 4. Chat Service → Turn Extraction (Core signals extraction trigger)
EXT_LEFT = SB_X + 6
lines.append(poly([(CHAT_RIGHT, CHAT_CY+8), (CHAT_RIGHT+10, CHAT_CY+8), (CHAT_RIGHT+10, EXT_CY), (EXT_LEFT, EXT_CY)], 'core'))

# 5. Retrieval Builder (right) → SQLite DB (left)  [Z3→Z4]
RET_RIGHT = SB_X + SB_W - 6
DATA_LEFT = CX4 - CW4//2
lines.append(poly([(RET_RIGHT, RET_CY), (G34, RET_CY), (G34, SQL_CY), (DATA_LEFT, SQL_CY)], 'memory'))

# 6. Turn Extraction (right) → SQLite DB (left)  [Z3→Z4]
lines.append(poly([(RET_RIGHT, EXT_CY), (G34+5, EXT_CY), (G34+5, SQL_CY+6), (DATA_LEFT, SQL_CY+6)], 'memory'))

# 7. Daily Reflection (right) → SQLite DB (left)  [Z3→Z4]
lines.append(poly([(RET_RIGHT, REF_CY), (G34+10, REF_CY), (G34+10, SQL_CY+12), (DATA_LEFT, SQL_CY+12)], 'memory'))

# 8. Model Provider (right) → Model Endpoint (left, via bottom bus)  [Z3→Z5, dashed]
MP_RIGHT = SA_X + SA_W - 6
BOT_BUS = ZY + ZH - 10   # routing channel at bottom of zones
ME_LEFT = CX5 - CW5//2
lines.append(poly([(MP_RIGHT, MP_CY), (G34-10, MP_CY), (G34-10, BOT_BUS), (G45, BOT_BUS), (G45, ME_CY), (ME_LEFT, ME_CY)], 'ops', dashed=True))

# 9. Backup (left) → SQLite DB (right)  [Z5→Z4, dashed]
BACKUP_LEFT = CX5 - CW5//2
DATA_RIGHT  = CX4 + CW4//2
lines.append(poly([(BACKUP_LEFT, BACKUP_CY), (DATA_RIGHT+4, BACKUP_CY), (DATA_RIGHT+4, SQL_CY+18)], 'ops', dashed=True))

# ── BOTTOM LANE  y=614..682
BY = PY + PH + 10
BH = 68
lines.append(R(20, BY, 1040, BH, 10, '#FFFFFF', '#D2D2D7', 1, 'filter="url(#s1)"'))
lines.append(T(38, BY+14, '异步记忆管道  Async Memory Pipeline', 8, '700', '#8E8E93', 'start', 'letter-spacing="0.6"'))

bot_nodes = [
    (ZCX[2]-30, 'Turn Extract',   '事实 · 事件',   'memory'),
    (ZCX[3],    'Daily Reflect',  '开放问题沉淀',  'memory'),
    (ZCX[4]-60, 'SQLite Memory',  '写入 · 索引',   'data'),
]
BNW, BNH = 122, 38
BNY = BY + 17
for bx, bl1, bl2, bcol in bot_nodes:
    c = COL[bcol]
    lines.append(R(bx-BNW//2, BNY, BNW, BNH, 7, c['bg'], c['stroke'], 1.3, 'filter="url(#s1)"'))
    lines.append(T(bx, BNY+14, bl1, 10, '600', c['text']))
    lines.append(T(bx, BNY+27, bl2, 8.5, '400', '#3A3A3C'))

for i in range(2):
    x1 = bot_nodes[i][0] + BNW//2
    x2 = bot_nodes[i+1][0] - BNW//2
    col = bot_nodes[i][3]
    lines.append(hline(x1, BNY+BNH//2, x2, col))

# connector: Ext Zone → Turn Extract bottom node (dashed, via bottom of zone)
EXT_BOT = SZ_Y + 22 + 50 + 38   # bottom of Turn Extraction card
B0_TOP = BNY
B0_X = bot_nodes[0][0]
COR_Y = BY - 5
lines.append(poly([(RET_RIGHT, EXT_CY+10), (RET_RIGHT+8, EXT_CY+10), (RET_RIGHT+8, COR_Y), (B0_X, COR_Y), (B0_X, B0_TOP)], 'memory', dashed=True))

# ── LEGEND ──────────────────────────────────────
LX = 830; LY = BY + 8
lines.append(R(LX, LY, 226, 56, 8, '#FFFFFF', '#D2D2D7', 1))
lines.append(T(LX+12, LY+13, 'LEGEND', 7.5, '700', '#6E6E73', 'start', 'letter-spacing="0.8"'))
lines.append(f'<line x1="{LX+12}" y1="{LY+26}" x2="{LX+38}" y2="{LY+26}" stroke="#8E8E93" stroke-width="1.6" marker-end="url(#arr-gray)"/>')
lines.append(T(LX+44, LY+29, '同步数据流', 8, '400', '#3A3A3C', 'start'))
lines.append(f'<line x1="{LX+12}" y1="{LY+44}" x2="{LX+38}" y2="{LY+44}" stroke="{COL["ops"]["stroke"]}" stroke-width="1.4" stroke-dasharray="4,2" marker-end="url(#arr-ops)"/>')
lines.append(T(LX+44, LY+47, '外部 API / 异步写入', 8, '400', '#3A3A3C', 'start'))

lines.append('</svg>')

out_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'image/jarvis-current-architecture.svg'
content = '\n'.join(lines)
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'Wrote {len(content)} bytes to {out_path}')
