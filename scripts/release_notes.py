#!/usr/bin/env python3
"""Generate release notes JPEGs — light theme, mobile portrait (1080×1920)."""

from PIL import Image, ImageDraw, ImageFont
import os

# ── Dimensions ────────────────────────────────────────────────────────────────
W, H = 1080, 1920
PAD  = 52   # horizontal margin

# ── Light palette ─────────────────────────────────────────────────────────────
BG       = (248, 250, 252)   # near-white background
WHITE    = (255, 255, 255)
CARD     = (255, 255, 255)
INK      = (22,  30,  46)    # near-black text
INK2     = (90, 105, 130)    # secondary text
DIVIDER  = (220, 228, 238)
TEAL     = (26,  122, 110)   # primary brand teal
TEAL_LT  = (42,  168, 151)
TEAL_BG  = (230, 246, 243)   # very light teal fill
BLUE     = (49,  110, 200)
BLUE_BG  = (230, 239, 255)
AMBER    = (195, 120,  20)
AMBER_BG = (255, 243, 220)
PURPLE   = (110,  65, 175)
PURPLE_BG= (240, 232, 255)
GREEN    = (36,  150,  90)
GREEN_BG = (224, 247, 234)
RED      = (200,  55,  55)
RED_BG   = (255, 232, 232)
GOLD     = (200, 150,  20)

# ── Fonts ─────────────────────────────────────────────────────────────────────
SANS   = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
SANS_B = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'

def f(size, bold=False):
    path = SANS_B if bold else SANS
    try:    return ImageFont.truetype(path, size)
    except: return ImageFont.load_default()

# ── Helpers ───────────────────────────────────────────────────────────────────
def tw(draw, text, font):
    bb = draw.textbbox((0,0), text, font=font)
    return bb[2]-bb[0]

def th(draw, text, font):
    bb = draw.textbbox((0,0), text, font=font)
    return bb[3]-bb[1]

def rr(draw, xy, fill, r=16, outline=None, ow=2):
    draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=ow)

def hline(draw, x1, x2, y, col=DIVIDER, w=2):
    draw.line([(x1,y),(x2,y)], fill=col, width=w)

def centered(draw, y, text, font, col=INK):
    x = (W - tw(draw,text,font))//2
    draw.text((x,y), text, font=font, fill=col)

def gradient_v(img, y1, y2, top_col, bot_col):
    draw = ImageDraw.Draw(img)
    for y in range(y1, y2):
        t = (y-y1)/(y2-y1)
        r = int(top_col[0]+(bot_col[0]-top_col[0])*t)
        g = int(top_col[1]+(bot_col[1]-top_col[1])*t)
        b = int(top_col[2]+(bot_col[2]-top_col[2])*t)
        draw.line([(0,y),(W,y)], fill=(r,g,b))

def make_base():
    img = Image.new('RGB', (W,H), BG)
    return img, ImageDraw.Draw(img)

# ── Shared header & footer ────────────────────────────────────────────────────
def draw_header(img, draw, eyebrow, title):
    # Teal-to-white gradient top zone
    gradient_v(img, 0, 200, (26,122,110), (230,246,243))
    gradient_v(img, 200, 240, (230,246,243), BG)
    draw = ImageDraw.Draw(img)
    # App name
    draw.text((PAD, 44), 'GOINGS ON', font=f(28,True), fill=WHITE)
    draw.text((PAD, 80), 'Philadelphia', font=f(22), fill=(200,240,234))
    # Eyebrow + title
    ew = tw(draw, eyebrow, f(22))
    draw.text((W-PAD-ew, 52), eyebrow, font=f(22), fill=(200,240,234))
    draw.text((PAD, 134), title, font=f(56,True), fill=WHITE)
    return draw

