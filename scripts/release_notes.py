#!/usr/bin/env python3
"""Generate release notes JPEGs for Goings-On Philadelphia."""

from PIL import Image, ImageDraw, ImageFont
import os, math

# ── Palette ──────────────────────────────────────────────────────────────────
BG        = (10, 12, 18)
SURFACE   = (20, 25, 36)
CARD      = (26, 32, 46)
TEAL      = (26, 122, 110)
TEAL_LT   = (42, 168, 151)
TEAL_DIM  = (18, 80, 72)
GOLD      = (220, 170, 80)
WHITE     = (230, 236, 245)
MUTED     = (110, 125, 148)
DIVIDER   = (38, 46, 64)
RED_DIM   = (130, 60, 60)

W, H = 1200, 675

# ── Fonts ────────────────────────────────────────────────────────────────────
SANS      = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
SANS_B    = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
EMOJI_F   = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'

def fnt(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

def emoji_fnt(size):
    try:
        return ImageFont.truetype(EMOJI_F, size)
    except Exception:
        return ImageFont.load_default()

# ── Drawing helpers ───────────────────────────────────────────────────────────
def rounded_rect(draw, xy, fill, radius=14, outline=None, outline_width=1):
    x1, y1, x2, y2 = xy
    draw.rounded_rectangle(xy, radius=radius, fill=fill,
                           outline=outline, width=outline_width)

def gradient_bar(img, y, height, col_left, col_right):
    draw = ImageDraw.Draw(img)
    for x in range(W):
        t = x / W
        r = int(col_left[0] + (col_right[0]-col_left[0])*t)
        g = int(col_left[1] + (col_right[1]-col_left[1])*t)
        b = int(col_left[2] + (col_right[2]-col_left[2])*t)
        draw.line([(x, y), (x, y+height)], fill=(r,g,b))

def text_w(draw, text, font):
    bb = draw.textbbox((0,0), text, font=font)
    return bb[2] - bb[0]

def centered_text(draw, y, text, font, color=WHITE, canvas_w=W):
    w = text_w(draw, text, font)
    draw.text(((canvas_w - w) // 2, y), text, font=font, fill=color)

def pill(draw, cx, cy, label, font, bg, fg=WHITE, pad_x=18, pad_y=7):
    tw = text_w(draw, label, font)
    x1 = cx - tw//2 - pad_x
    y1 = cy - pad_y - 8
    x2 = cx + tw//2 + pad_x
    y2 = cy + pad_y + 8
    rounded_rect(draw, (x1,y1,x2,y2), fill=bg, radius=20)
    draw.text((cx - tw//2, y1+pad_y-2), label, font=font, fill=fg)
    return x2  # right edge

def icon_circle(draw, cx, cy, r, bg, label, font, fg=WHITE):
    draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=bg)
    tw = text_w(draw, label, font)
    fh = r  # approximate
    draw.text((cx - tw//2, cy - fh//2 + 2), label, font=font, fill=fg)

def dot_row(draw, x, y, items, font, color, gap=22, dot_col=TEAL):
    """Bullet list, left-aligned."""
    for item in items:
        # dot
        draw.ellipse([x, y+7, x+8, y+15], fill=dot_col)
        draw.text((x+16, y), item, font=font, fill=color)
        y += 28
    return y

def vertical_line(draw, x, y1, y2, color=DIVIDER, width=1):
    draw.line([(x,y1),(x,y2)], fill=color, width=width)

def horizontal_line(draw, x1, x2, y, color=DIVIDER, width=1):
    draw.line([(x1,y),(x2,y)], fill=color, width=width)

def make_base():
    img = Image.new('RGB', (W, H), BG)
    return img, ImageDraw.Draw(img)

# ── Header/Footer shared elements ─────────────────────────────────────────────
def draw_header(img, draw, subtitle=''):
    gradient_bar(img, 0, 58, TEAL_DIM, (14, 70, 95))
    f_app   = fnt(SANS_B, 22)
    f_sub   = fnt(SANS, 16)
    draw.text((32, 16), 'GOINGS ON  ·  PHILADELPHIA', font=f_app, fill=WHITE)
    if subtitle:
        sw = text_w(draw, subtitle, f_sub)
        draw.text((W - sw - 32, 21), subtitle, font=f_sub, fill=(180, 220, 215))
    # thin teal underline
    draw.line([(0, 58), (W, 58)], fill=TEAL, width=2)

def draw_footer(draw, page, total=3):
    draw.line([(0, H-34), (W, H-34)], fill=DIVIDER, width=1)
    f = fnt(SANS, 13)
    draw.text((32, H-24), 'RELEASE NOTES  ·  JUNE 2026', font=f, fill=MUTED)
    pg = f'{page} / {total}'
    pw = text_w(draw, pg, f)
    draw.text((W - pw - 32, H-24), pg, font=f, fill=MUTED)
    # dot indicators
    for i in range(total):
        cx = W//2 - (total-1)*10 + i*20
        cy = H - 19
        col = TEAL if i+1 == page else DIVIDER
        draw.ellipse([cx-5,cy-5,cx+5,cy+5], fill=col)

# ─────────────────────────────────────────────────────────────────────────────
# SLIDE 1 — Hero overview
# ─────────────────────────────────────────────────────────────────────────────
def slide1():
    img, draw = make_base()
    draw_header(img, draw, subtitle='What\'s New')

    # Big version badge
    f_ver   = fnt(SANS_B, 13)
    f_hero  = fnt(SANS_B, 42)
    f_hero2 = fnt(SANS_B, 20)
    f_body  = fnt(SANS, 16)
    f_sm    = fnt(SANS, 14)
    f_smb   = fnt(SANS_B, 14)

    draw.text((32, 78), 'May – June 2026', font=f_ver, fill=MUTED)
    draw.text((32, 100), 'Major Update', font=f_hero, fill=WHITE)
    draw.text((32, 150), '15 new features  ·  30+ improvements', font=f_hero2, fill=(160, 200, 195))

    horizontal_line(draw, 32, W//2 - 20, 185, DIVIDER)

    # Left column — feature count badges
    badges = [
        ('2', 'Plan-your-night\nBuilders',   TEAL,       36),
        ('5', 'Smart\nFilters',              (50,70,140), 200),
        ('3', 'Transit\nModes',              (100,70,30), 364),
        ('∞', 'Baked\nGeo data',             (60,40,100), 528),
    ]
    bx, by = 38, 210
    for num, label, bg, x in badges:
        rounded_rect(draw, (x, by, x+118, by+90), fill=CARD, radius=12, outline=DIVIDER)
        f_big = fnt(SANS_B, 36)
        draw.text((x+14, by+8), num, font=f_big, fill=WHITE)
        lines = label.split('\n')
        yy = by + 52
        for ln in lines:
            draw.text((x+14, yy), ln, font=f_sm, fill=MUTED)
            yy += 18
        # accent bar bottom
        rounded_rect(draw, (x+8, by+82, x+110, by+88), fill=bg, radius=3)

    # Right side — feature list
    rx = W//2 + 10
    ry = 78
    sections = [
        ('BUILDERS',  ['Outing Builder', 'AI Planner upgrades']),
        ('FILTERING', ['Time-window event filter', 'Meal-type restaurant filter', 'Neighborhood targeting']),
        ('TRANSIT',   ['Walk · Bike · Drive · Transit', 'Walk + Transit mix mode', 'Per-leg distance recommendations']),
        ('CONTENT',   ['Farmers markets → Markets tab', 'Liberty Beer Garden added', 'Auto-trending restaurants']),
    ]
    f_sec = fnt(SANS_B, 11)
    for sec, items in sections:
        draw.text((rx, ry), sec, font=f_sec, fill=TEAL_LT)
        ry += 20
        for item in items:
            draw.ellipse([rx, ry+7, rx+6, ry+13], fill=TEAL)
            draw.text((rx+14, ry), item, font=f_sm, fill=WHITE)
            ry += 22
        ry += 10

    draw_footer(draw, 1)
    return img

# ─────────────────────────────────────────────────────────────────────────────
# SLIDE 2 — Builders deep-dive
# ─────────────────────────────────────────────────────────────────────────────
def slide2():
    img, draw = make_base()
    draw_header(img, draw, subtitle='Plan Your Night')

    f_title = fnt(SANS_B, 28)
    f_sub   = fnt(SANS_B, 14)
    f_body  = fnt(SANS, 14)
    f_sm    = fnt(SANS, 13)
    f_smb   = fnt(SANS_B, 13)
    f_tag   = fnt(SANS, 12)

    # Left card — Outing Builder
    lx, ly = 30, 76
    lw = 540
    rounded_rect(draw, (lx, ly, lx+lw, ly+530), fill=CARD, radius=16, outline=DIVIDER)
    gradient_bar(img, ly, 50, TEAL_DIM, (14, 50, 80))
    # re-clip to card shape using overlay
    ovr = Image.new('RGB', (W, H), CARD)
    mask = Image.new('L', (W, H), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle((lx, ly, lx+lw, ly+50), radius=16, fill=255)
    mdraw.rectangle((lx, ly+30, lx+lw, ly+50), fill=255)  # flatten bottom
    img.paste(ovr, mask=mask)
    draw = ImageDraw.Draw(img)  # refresh after paste
    gradient_bar(img, ly, 48, TEAL_DIM, (14, 55, 85))
    draw = ImageDraw.Draw(img)

    draw.text((lx+18, ly+12), '🗓  Outing Builder', font=f_sub, fill=WHITE)
    draw.text((lx+18, ly+32), 'Step-by-step manual stop chaining', font=f_sm, fill=(180,210,205))

    # Step flow visual
    steps = ['Day', 'Transit', 'Area', 'Time', 'Pick Stops', 'AI Narrative']
    sx = lx + 18
    sy = ly + 64
    for i, step in enumerate(steps):
        sw = text_w(draw, step, f_tag)
        rx2 = sx + sw + 16
        col = TEAL if i < 4 else (60, 100, 180)
        rounded_rect(draw, (sx, sy, rx2, sy+24), fill=col, radius=12)
        draw.text((sx+8, sy+5), step, font=f_tag, fill=WHITE)
        sx = rx2 + 6
        if i < len(steps)-1:
            draw.text((sx, sy+4), '›', font=f_tag, fill=MUTED)
            sx += 14

    sy2 = ly + 106
    features = [
        ('📍', 'Neighborhood anchor',       'Stops pulled from chosen area'),
        ('🕐', 'Start & end time',           'Events & restaurants filtered to window'),
        ('🍽', 'Meal-type filtering',         'No breakfast spots for a dinner slot'),
        ('ⓘ',  'Expandable venue info',      'See desc · reserve · website before adding'),
        ('📏', 'Proximity ordering',         'Closest options highlighted first'),
        ('🚶🚇','Walk + Transit mix',        'Per-leg walk vs. transit recommendation'),
        ('🔗', 'Itinerary action buttons',   'Reserve · Website · Map on each stop'),
        ('📤', 'Clean share export',         'Formatted text ready to share'),
    ]
    for icon, title, detail in features:
        draw.text((lx+18, sy2), icon, font=f_sub, fill=TEAL_LT)
        draw.text((lx+46, sy2), title, font=f_smb, fill=WHITE)
        draw.text((lx+46, sy2+17), detail, font=f_sm, fill=MUTED)
        sy2 += 44

    # Right card — AI Planner
    rx = lx + lw + 20
    rw = W - rx - 30
    rounded_rect(draw, (rx, ly, rx+rw, ly+240), fill=CARD, radius=16, outline=DIVIDER)
    gradient_bar(img, ly, 48, (30, 50, 100), (14, 45, 80))
    draw = ImageDraw.Draw(img)
    draw.text((rx+18, ly+12), '✨  AI Planner', font=f_sub, fill=WHITE)
    draw.text((rx+18, ly+32), 'Full itinerary generated by Gemini', font=f_sm, fill=(180, 195, 220))

    pl_features = [
        ('📍', 'Neighborhood picker',    '13 Philly areas to anchor stops'),
        ('🕐', 'Time window',            'Start + end → events auto-filtered'),
        ('🍴', 'Food preference',        'Casual · Fancy · Adventurous · Drinks'),
        ('🎯', 'Occasion type',          'Date night · Solo · Friends · Family'),
    ]
    py = ly + 58
    for icon, title, detail in pl_features:
        draw.text((rx+18, py), icon, font=f_sub, fill=(100, 140, 220))
        draw.text((rx+48, py), title, font=f_smb, fill=WHITE)
        draw.text((rx+48, py+17), detail, font=f_sm, fill=MUTED)
        py += 42

    # Transit modes card
    rounded_rect(draw, (rx, ly+256, rx+rw, ly+420), fill=CARD, radius=16, outline=DIVIDER)
    draw.text((rx+18, ly+270), 'Transit Modes', font=f_sub, fill=WHITE)
    modes = [
        ('🚶', 'Walk',           TEAL),
        ('🚲', 'Bike',           (50, 130, 80)),
        ('🚇', 'Transit',        (60, 80, 160)),
        ('🚗', 'Drive',          (130, 80, 40)),
        ('🚶🚇', 'Mix  NEW',     (110, 60, 140)),
    ]
    mx = rx + 18
    my = ly + 302
    for icon, label, col in modes:
        # mode pill
        new_badge = '  ★' if 'NEW' in label else ''
        clean = label.replace('  NEW','')
        tw = text_w(draw, clean, f_tag)
        rounded_rect(draw, (mx, my, mx+tw+28, my+30), fill=col, radius=15)
        draw.text((mx+8, my+8), clean, font=f_tag, fill=WHITE)
        if 'NEW' in label:
            stw = text_w(draw, '★', f_tag)
            draw.text((mx+tw+12, my+8), '★', font=f_tag, fill=GOLD)
        mx += tw + 42
        if mx > rx + rw - 10:
            mx = rx + 18
            my += 38

    # Distance recommendation box
    rounded_rect(draw, (rx, ly+436, rx+rw, ly+530), fill=CARD, radius=16, outline=DIVIDER)
    draw.text((rx+18, ly+450), 'Per-leg recommendation', font=f_sub, fill=WHITE)
    draw.text((rx+18, ly+475), '< 0.4 mi  →  🚶 Walk  (saves time + money)', font=f_sm, fill=(140, 210, 180))
    draw.text((rx+18, ly+498), '≥ 0.4 mi  →  🚇 Transit  (SEPTA)', font=f_sm, fill=(140, 170, 220))

    draw_footer(draw, 2)
    return img

# ─────────────────────────────────────────────────────────────────────────────
# SLIDE 3 — Smart Filtering + Infrastructure
# ─────────────────────────────────────────────────────────────────────────────
def slide3():
    img, draw = make_base()
    draw_header(img, draw, subtitle='Filters & Infrastructure')

    f_title = fnt(SANS_B, 26)
    f_sub   = fnt(SANS_B, 15)
    f_body  = fnt(SANS, 14)
    f_sm    = fnt(SANS, 13)
    f_smb   = fnt(SANS_B, 13)
    f_tag   = fnt(SANS, 12)
    f_xs    = fnt(SANS, 11)

    # ── Time window filter visual ─────────────────────────────────────────
    TW = 560
    rounded_rect(draw, (30, 76, 30+TW, 76+200), fill=CARD, radius=14, outline=DIVIDER)
    draw.text((50, 90), 'Time-Window Filtering', font=f_sub, fill=WHITE)
    draw.text((50, 112), 'Events & restaurants match your outing hours only', font=f_sm, fill=MUTED)

    # Timeline bar
    bx, by = 50, 148
    bw = TW - 40
    # full day track
    rounded_rect(draw, (bx, by, bx+bw, by+24), fill=DIVIDER, radius=12)
    # window highlight (6pm-10pm = 18-22h, out of 0-24)
    wx1 = bx + int(bw * 18/24)
    wx2 = bx + int(bw * 22/24)
    rounded_rect(draw, (wx1, by, wx2, by+24), fill=TEAL, radius=12)
    # hour labels
    for hr, label in [(0,'12A'),(6,'6A'),(12,'12P'),(18,'6P'),(22,'10P'),(24,'')]:
        lx2 = bx + int(bw * hr/24)
        draw.line([(lx2, by+24),(lx2, by+32)], fill=MUTED, width=1)
        if label:
            draw.text((lx2-8, by+34), label, font=f_xs, fill=MUTED)

    # Labels for window
    mid_win = (wx1 + wx2) // 2
    draw.text((mid_win - 30, by + 50), 'Your window', font=f_xs, fill=TEAL_LT)

    # Icons below
    icons_y = by + 74
    items = [
        (TEAL,        '✓',  'Events in window shown'),
        (RED_DIM,     '✕',  'Past / outside window hidden'),
        ((60,80,140), '✓',  'All-day events always shown'),
    ]
    ix = bx
    for col, sym, text in items:
        rounded_rect(draw, (ix, icons_y, ix+16, icons_y+16), fill=col, radius=4)
        draw.text((ix+2, icons_y+1), sym, font=f_xs, fill=WHITE)
        draw.text((ix+22, icons_y), text, font=f_sm, fill=WHITE)
        ix += 180

    # ── Meal-type filter visual ───────────────────────────────────────────
    rounded_rect(draw, (30, 286, 30+TW, 286+170), fill=CARD, radius=14, outline=DIVIDER)
    draw.text((50, 300), 'Meal-Type Restaurant Filter', font=f_sub, fill=WHITE)
    draw.text((50, 322), 'Only shows spots that serve food for your outing time', font=f_sm, fill=MUTED)

    meal_slots = [
        ('6A–11A', 'Breakfast',   (140, 90, 40),  ['breakfast','brunch']),
        ('11A–2P', 'Lunch',       (50, 120, 80),  ['lunch','brunch']),
        ('5P–10P', 'Dinner',      (60, 60, 150),  ['dinner','date-night']),
    ]
    mx2 = 50
    for time_str, meal, col, tags in meal_slots:
        rounded_rect(draw, (mx2, 348, mx2+152, 435), fill=col, radius=12)
        draw.text((mx2+12, 356), time_str, font=f_xs, fill=(220,220,220))
        draw.text((mx2+12, 372), meal, font=f_sub, fill=WHITE)
        ty = 398
        for tag in tags:
            tw = text_w(draw, tag, f_tag)
            rounded_rect(draw, (mx2+12, ty, mx2+12+tw+12, ty+20), fill=(0,0,0,100), radius=10)
            draw.text((mx2+18, ty+3), tag, font=f_tag, fill=(220,220,220))
            ty += 25
        mx2 += 172

    # ── Right column ──────────────────────────────────────────────────────
    RX = 30 + TW + 20
    RW = W - RX - 30

    # Farmers markets routing
    rounded_rect(draw, (RX, 76, RX+RW, 76+120), fill=CARD, radius=14, outline=DIVIDER)
    draw.text((RX+16, 90), 'Farmers Markets Routing', font=f_sub, fill=WHITE)
    draw.text((RX+16, 112), 'Calendar "Farmers Market" events', font=f_sm, fill=MUTED)
    # Arrow diagram
    draw.text((RX+16, 138), 'Events tab', font=f_sm, fill=RED_DIM)
    tw = text_w(draw, 'Events tab', f_sm)
    draw.text((RX+20+tw, 138), '  ✕  →  ', font=f_sm, fill=MUTED)
    tw2 = text_w(draw, 'Events tab  ✕  →  ', f_sm)
    draw.text((RX+16+tw2, 138), 'Markets tab  ✓', font=f_sm, fill=(100, 200, 120))
    draw.text((RX+16, 162), '"This week" section added at top of Markets', font=f_sm, fill=MUTED)

    # Baked geo data
    rounded_rect(draw, (RX, 208, RX+RW, 208+130), fill=CARD, radius=14, outline=DIVIDER)
    draw.text((RX+16, 222), 'Baked Coordinates', font=f_sub, fill=WHITE)
    draw.text((RX+16, 244), 'Geo data pre-baked into index.html daily', font=f_sm, fill=MUTED)
    draw.text((RX+16, 270), '0   API calls/visitor', font=f_sm, fill=(100,200,120))
    draw.text((RX+16, 290), 'before → 1 Places call per page load', font=f_xs, fill=MUTED)
    # bar comparison
    draw.text((RX+16, 314), 'Before', font=f_xs, fill=MUTED)
    rounded_rect(draw, (RX+70, 316, RX+70+160, 328), fill=RED_DIM, radius=4)
    draw.text((RX+16, 328), 'After', font=f_xs, fill=MUTED)
    rounded_rect(draw, (RX+70, 330, RX+70+12, 342), fill=TEAL, radius=4)

    # Content & fixes
    rounded_rect(draw, (RX, 350, RX+RW, 350+110), fill=CARD, radius=14, outline=DIVIDER)
    draw.text((RX+16, 364), 'Content & Fixes', font=f_sub, fill=WHITE)
    bullets = [
        'Liberty Beer Garden added',
        'Website button (not "Find tickets")',
        'Auto-trending restaurants weekly',
        '.nojekyll → faster GitHub Pages builds',
    ]
    by2 = 388
    for b in bullets:
        draw.ellipse([RX+16, by2+5, RX+24, by2+13], fill=TEAL)
        draw.text((RX+30, by2), b, font=f_sm, fill=WHITE)
        by2 += 22

    draw_footer(draw, 3)
    return img

# ─────────────────────────────────────────────────────────────────────────────
# Generate
# ─────────────────────────────────────────────────────────────────────────────
out = '/home/user/Goings-On'

slides = [
    (slide1, 'release_notes_01_overview.jpg'),
    (slide2, 'release_notes_02_builders.jpg'),
    (slide3, 'release_notes_03_filters.jpg'),
]

for fn, fname in slides:
    img = fn()
    path = os.path.join(out, fname)
    img.save(path, 'JPEG', quality=95)
    print(f'Saved {path}')
