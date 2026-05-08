#!/usr/bin/env python3
# gen_target_arch.py  —  Jarvis Target Architecture SVG
# Apple iWork palette · Chinese narrative + English tech terms
# Orthogonal arrow routing only (polyline, no bezier)

W, H = 1200, 780

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

def card(cx, y, l1, l2, col, cw=120, ch=42, rx=7):
    c = COL[col]
    x = cx - cw // 2
    s  = R(x, y, cw, ch, rx, '#FFFFFF', c['stroke'], 1.3, 'filter="url(#s1)"')
    s += T(cx, y+15, l1, 10, '600', c['text'])
    s += T(cx, y+29, l2, 8.5, '400', '#3A3A3C')
    return s

def vcol_cards(cx, y0, items, col, cw=120, ch=42, gap=10):
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
lines.append(T(W//2, 28, 'Jarvis 目标系统架构', 15, '700', '#1D1D1F'))
lines.append(T(W//2, 47, 'Personal Memory System · v2 Roadmap · 结构化记忆 + 多模型调度', 10.5, '400', '#8E8E93'))

# ══════════════════════════════════════════════
# LAYOUT CONSTANTS
# 5 zones, widths chosen so MEM zone is wider (6-node 2-col grid)
# ZX:  36   190  328  480  742
# ZW:  150  134  148  258  420
# ZCX: 111  257  402  609  952
# ══════════════════════════════════════════════
ZX  = [36,  190, 328, 480, 742]
ZW  = [150, 134, 148, 258, 420]
ZCX = [ZX[i] + ZW[i]//2 for i in range(5)]  # 111 257 402 609 952

# TOP LANE  y=58..134
TY = 58; TH = 76
lines.append(R(20, TY, 1160, TH, 10, '#FFFFFF', '#D2D2D7', 1, 'filter="url(#s1)"'))
lines.append(T(38, TY+15, '同步请求路径  Sync Request Path', 8, '700', '#8E8E93', 'start', 'letter-spacing="0.6"'))

top_nodes = [
    (ZCX[0], '客户端应用', 'Client Apps',    'client'),
    (ZCX[1], '对话网关',   'Gateway API',    'gateway'),
    (ZCX[2], '核心回复',   'Core Reply',     'core'),
    (ZCX[3], '记忆装配',   'Context Packet', 'memory'),
    (ZCX[4], '主模型调用', 'Primary Model',  'model'),
]
NW, NH = 130, 40
NY = TY + 18
for cx, l1, l2, col in top_nodes:
    c = COL[col]
    lines.append(R(cx-NW//2, NY, NW, NH, 7, c['bg'], c['stroke'], 1.5, 'filter="url(#s1)"'))
    lines.append(T(cx, NY+15, l1, 10, '600', c['text']))
    lines.append(T(cx, NY+29, l2, 8.5, '400', '#3A3A3C'))

AY = NY + NH // 2
for i in range(4):
    x1 = top_nodes[i][0] + NW//2
    x2 = top_nodes[i+1][0] - NW//2
    col = top_nodes[i][3]
    lines.append(hline(x1, AY, x2, col))

# ── SYSTEM CONTAINER  y=144..634 ──
PY = 144; PH = 490
lines.append(R(20, PY, 1160, PH, 12, '#FAFAFA', '#D2D2D7', 1.2, 'filter="url(#s2)"'))
lines.append(T(38, PY+16, 'SYSTEM', 8, '700', '#6E6E73', 'start', 'letter-spacing="1.8"'))

ZY = PY + 24
ZH = PH - 34   # 456

zone_meta = [
    ('client',  '输入表面层'),
    ('gateway', '对话网关层'),
    ('core',    '核心系统层'),
    ('memory',  '记忆后端层'),
    ('model',   '模型与存储层'),
]
for i, (col, label) in enumerate(zone_meta):
    c = COL[col]
    lines.append(R(ZX[i], ZY, ZW[i], ZH, 10, c['bg'], c['stroke'], 1.4, 'filter="url(#s1)"'))
    lines.append(T(ZCX[i], ZY+14, label, 7.5, '700', c['stroke'], 'middle', 'letter-spacing="0.5"'))

# ─── ZONE 1: 输入表面层 ───
CW1 = ZW[0] - 16; CX1 = ZCX[0]
z1_items = [
    ('Jarvis iPhone',     'SwiftUI · SSE 流式'),
    ('Jarvis macOS',      'SwiftUI · 状态恢复'),
    ('图像 / 位置输入',   'Image · Location · OCR'),
]
lines.append(vcol_cards(CX1, ZY+24, z1_items, 'client', CW1, 42))

# ─── ZONE 2: 对话网关层 ───
CW2 = ZW[1] - 14; CX2 = ZCX[1]
z2_items = [
    ('HTTP Gateway',  'Auth · 限流 · 路由'),
    ('Reply Request', '对话入口 · 参数'),
    ('Session Mgr',   '会话状态 · SSE'),
]
lines.append(vcol_cards(CX2, ZY+24, z2_items, 'gateway', CW2, 42))

GW_CY   = ZY + 24 + 21        # HTTP Gateway center-y
SESS_CY = ZY + 24 + 2*52 + 21 # Session Mgr center-y

# ─── ZONE 3: 核心系统层 ───
CW3 = ZW[2] - 14; CX3 = ZCX[2]
z3_items = [
    ('Reply Agent',    '编排 · 工具调用'),
    ('Context Packet', '事实 · 历史装配'),
    ('Model Router',   '多模型调度 · 回退'),
]
lines.append(vcol_cards(CX3, ZY+24, z3_items, 'core', CW3, 42))

AGENT_CY   = ZY + 24 + 21
CTX_CY     = ZY + 24 + 52 + 21
ROUTER_CY  = ZY + 24 + 2*52 + 21

# ─── ZONE 4: 记忆后端层  (2-col × 3-row grid) ───
MZ = ZX[3]; MW = ZW[3]; MCX = ZCX[3]
MCW = (MW - 24) // 2    # each col card width ≈ 117
MCX_L = MZ + 8 + MCW//2          # left col center
MCX_R = MZ + 8 + MCW + 8 + MCW//2  # right col center
M_Y0 = ZY + 24

mem_left  = [('Raw Log',     '原始对话记录'), ('Fact Triage',  '事实分级粗筛'), ('Fact Extract', '精细事实抽取')]
mem_right = [('Reflection',  '每日反思沉淀'), ('User Profile', '用户画像更新'), ('Retrieval Asm','召回装配器')]

for i, (l1, l2) in enumerate(mem_left):
    yi = M_Y0 + i * 52
    lines.append(card(MCX_L, yi, l1, l2, 'memory', MCW, 42))
    if i < 2:
        sc = COL['memory']['stroke']
        lines.append(f'<line x1="{MCX_L}" y1="{yi+42}" x2="{MCX_L}" y2="{yi+52}" stroke="{sc}" stroke-width="1.1" marker-end="url(#arr-memory)"/>')

for i, (l1, l2) in enumerate(mem_right):
    yi = M_Y0 + i * 52
    lines.append(card(MCX_R, yi, l1, l2, 'memory', MCW, 42))
    if i < 2:
        sc = COL['memory']['stroke']
        lines.append(f'<line x1="{MCX_R}" y1="{yi+42}" x2="{MCX_R}" y2="{yi+52}" stroke="{sc}" stroke-width="1.1" marker-end="url(#arr-memory)"/>')

# Row-0: Raw Log -> Reflection
lines.append(hline(MCX_L + MCW//2, M_Y0+21, MCX_R - MCW//2, 'memory'))
# Row-2: Fact Extract -> Retrieval Asm
lines.append(hline(MCX_L + MCW//2, M_Y0+2*52+21, MCX_R - MCW//2, 'memory'))

RAWLOG_CY  = M_Y0 + 21
RETR_ASM_CY = M_Y0 + 2*52 + 21  # Retrieval Asm center-y (right col row-2)

# ─── ZONE 5: 模型与存储层 ───
MO_X = ZX[4]; MO_W = ZW[4]; MO_CX = ZCX[4]
HC = (MO_W - 20) // 2    # half-col card width ≈ 200
HCX_L = MO_X + 10 + HC//2            # left half center
HCX_R = MO_X + 10 + HC + 8 + HC//2  # right half center

# Primary Reply Model — full-width prominent card
PR_Y = ZY + 24
lines.append(R(MO_X+10, PR_Y, MO_W-20, 52, 8, COL['model']['bg'], COL['model']['stroke'], 1.5, 'filter="url(#s1)"'))
lines.append(T(MO_CX, PR_Y+18, '主回复模型  Primary Reply Model', 11, '700', COL['model']['text']))
lines.append(T(MO_CX, PR_Y+34, 'GPT-4o / Claude-3.5 · 上下文 8K · Function Calling', 8.5, '400', '#3A3A3C'))

PR_CY = PR_Y + 26

# Left col: Support + Embedding
SR_Y = PR_Y + 62
lines.append(card(HCX_L, SR_Y, 'Support Model', '摘要 · 分类 · 标注', 'model', HC, 44))
EM_Y = SR_Y + 54
lines.append(card(HCX_L, EM_Y, 'Embedding Model', '向量化 · 语义检索', 'model', HC, 44))
sc_m = COL['model']['stroke']
lines.append(f'<line x1="{HCX_L}" y1="{SR_Y+44}" x2="{HCX_L}" y2="{EM_Y}" stroke="{sc_m}" stroke-width="1.1" marker-end="url(#arr-model)"/>')

# Right col: PostgreSQL + Vector + Object Storage
PG_Y = PR_Y + 62
lines.append(card(HCX_R, PG_Y, 'PostgreSQL', '结构化事实 · 用户画像', 'data', HC, 44))
VEC_Y = PG_Y + 54
lines.append(card(HCX_R, VEC_Y, 'Vector Store', 'pgvector · 语义索引', 'data', HC, 44))
OBJ_Y = VEC_Y + 54
lines.append(card(HCX_R, OBJ_Y, 'Object Storage', '媒体 · 附件 · 快照', 'data', HC, 44))
sc_d = COL['data']['stroke']
lines.append(f'<line x1="{HCX_R}" y1="{PG_Y+44}" x2="{HCX_R}" y2="{VEC_Y}" stroke="{sc_d}" stroke-width="1.1" marker-end="url(#arr-data)"/>')
lines.append(f'<line x1="{HCX_R}" y1="{VEC_Y+44}" x2="{HCX_R}" y2="{OBJ_Y}" stroke="{sc_d}" stroke-width="1.1" marker-end="url(#arr-data)"/>')

# Embedding -> Vector Store
lines.append(hline(HCX_L + HC//2, EM_Y+22, HCX_R - HC//2, 'model'))

EM_CY = EM_Y + 22

# ══════════════════════════════════════════════
# CROSS-ZONE CONNECTIONS  (orthogonal polylines)
# ══════════════════════════════════════════════
G12 = (ZX[0]+ZW[0] + ZX[1]) // 2    # 171
G23 = (ZX[1]+ZW[1] + ZX[2]) // 2    # 259
G34 = (ZX[2]+ZW[2] + ZX[3]) // 2    # 454
G45 = (ZX[3]+ZW[3] + ZX[4]) // 2    # 718

# 1. iPhone (right) → HTTP Gateway (left)
INP_R = CX1 + CW1//2
lines.append(poly([(INP_R, ZY+24+21), (G12, ZY+24+21), (G12, GW_CY), (CX2-CW2//2, GW_CY)], 'client'))

# 2. Session Mgr (right) → Reply Agent (left)
lines.append(poly([(CX2+CW2//2, SESS_CY), (G23, SESS_CY), (G23, AGENT_CY), (CX3-CW3//2, AGENT_CY)], 'gateway'))

# 3. Context Packet (right) → Raw Log (left)  [store turn]
CTX_R = CX3 + CW3//2
lines.append(poly([(CTX_R, CTX_CY), (G34, CTX_CY), (G34, RAWLOG_CY), (MCX_L-MCW//2, RAWLOG_CY)], 'core'))

# 4. Context Packet (right) → Retrieval Asm (right col)  [pull context]
lines.append(poly([(CTX_R, CTX_CY+6), (G34+6, CTX_CY+6), (G34+6, RETR_ASM_CY), (MCX_R-MCW//2, RETR_ASM_CY)], 'core'))

# 5. Retrieval Asm (right) → Context Packet (right of core)  [return context, dashed]
# Route via top corridor above zones
TOP_BUS = ZY - 8
lines.append(poly([(MCX_R+MCW//2, RETR_ASM_CY), (G34+12, RETR_ASM_CY), (G34+12, TOP_BUS), (CTX_R+6, TOP_BUS), (CTX_R+6, CTX_CY+12)], 'memory'))

# 6. Model Router (right) → Primary Reply Model (left, via corridor above zone)
ROUTER_R = CX3 + CW3//2
TOP_BUS2 = ZY - 18
PR_LEFT = MO_X + 10
lines.append(poly([(ROUTER_R, ROUTER_CY), (G45, ROUTER_CY), (G45, TOP_BUS2), (PR_LEFT, TOP_BUS2), (PR_LEFT, PR_CY)], 'model'))

# 7. Embedding → pgvector  (already connected via hline inside zone 5)
# Extra: Embedding Model → Retrieval Asm assist (dashed)
lines.append(poly([(HCX_L - HC//2, EM_CY), (G45-6, EM_CY), (G45-6, RETR_ASM_CY+8), (MCX_R+MCW//2, RETR_ASM_CY+8)], 'model', dashed=True))

# ── BOTTOM LANE  y=648..716
BY = PY + PH + 10
BH = 68
lines.append(R(20, BY, 1160, BH, 10, '#FFFFFF', '#D2D2D7', 1, 'filter="url(#s1)"'))
lines.append(T(38, BY+14, '异步记忆管道  Async Memory Pipeline', 8, '700', '#8E8E93', 'start', 'letter-spacing="0.6"'))

bot_nodes = [
    (ZCX[1],     'Turn Extract',   '事实 · 事件 · 情感抽取', 'memory'),
    (ZCX[2],     'Daily Reflect',  '每日开放问题沉淀',       'memory'),
    (ZCX[3],     'Profile Update', '用户画像增量更新',       'memory'),
    (ZCX[4]-80,  'Vector Index',   'pgvector 嵌入写入',     'model'),
]
BNW, BNH = 128, 40
BNY = BY + 17
for bx, bl1, bl2, bcol in bot_nodes:
    c = COL[bcol]
    lines.append(R(bx-BNW//2, BNY, BNW, BNH, 7, c['bg'], c['stroke'], 1.3, 'filter="url(#s1)"'))
    lines.append(T(bx, BNY+14, bl1, 10, '600', c['text']))
    lines.append(T(bx, BNY+27, bl2, 8.5, '400', '#3A3A3C'))
for i in range(3):
    lines.append(hline(bot_nodes[i][0]+BNW//2, BNY+BNH//2, bot_nodes[i+1][0]-BNW//2, bot_nodes[i][3]))

# Connector: Fact Triage (left col row-1) → Turn Extract bottom (dashed)
FT_L = MCX_L - MCW//2
FT_CY = M_Y0 + 52 + 21
BCOR_Y = BY - 5
B0_X = bot_nodes[0][0]
lines.append(poly([(FT_L, FT_CY), (FT_L-6, FT_CY), (FT_L-6, BCOR_Y), (B0_X, BCOR_Y), (B0_X, BNY)], 'memory', dashed=True))

# ── LEGEND ──────────────────────────────────────
LX = 980; LY = BY + 8
lines.append(R(LX, LY, 196, 56, 8, '#FFFFFF', '#D2D2D7', 1))
lines.append(T(LX+12, LY+13, 'LEGEND', 7.5, '700', '#6E6E73', 'start', 'letter-spacing="0.8"'))
lines.append(f'<line x1="{LX+12}" y1="{LY+26}" x2="{LX+38}" y2="{LY+26}" stroke="#8E8E93" stroke-width="1.6" marker-end="url(#arr-gray)"/>')
lines.append(T(LX+44, LY+29, '同步数据流', 8, '400', '#3A3A3C', 'start'))
lines.append(f'<line x1="{LX+12}" y1="{LY+44}" x2="{LX+38}" y2="{LY+44}" stroke="{COL["model"]["stroke"]}" stroke-width="1.4" stroke-dasharray="4,2" marker-end="url(#arr-model)"/>')
lines.append(T(LX+44, LY+47, '模型辅助 / 异步写入', 8, '400', '#3A3A3C', 'start'))

lines.append('</svg>')

out_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'image/jarvis-target-architecture.svg'
content = '\n'.join(lines)
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'Wrote {len(content)} bytes to {out_path}')