def draw_footer(draw, page, total=3):
    fy = H - 80
    hline(draw, PAD, W-PAD, fy, DIVIDER)
    draw.text((PAD, fy+18), 'RELEASE NOTES · JUNE 2026', font=f(22), fill=INK2)
    pg = f'{page} of {total}'
    pw = tw(draw, pg, f(22))
    draw.text((W-PAD-pw, fy+18), pg, font=f(22), fill=INK2)
    # dots
    for i in range(total):
        cx = W//2 + (i - total//2)*24
        cy = H - 32
        col = TEAL if i+1==page else DIVIDER
        draw.ellipse([cx-7,cy-7,cx+7,cy+7], fill=col)

# ── Feature row helper (icon badge + title + subtitle) ────────────────────────
def feature_row(draw, x, y, badge_text, badge_bg, badge_fg, title, subtitle, title_f=None, sub_f=None):
    tf = title_f or f(30, True)
    sf = sub_f   or f(24)
    # badge circle
    cx, cy, r = x+28, y+28, 26
    draw.ellipse([cx-r,cy-r,cx+r,cy+r], fill=badge_bg)
    btw = tw(draw, badge_text, f(24,True))
    draw.text((cx-btw//2, cy-14), badge_text, font=f(24,True), fill=badge_fg)
    # text
    draw.text((x+68, y+4), title, font=tf, fill=INK)
    draw.text((x+68, y+38), subtitle, font=sf, fill=INK2)
    return y + 80

def stat_badge(draw, x, y, w2, h2, num, label, accent, bg):
    rr(draw, (x,y,x+w2,y+h2), fill=bg, r=18)
    # accent strip on left
    rr(draw, (x,y,x+8,y+h2), fill=accent, r=4)
    draw.text((x+24, y+16), num, font=f(52,True), fill=accent)
    for i, ln in enumerate(label.split('\n')):
        draw.text((x+24, y+74+i*28), ln, font=f(23), fill=INK2)

# ─────────────────────────────────────────────────────────────────────────────
# SLIDE 1 — Overview
# ─────────────────────────────────────────────────────────────────────────────
def slide1():
    img, draw = make_base()
    draw = draw_header(img, draw, 'What\'s New', 'Major Update')

    y = 270

    # Date line
    draw.text((PAD, y), 'May – June 2026', font=f(26), fill=INK2)
    y += 44
    draw.text((PAD, y), '15 new features  ·  30+ improvements', font=f(30,True), fill=TEAL)
    y += 58
    hline(draw, PAD, W-PAD, y, DIVIDER)
    y += 32

    # 2×2 stat badges
    bw = (W - PAD*2 - 20) // 2
    bh = 122
    stats = [
        ('2',  'Plan-your-night\nBuilders',    TEAL,   TEAL_BG),
        ('5',  'Smart\nFilters',               BLUE,   BLUE_BG),
        ('5',  'Transit\nModes',               AMBER,  AMBER_BG),
        ('∞',  'Baked\nGeo data',              PURPLE, PURPLE_BG),
    ]
    for i, (num, label, acc, bg) in enumerate(stats):
        bx = PAD + (i%2)*(bw+20)
        by = y + (i//2)*(bh+16)
        stat_badge(draw, bx, by, bw, bh, num, label, acc, bg)
    y += 2*(bh+16) + 20

    hline(draw, PAD, W-PAD, y, DIVIDER)
    y += 32

    # Feature category blocks
    sections = [
        ('BUILDERS',   TEAL,   TEAL_BG,
         ['Outing Builder — step-by-step stop chaining',
          'AI Planner — neighborhood + time window']),
        ('FILTERING',  BLUE,   BLUE_BG,
         ['Time-window event filter',
          'Meal-type restaurant filter',
          'Neighborhood targeting for both builders']),
        ('TRANSIT',    AMBER,  AMBER_BG,
         ['Walk · Bike · Drive · Transit · Mix (NEW)',
          'Per-leg walk vs. transit recommendations']),
        ('CONTENT',    GREEN,  GREEN_BG,
         ['Farmers Markets → dedicated Markets tab',
          'Liberty Beer Garden added',
          'Auto-trending restaurants weekly']),
    ]

    for sec, acc, bg, items in sections:
        # Section label pill
        slw = tw(draw, sec, f(20,True)) + 28
        rr(draw, (PAD, y, PAD+slw, y+34), fill=bg, r=17)
        draw.text((PAD+14, y+7), sec, font=f(20,True), fill=acc)
        y += 50
        for item in items:
            draw.ellipse([PAD+6, y+9, PAD+18, y+21], fill=acc)
            draw.text((PAD+30, y), item, font=f(26), fill=INK)
            y += 38
        y += 18

    draw_footer(draw, 1)
    return img

# ─────────────────────────────────────────────────────────────────────────────
# SLIDE 2 — Builders
# ─────────────────────────────────────────────────────────────────────────────
def slide2():
    img, draw = make_base()
    draw = draw_header(img, draw, 'Plan Your Night', 'Builders')

    y = 270

    # ── Outing Builder ───────────────────────────────────────────────────────
    rr(draw, (PAD, y, W-PAD, y+760), fill=WHITE, r=20, outline=DIVIDER)

    # Card header bar
    rr(draw, (PAD, y, W-PAD, y+66), fill=TEAL, r=20)
    rr(draw, (PAD, y+46, W-PAD, y+66), fill=TEAL, r=0)
    draw.text((PAD+24, y+16), 'Outing Builder', font=f(34,True), fill=WHITE)
    draw.text((PAD+24, y+54), 'Step-by-step stop chaining + AI narrative', font=f(22), fill=(200,240,234))

    # Step flow pills
    y2 = y + 90
    draw.text((PAD+20, y2), 'Wizard flow:', font=f(22), fill=INK2)
    y2 += 34
    steps = [('Day','1'), ('Transit','2'), ('Area','3'), ('Time','4'),
             ('Pick Stops','5'), ('AI Story','6')]
    sx = PAD+20
    for label, num in steps:
        sw2 = tw(draw, label, f(21,True)) + 30
        rr(draw, (sx, y2, sx+sw2, y2+34), fill=TEAL_BG, r=17)
        draw.text((sx+15, y2+7), label, font=f(21,True), fill=TEAL)
        sx += sw2 + 10
        if sx > W - PAD - 120:
            sx = PAD+20
            y2 += 44
    y2 += 54

    hline(draw, PAD+20, W-PAD-20, y2, DIVIDER)
    y2 += 24

    ob_features = [
        ('A', TEAL,   TEAL_BG,   'Neighborhood anchor',     'Stops pulled from your chosen area'),
        ('T', BLUE,   BLUE_BG,   'Start & end time',        'Events & restaurants filtered to window'),
        ('M', AMBER,  AMBER_BG,  'Meal-type filtering',     'No breakfast spots for a dinner slot'),
        ('i', PURPLE, PURPLE_BG, 'Expandable venue info',   'See details before adding a stop'),
        ('~', GREEN,  GREEN_BG,  'Proximity ordering',      'Closest options highlighted first'),
        ('+', TEAL,   TEAL_BG,   'Walk + Transit mix',      'Per-leg walk vs. transit by distance'),
        ('>', BLUE,   BLUE_BG,   'Action buttons',          'Reserve · Website · Map on each stop'),
        ('S', AMBER,  AMBER_BG,  'Clean share export',      'Formatted itinerary text to share'),
    ]
    for badge, acc, bg, title, detail in ob_features:
        y2 = feature_row(draw, PAD+20, y2, badge, bg, acc, title, detail, f(27,True), f(22))

    y = y + 760 + 24

    # ── AI Planner ────────────────────────────────────────────────────────────
    rr(draw, (PAD, y, W-PAD, y+440), fill=WHITE, r=20, outline=DIVIDER)
    rr(draw, (PAD, y, W-PAD, y+66), fill=BLUE, r=20)
    rr(draw, (PAD, y+46, W-PAD, y+66), fill=BLUE, r=0)
    draw.text((PAD+24, y+16), 'AI Planner', font=f(34,True), fill=WHITE)
    draw.text((PAD+24, y+54), 'Full itinerary generated by Gemini AI', font=f(22), fill=(220,234,255))

    pl_features = [
        ('A', BLUE,   BLUE_BG,   'Neighborhood picker',  '13 Philly areas to anchor your outing'),
        ('T', TEAL,   TEAL_BG,   'Time window',          'Start + end — events auto-filtered'),
        ('F', AMBER,  AMBER_BG,  'Food preference',      'Casual · Fancy · Adventurous · Drinks'),
        ('O', PURPLE, PURPLE_BG, 'Occasion type',        'Date night · Solo · Friends · Family'),
    ]
    y2 = y + 82
    for badge, acc, bg, title, detail in pl_features:
        y2 = feature_row(draw, PAD+20, y2, badge, bg, acc, title, detail, f(27,True), f(22))

    # Transit modes row
    y2 += 10
    hline(draw, PAD+20, W-PAD-20, y2, DIVIDER)
    y2 += 24
    draw.text((PAD+20, y2), 'Transit modes:', font=f(24,True), fill=INK)
    y2 += 38
    modes = [('Walk',TEAL,TEAL_BG), ('Bike',GREEN,GREEN_BG),
             ('Transit',BLUE,BLUE_BG), ('Drive',AMBER,AMBER_BG)]
    mx = PAD+20
    for label, acc, bg in modes:
        mw = tw(draw, label, f(22,True)) + 28
        rr(draw, (mx, y2, mx+mw, y2+38), fill=bg, r=19)
        draw.text((mx+14, y2+9), label, font=f(22,True), fill=acc)
        mx += mw+14
    # NEW pill
    rr(draw, (mx, y2, mx+100, y2+38), fill=TEAL, r=19)
    draw.text((mx+10, y2+9), 'Mix  ★', font=f(22,True), fill=WHITE)

    draw_footer(draw, 2)
    return img

# ─────────────────────────────────────────────────────────────────────────────
# SLIDE 3 — Filters & Infrastructure
# ─────────────────────────────────────────────────────────────────────────────
def slide3():
    img, draw = make_base()
    draw = draw_header(img, draw, 'Under the Hood', 'Filters & Fixes')

    y = 270

    # ── Time window card ──────────────────────────────────────────────────────
    rr(draw, (PAD, y, W-PAD, y+230), fill=WHITE, r=20, outline=DIVIDER)
    draw.text((PAD+24, y+20), 'Time-Window Filtering', font=f(30,True), fill=INK)
    draw.text((PAD+24, y+56), 'Only shows events & restaurants active during', font=f(24), fill=INK2)
    draw.text((PAD+24, y+84), 'your chosen outing hours.', font=f(24), fill=INK2)

    # Timeline
    bx, byw = PAD+24, y+128
    bw2 = W - PAD*2 - 48
    rr(draw, (bx, byw, bx+bw2, byw+28), fill=DIVIDER, r=14)
    wx1 = bx + int(bw2*18/24)
    wx2 = bx + int(bw2*22/24)
    rr(draw, (wx1, byw, wx2, byw+28), fill=TEAL, r=14)
    for hr, lbl in [(0,'12A'),(6,'6A'),(12,'12P'),(18,'6P'),(22,'10P')]:
        lx2 = bx + int(bw2*hr/24)
        draw.line([(lx2,byw+28),(lx2,byw+36)], fill=INK2, width=2)
        draw.text((lx2-12, byw+38), lbl, font=f(20), fill=INK2)
    mid = (wx1+wx2)//2
    tw2 = tw(draw, 'your window', f(20,True))
    draw.text((mid-tw2//2, byw+64), 'your window', font=f(20,True), fill=TEAL)

    y += 246

    # ── Meal-type filter ──────────────────────────────────────────────────────
    rr(draw, (PAD, y, W-PAD, y+290), fill=WHITE, r=20, outline=DIVIDER)
    draw.text((PAD+24, y+20), 'Meal-Type Restaurant Filter', font=f(30,True), fill=INK)
    draw.text((PAD+24, y+56), 'Breakfast spots hidden at dinner time and vice versa.', font=f(24), fill=INK2)

    slot_w = (W - PAD*2 - 48 - 32) // 3
    slots = [
        ('Morning',   '6A–11A',  'Breakfast\nBrunch',  AMBER,  AMBER_BG),
        ('Midday',    '11A–3P',  'Lunch\nBrunch',      GREEN,  GREEN_BG),
        ('Evening',   '5P–10P',  'Dinner',             BLUE,   BLUE_BG),
    ]
    sx2 = PAD+24
    sy = y+100
    for period, hours, meals, acc, bg in slots:
        rr(draw, (sx2, sy, sx2+slot_w, sy+168), fill=bg, r=16)
        draw.text((sx2+14, sy+14), period, font=f(24,True), fill=acc)
        draw.text((sx2+14, sy+46), hours, font=f(20), fill=INK2)
        hline(draw, sx2+14, sx2+slot_w-14, sy+74, acc, 1)
        ty = sy+84
        for meal in meals.split('\n'):
            draw.text((sx2+14, ty), meal, font=f(22,True), fill=INK)
            ty += 32
        sx2 += slot_w+16

    y += 306

    # ── Farmers Markets routing ───────────────────────────────────────────────
    rr(draw, (PAD, y, W-PAD, y+180), fill=WHITE, r=20, outline=DIVIDER)
    draw.text((PAD+24, y+20), 'Farmers Markets Routing', font=f(30,True), fill=INK)
    draw.text((PAD+24, y+56), 'Calendar "Farmers Market" events are now routed', font=f(24), fill=INK2)
    draw.text((PAD+24, y+84), 'to the Markets tab, not the Events feed.', font=f(24), fill=INK2)
    # before → after visual
    ax = PAD+24
    ay = y+128
    rr(draw, (ax, ay, ax+220, ay+38), fill=RED_BG, r=19)
    draw.text((ax+14, ay+10), 'Events tab  ✕', font=f(22,True), fill=RED)
    draw.text((ax+236, ay+10), '→', font=f(22,True), fill=INK2)
    rr(draw, (ax+268, ay, ax+268+200, ay+38), fill=GREEN_BG, r=19)
    draw.text((ax+282, ay+10), 'Markets tab  ✓', font=f(22,True), fill=GREEN)

    y += 196

    # ── Infrastructure bullets ────────────────────────────────────────────────
    rr(draw, (PAD, y, W-PAD, y+300), fill=WHITE, r=20, outline=DIVIDER)
    draw.text((PAD+24, y+20), 'Performance & Content', font=f(30,True), fill=INK)
    bullets = [
        (TEAL,   'Baked geo data',         '0 Places API calls per visitor (was 1+)'),
        (BLUE,   'Photo cache',            'Service worker — photos load offline'),
        (GREEN,  'Liberty Beer Garden',    'New outdoor venue added'),
        (AMBER,  'Website button',         'Replaces confusing "Find tickets" on events'),
        (PURPLE, '.nojekyll fix',          'Faster, more reliable GitHub Pages builds'),
    ]
    by2 = y+70
    for acc, title, detail in bullets:
        draw.ellipse([PAD+24, by2+8, PAD+40, by2+24], fill=acc)
        draw.text((PAD+52, by2), title, font=f(26,True), fill=INK)
        draw.text((PAD+52, by2+32), detail, font=f(22), fill=INK2)
        by2 += 68

    draw_footer(draw, 3)
    return img

# ─────────────────────────────────────────────────────────────────────────────
# Generate
# ─────────────────────────────────────────────────────────────────────────────
OUT = '/home/user/Goings-On'
slides = [
    (slide1, 'release_notes_01_overview.jpg'),
    (slide2, 'release_notes_02_builders.jpg'),
    (slide3, 'release_notes_03_filters.jpg'),
]
for fn, fname in slides:
    img = fn()
    path = os.path.join(OUT, fname)
    img.save(path, 'JPEG', quality=95)
    print(f'Saved {path}  {img.size}')
