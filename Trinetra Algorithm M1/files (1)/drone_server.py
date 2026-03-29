"""
drone_server.py  ── DRONEIQ Aerial Intelligence Server v3.0
Created by Palash Jana (Trinetra algorithm M1) on 2026-03-15
═══════════════════════════════════════════════════════════════════
Features:
  • USB camera → YOLOv8 object detection
  • Tesseract OCR extracts LAT/LON/ALT/MAG from HUD (top-right)
  • Aim-point geo-location via hypotenuse trigonometry
  • A* pathfinding with obstacle heatmap (configurable cell/span)
  • Camera HFOV/VFOV set at runtime by user (no restart needed)
  • Initial drone position override from frontend
  • Returns full A* node table for display on webpage
  • WebSocket streams: video + telemetry + detections + targets
  • REST: /api/aim  /api/config  /api/hud/debug
═══════════════════════════════════════════════════════════════════
INSTALL:
  pip install fastapi uvicorn websockets opencv-python pytesseract
              ultralytics numpy pillow python-multipart

TESSERACT:
  Windows: https://github.com/UB-Mannheim/tesseract/wiki
  Linux:   sudo apt install tesseract-ocr
  macOS:   brew install tesseract

RUN:
  python drone_server.py
  Open http://localhost:3000  (React frontend)
"""

import asyncio, base64, heapq, json, logging, math, re
import threading, time
from collections import deque
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional

import cv2
import numpy as np
import pytesseract
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# ── Windows Tesseract path (uncomment if needed) ──────────────────
# pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("DroneIQ")

# ═══════════════════════════════════════════════════════════════════
#  RUNTIME CONFIG  (can be updated via /api/config POST)
# ═══════════════════════════════════════════════════════════════════

@dataclass
class RuntimeConfig:
    # Camera
    camera_index:   int   = 0
    camera_w:       int   = 1280
    camera_h:       int   = 720
    target_fps:     int   = 25
    jpeg_quality:   int   = 80
    # Camera field of view — SET BY USER in the web UI
    hfov_deg:       float = 70.0
    vfov_deg:       float = 50.0
    # YOLO
    yolo_model:     str   = "yolov8n.pt"
    yolo_conf:      float = 0.40
    # HUD region (fraction of frame)
    hud_x:          float = 0.65
    hud_y:          float = 0.00
    hud_w:          float = 0.35
    hud_h:          float = 0.18
    # A* grid
    grid_cell_m:    int   = 5
    grid_span_m:    int   = 300
    obstacle_r_m:   int   = 10
    # Manual drone position override (used if OCR fails)
    manual_lat:     Optional[float] = None
    manual_lon:     Optional[float] = None
    manual_alt:     Optional[float] = None

cfg = RuntimeConfig()

# ═══════════════════════════════════════════════════════════════════
#  CLASS CONFIG
# ═══════════════════════════════════════════════════════════════════

CLASS_CFG: dict[str, dict] = {
    "person":     {"label":"Human",      "color":"#ff4444","icon":"👤","group":"human"},
    "car":        {"label":"Vehicle",    "color":"#ffaa00","icon":"🚗","group":"vehicle"},
    "truck":      {"label":"Truck",      "color":"#ffaa00","icon":"🚛","group":"vehicle"},
    "bus":        {"label":"Bus",        "color":"#ffaa00","icon":"🚌","group":"vehicle"},
    "motorcycle": {"label":"Motorcycle", "color":"#ffcc00","icon":"🏍","group":"vehicle"},
    "bicycle":    {"label":"Bicycle",    "color":"#ffcc00","icon":"🚲","group":"vehicle"},
    "tank":       {"label":"Tank",       "color":"#ff0000","icon":"🪖","group":"military"},
    "helicopter": {"label":"Helicopter", "color":"#ff6600","icon":"🚁","group":"military"},
    "airplane":   {"label":"Aircraft",   "color":"#ff6600","icon":"✈", "group":"military"},
    "boat":       {"label":"Vessel",     "color":"#00ccff","icon":"🚢","group":"vehicle"},
    "dog":        {"label":"Animal",     "color":"#44ff88","icon":"🐕","group":"animal"},
    "cat":        {"label":"Animal",     "color":"#44ff88","icon":"🐈","group":"animal"},
    "horse":      {"label":"Animal",     "color":"#44ff88","icon":"🐎","group":"animal"},
    "cow":        {"label":"Animal",     "color":"#44ff88","icon":"🐄","group":"animal"},
    "sheep":      {"label":"Animal",     "color":"#44ff88","icon":"🐑","group":"animal"},
    "bird":       {"label":"Bird",       "color":"#aaffaa","icon":"🐦","group":"animal"},
    "_default":   {"label":"Object",     "color":"#ffffff","icon":"📍","group":"unknown"},
}
MILITARY_SIZE_THR = 0.08

# ═══════════════════════════════════════════════════════════════════
#  DATA CLASSES
# ═══════════════════════════════════════════════════════════════════

@dataclass
class Detection:
    id:         str
    class_name: str
    label:      str
    group:      str
    color:      str
    icon:       str
    confidence: float
    bbox:       list
    cx_frac:    float
    cy_frac:    float
    gps_lat:    Optional[float] = None
    gps_lon:    Optional[float] = None
    is_target:  bool = False
    timestamp:  str  = ""

@dataclass
class Telemetry:
    lat:       Optional[float] = None
    lon:       Optional[float] = None
    alt:       Optional[float] = None
    mag:       Optional[float] = None
    timestamp: str = ""

@dataclass
class ServerState:
    telemetry:   Telemetry = field(default_factory=Telemetry)
    detections:  list      = field(default_factory=list)
    targets:     dict      = field(default_factory=dict)
    frame_count: int       = 0
    fps:         float     = 0.0
    connected:   bool      = False

# ═══════════════════════════════════════════════════════════════════
#  YOLO DETECTOR
# ═══════════════════════════════════════════════════════════════════

class YOLODetector:
    def __init__(self):
        self._model = None
        self._lock  = threading.Lock()

    def load(self):
        from ultralytics import YOLO
        log.info(f"[YOLO] Loading {cfg.yolo_model}")
        self._model = YOLO(cfg.yolo_model)
        log.info("[YOLO] Ready.")

    def detect(self, frame: np.ndarray):
        if self._model is None:
            return [], frame
        h, w = frame.shape[:2]
        fa   = h * w
        with self._lock:
            results = self._model(frame, conf=cfg.yolo_conf, verbose=False)
        dets, annotated = [], frame.copy()
        for r in results:
            for box in r.boxes:
                cid  = int(box.cls[0])
                name = r.names[cid]
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                if name == "truck" and ((x2-x1)*(y2-y1))/max(fa,1) > MILITARY_SIZE_THR:
                    name = "tank"
                c  = CLASS_CFG.get(name, CLASS_CFG["_default"])
                cx = (x1+x2)//2; cy = (y1+y2)//2
                dets.append(Detection(
                    id=f"{name}_{cx}_{cy}_{int(time.time()*1000)}",
                    class_name=name, label=c["label"], group=c["group"],
                    color=c["color"], icon=c["icon"],
                    confidence=round(conf,3), bbox=[x1,y1,x2,y2],
                    cx_frac=round(cx/w,4), cy_frac=round(cy/h,4),
                    timestamp=_now(),
                ))
                bgr = _hex_bgr(c["color"])
                cv2.rectangle(annotated,(x1,y1),(x2,y2),bgr,2)
                lbl = f"{c['label']} {conf:.0%}"
                tw,th = cv2.getTextSize(lbl,cv2.FONT_HERSHEY_SIMPLEX,0.55,1)[0]
                cv2.rectangle(annotated,(x1,y1-th-8),(x1+tw+6,y1),bgr,-1)
                cv2.putText(annotated,lbl,(x1+3,y1-4),
                            cv2.FONT_HERSHEY_SIMPLEX,0.55,(0,0,0),1)
        return dets, annotated

# ═══════════════════════════════════════════════════════════════════
#  HUD OCR  — robust magnetometer + standard fields
# ═══════════════════════════════════════════════════════════════════

class HUDReader:
    CARDINAL_DEG = {
        'N':0,'NNE':22,'NE':45,'ENE':67,'E':90,'ESE':112,'SE':135,
        'SSE':157,'S':180,'SSW':202,'SW':225,'WSW':247,'W':270,
        'WNW':292,'NW':315,'NNW':337,
    }

    def __init__(self):
        self._last     = Telemetry()
        self._counter  = 0
        self._interval = 3
        self._smooth   = None
        self._alpha    = 0.4
        self._raw_text = ""

    def read(self, frame: np.ndarray) -> Telemetry:
        self._counter += 1
        if self._counter % self._interval != 0:
            return self._last
        h, w = frame.shape[:2]
        x1 = int(cfg.hud_x*w); y1 = int(cfg.hud_y*h)
        x2 = int((cfg.hud_x+cfg.hud_w)*w); y2 = int((cfg.hud_y+cfg.hud_h)*h)
        hud = frame[y1:y2, x1:x2]
        if hud.size == 0:
            return self._last
        hud_h = y2-y1
        mag_r = frame[y1+hud_h//2:y2, x1:x2]
        full  = self._ocr_full(hud)
        mag_t = self._ocr_mag(mag_r)
        combined = (full+" "+mag_t).upper()
        self._raw_text = combined
        parsed = self._parse(combined, full.upper(), mag_t.upper())
        for f in ("lat","lon","alt"):
            v = getattr(parsed,f)
            if v is not None: setattr(self._last,f,v)
        if parsed.mag is not None:
            self._last.mag = self._smooth_mag(parsed.mag)
        # Apply manual overrides where OCR failed
        if self._last.lat is None and cfg.manual_lat:
            self._last.lat = cfg.manual_lat
        if self._last.lon is None and cfg.manual_lon:
            self._last.lon = cfg.manual_lon
        if self._last.alt is None and cfg.manual_alt:
            self._last.alt = cfg.manual_alt
        self._last.timestamp = _now()
        return self._last

    def _ocr_full(self, r):
        up   = cv2.resize(r,None,fx=3,fy=3,interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(up,cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=3.0,tileGridSize=(8,8))
        gray  = clahe.apply(gray)
        _,t1  = cv2.threshold(gray,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
        _,t2  = cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)
        ta    = cv2.adaptiveThreshold(gray,255,cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                      cv2.THRESH_BINARY,15,4)
        c = (r'--oem 3 --psm 6 -c tessedit_char_whitelist='
             r'0123456789.,-+:°ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/ ')
        out = []
        for img in (t1,t2,ta):
            try: out.append(pytesseract.image_to_string(img,config=c))
            except: pass
        return max(out,key=len) if out else ""

    def _ocr_mag(self, r):
        if r.size == 0: return ""
        up   = cv2.resize(r,None,fx=4,fy=4,interpolation=cv2.INTER_LANCZOS4)
        gray = cv2.cvtColor(up,cv2.COLOR_BGR2GRAY)
        k    = np.array([[0,-1,0],[-1,5,-1],[0,-1,0]],dtype=np.float32)
        sh   = cv2.filter2D(gray,-1,k)
        dn   = cv2.fastNlMeansDenoising(sh,h=10)
        cl   = cv2.createCLAHE(clipLimit=4.0,tileGridSize=(4,4))
        en   = cl.apply(dn)
        _,b  = cv2.threshold(en,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
        _,bi = cv2.threshold(en,0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)
        c7 = (r'--oem 3 --psm 7 -c tessedit_char_whitelist='
              r'0123456789.°NSEWnsew:MAGHDGYAWCOMPmaghdgyawcomp ')
        c6 = c7.replace('psm 7','psm 6')
        res=[]
        for img in (b,bi):
            for c_ in (c7,c6):
                try: res.append(pytesseract.image_to_string(img,config=c_))
                except: pass
        return " ".join(res)

    def _parse(self, combined, full, mag_only):
        t = Telemetry()
        for pat in [r'LAT\s*[:\-=\s]\s*([+-]?\d{1,3}\.\d{3,})',
                    r'([+-]?\d{1,2}\.\d{5,})\s*[NS]']:
            m=re.search(pat,combined)
            if m:
                t.lat=float(m.group(1))
                ctx=combined[max(0,m.start()-3):m.end()+3]
                if 'S' in ctx and 'NS' not in ctx: t.lat*=-1
                break
        for pat in [r'LON\s*[:\-=\s]\s*([+-]?\d{1,3}\.\d{3,})',
                    r'([+-]?\d{2,3}\.\d{5,})\s*[EW]']:
            m=re.search(pat,combined)
            if m:
                t.lon=float(m.group(1))
                ctx=combined[max(0,m.start()-3):m.end()+3]
                if 'W' in ctx and 'EW' not in ctx: t.lon*=-1
                break
        for pat in [r'ALT\s*[:\-=\s]\s*([+-]?\d+\.?\d*)',
                    r'([+-]?\d+\.?\d*)\s*(?:M\b|METRES?|METERS?)']:
            m=re.search(pat,combined)
            if m: t.alt=float(m.group(1)); break
        mag_val=None
        for src in (mag_only, combined):
            if mag_val is not None: break
            for pat in [r'MAG\s*[:\-=\s]\s*(\d{1,3}(?:\.\d+)?)',
                        r'HDG\s*[:\-=\s]\s*(\d{1,3}(?:\.\d+)?)',
                        r'YAW\s*[:\-=\s]\s*(\d{1,3}(?:\.\d+)?)',
                        r'HEAD(?:ING)?\s*[:\-=\s]\s*(\d{1,3}(?:\.\d+)?)',
                        r'C(?:OMP(?:ASS)?)?\s*[:\-=\s]\s*(\d{1,3}(?:\.\d+)?)',
                        r'DIR\s*[:\-=\s]\s*(\d{1,3}(?:\.\d+)?)']:
                m=re.search(pat,src,re.IGNORECASE)
                if m:
                    c2=float(m.group(1))
                    if 0<=c2<=360: mag_val=c2; break
        if mag_val is None:
            for pat in [r'(\d{1,3}(?:\.\d+)?)\s*°',r'°\s*(\d{1,3}(?:\.\d+)?)']:
                m=re.search(pat,combined)
                if m:
                    c2=float(m.group(1))
                    if 0<=c2<=360: mag_val=c2; break
        if mag_val is None:
            for m in re.finditer(r'\b(0\d\d|[1-3]\d\d)\b',combined):
                c2=float(m.group(1))
                bef=combined[max(0,m.start()-1):m.start()]
                aft=combined[m.end():m.end()+1]
                if bef not in '.,' and aft not in '.,':
                    mag_val=c2; break
        if mag_val is None:
            for card,deg in sorted(self.CARDINAL_DEG.items(),key=lambda x:-len(x[0])):
                if re.search(r'\b'+card+r'\b',combined,re.IGNORECASE):
                    mag_val=float(deg); break
        if mag_val is not None and 0<=mag_val<=360:
            t.mag=mag_val
        return t

    def _smooth_mag(self,v):
        if self._smooth is None: self._smooth=v; return v
        diff=((v-self._smooth)+180)%360-180
        self._smooth=(self._smooth+self._alpha*diff)%360
        return round(self._smooth,1)

    def get_debug_text(self): return self._raw_text

# ═══════════════════════════════════════════════════════════════════
#  GPS PROJECTION
# ═══════════════════════════════════════════════════════════════════

def project_to_gps(cx_frac,cy_frac,drone_lat,drone_lon,drone_alt,heading_deg):
    if drone_lat is None or drone_lon is None: return None,None
    alt=max(float(drone_alt),1.0)
    dx=cx_frac-0.5; dy=cy_frac-0.5
    gw=2*alt*math.tan(math.radians(cfg.hfov_deg/2))
    gh=2*alt*math.tan(math.radians(cfg.vfov_deg/2))
    ox=dx*gw; oy=dy*gh
    hr=math.radians(float(heading_deg or 0))
    north=-oy*math.cos(hr)-ox*math.sin(hr)
    east =-oy*math.sin(hr)+ox*math.cos(hr)
    lat=drone_lat+north/111320.0
    lon=drone_lon+east/(111320.0*math.cos(math.radians(drone_lat)))
    return round(lat,7),round(lon,7)

# ═══════════════════════════════════════════════════════════════════
#  AIM-POINT CALCULATOR  (hypotenuse trig)
# ═══════════════════════════════════════════════════════════════════
#
#  MATH:
#  Given drone GPS (φ,λ), altitude H, heading ψ, camera HFOV/VFOV,
#  and pixel aim-point (cx_frac, cy_frac):
#
#  1) Angular offsets from optical axis:
#       αx = (cx_frac - 0.5) × HFOV    [horizontal]
#       αy = (cy_frac - 0.5) × VFOV    [vertical]
#
#  2) Hypotenuse (slant range) from nadir geometry:
#       θ  = arctan(√(tan²αx + tan²αy))   ← combined off-nadir angle
#       R  = H / cos(θ)                    ← slant range (hypotenuse)
#       dx = H × tan(αx)                   ← ground offset camera-right
#       dy = H × tan(αy)                   ← ground offset camera-down
#
#  3) Rotate camera offsets by drone heading ψ → geographic N/E:
#       ΔN = -dy·cos(ψ) - dx·sin(ψ)
#       ΔE = -dy·sin(ψ) + dx·cos(ψ)
#
#  4) GPS:
#       obj_lat = φ + ΔN/111320
#       obj_lon = λ + ΔE/(111320·cos(φ))

def aim_compute(cx_frac, cy_frac, drone_lat, drone_lon, drone_alt, mag_deg):
    if drone_lat is None or drone_lon is None:
        return {"error":"No drone GPS fix"}
    if drone_alt is None or float(drone_alt)<1:
        return {"error":"Altitude missing or too low"}
    H   = float(drone_alt)
    psi = math.radians(float(mag_deg or 0))
    dx_frac = cx_frac-0.5
    dy_frac = cy_frac-0.5
    ax = math.radians(dx_frac*cfg.hfov_deg)
    ay = math.radians(dy_frac*cfg.vfov_deg)
    tax,tay = math.tan(ax),math.tan(ay)
    theta   = math.atan(math.sqrt(tax**2+tay**2))
    cos_t   = math.cos(theta)
    slant_R = H/cos_t if cos_t else H
    d_x = H*tax
    d_y = H*tay
    dN  = -d_y*math.cos(psi)-d_x*math.sin(psi)
    dE  = -d_y*math.sin(psi)+d_x*math.cos(psi)
    obj_lat = drone_lat + dN/111320.0
    obj_lon = drone_lon + dE/(111320.0*math.cos(math.radians(drone_lat)))
    ground_dist = math.sqrt(dN**2+dE**2)
    bearing = (math.degrees(math.atan2(dE,dN))+360)%360
    return {
        "aim_cx_frac":   round(cx_frac,4),
        "aim_cy_frac":   round(cy_frac,4),
        "obj_lat":       round(obj_lat,7),
        "obj_lon":       round(obj_lon,7),
        "slant_range_m": round(slant_R,2),
        "ground_dist_m": round(ground_dist,2),
        "bearing_deg":   round(bearing,1),
        "drone_alt_m":   round(H,1),
        "mag_heading":   round(math.degrees(psi),1),
        "hfov_deg":      cfg.hfov_deg,
        "vfov_deg":      cfg.vfov_deg,
        "alpha_x_deg":   round(math.degrees(ax),2),
        "alpha_y_deg":   round(math.degrees(ay),2),
        "theta_deg":     round(math.degrees(theta),2),
        "d_x_m":         round(d_x,2),
        "d_y_m":         round(d_y,2),
        "delta_north_m": round(dN,2),
        "delta_east_m":  round(dE,2),
    }

# ═══════════════════════════════════════════════════════════════════
#  A* PATHFINDER  +  OBSTACLE HEATMAP
# ═══════════════════════════════════════════════════════════════════

def astar_find_path(drone_lat,drone_lon,target_lat,target_lon,obstacles):
    """
    A* on a GRID_CELL_M × GRID_CELL_M geographic grid spanning
    ±GRID_SPAN_M from the drone.

    Returns:
      path      — list of {lat,lon,type,g,h,f,row,col} nodes
      heatmap   — list of {lat,lon,heat} for obstacle density
      node_table— all explored nodes with g/h/f values
    """
    CELL   = cfg.grid_cell_m
    SPAN   = cfg.grid_span_m
    OBS_R  = cfg.obstacle_r_m
    N      = int(2*SPAN/CELL)

    # Origin: top-left corner of grid
    cos_lat = math.cos(math.radians(drone_lat))
    ori_lat = drone_lat - SPAN/111320.0
    ori_lon = drone_lon - SPAN/(111320.0*cos_lat)

    def ll2rc(lat,lon):
        dn=(lat-ori_lat)*111320.0
        de=(lon-ori_lon)*111320.0*cos_lat
        return int((SPAN-dn)/CELL), int((SPAN+de)/CELL)

    def rc2ll(r,c):
        dn=SPAN-r*CELL; de=c*CELL-SPAN
        return ori_lat+dn/111320.0, ori_lon+de/(111320.0*cos_lat)

    def clamp(r,c):
        return max(0,min(N-1,r)), max(0,min(N-1,c))

    # ── Obstacle heatmap (cost grid) ──────────────────────────────
    # Each cell stores a float cost 0.0–1.0
    heat = np.zeros((N,N),dtype=np.float32)
    obs_cells = max(1,int(OBS_R/CELL)+1)

    heatmap_out = []  # returned to frontend
    for obs in obstacles:
        if not obs.get("gps_lat") or not obs.get("gps_lon"):
            continue
        or_,oc_ = ll2rc(obs["gps_lat"],obs["gps_lon"])
        for dr in range(-obs_cells,obs_cells+1):
            for dc in range(-obs_cells,obs_cells+1):
                r2,c2=or_+dr,oc_+dc
                if 0<=r2<N and 0<=c2<N:
                    dist=math.sqrt(dr**2+dc**2)
                    val=max(0.0,1.0-dist/obs_cells)
                    heat[r2,c2]=min(1.0,heat[r2,c2]+val)

    # Build heatmap output (sparse – only cells with heat>0.1)
    for r in range(0,N,2):
        for c in range(0,N,2):
            if heat[r,c]>0.1:
                lat_h,lon_h=rc2ll(r,c)
                heatmap_out.append({"lat":round(lat_h,6),
                                    "lon":round(lon_h,6),
                                    "heat":round(float(heat[r,c]),3)})

    blocked = heat>0.7   # cells with heat>0.7 are impassable

    # ── Start & goal ──────────────────────────────────────────────
    sr,sc = clamp(*ll2rc(drone_lat, drone_lon))
    gr,gc = clamp(*ll2rc(target_lat,target_lon))
    blocked[sr,sc]=False
    blocked[gr,gc]=False

    # ── A* ────────────────────────────────────────────────────────
    def h(a,b): return math.sqrt((a[0]-b[0])**2+(a[1]-b[1])**2)

    open_set = []
    heapq.heappush(open_set,(0,(sr,sc)))
    came_from={}
    g_score  ={(sr,sc):0.0}
    f_score  ={(sr,sc):h((sr,sc),(gr,gc))}
    dirs     =[(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]
    explored = {}   # (r,c) → {g,h,f}
    found    = False

    while open_set:
        _,cur = heapq.heappop(open_set)
        cr,cc = cur
        cur_h = h(cur,(gr,gc))
        cur_g = g_score[cur]
        explored[cur]={'g':round(cur_g,2),'h':round(cur_h,2),
                       'f':round(cur_g+cur_h,2),'r':cr,'c':cc}
        if cur==(gr,gc): found=True; break
        for dr,dc in dirs:
            nb=(cr+dr,cc+dc)
            if not(0<=nb[0]<N and 0<=nb[1]<N): continue
            if blocked[nb[0],nb[1]]: continue
            step = (1.414 if dr and dc else 1.0)*(1.0+heat[nb[0],nb[1]])
            tg   = cur_g+step
            if tg<g_score.get(nb,1e18):
                came_from[nb]=cur
                g_score[nb]=tg
                fv=tg+h(nb,(gr,gc))
                f_score[nb]=fv
                heapq.heappush(open_set,(fv,nb))

    # ── Reconstruct path ─────────────────────────────────────────
    if not found:
        path_out=[
            {"lat":drone_lat,"lon":drone_lon,"type":"start","g":0,"h":0,"f":0,"row":sr,"col":sc},
            {"lat":target_lat,"lon":target_lon,"type":"goal","g":0,"h":0,"f":0,"row":gr,"col":gc},
        ]
    else:
        cells=[]
        cur=(gr,gc)
        while cur in came_from:
            cells.append(cur); cur=came_from[cur]
        cells.append((sr,sc)); cells.reverse()
        # Simplify
        stride=max(1,len(cells)//40)
        reduced=cells[::stride]
        if cells[-1] not in reduced: reduced.append(cells[-1])
        path_out=[]
        for i,(r,c) in enumerate(reduced):
            lat_p,lon_p=rc2ll(r,c)
            tp="start" if i==0 else("goal" if i==len(reduced)-1 else "path")
            nd=explored.get((r,c),{"g":0,"h":0,"f":0})
            path_out.append({"lat":round(lat_p,7),"lon":round(lon_p,7),
                             "type":tp,"g":nd["g"],"h":nd["h"],"f":nd["f"],
                             "row":r,"col":c})

    # ── Node table (top 50 explored by lowest f) ──────────────────
    node_table=sorted(explored.values(),key=lambda x:x["f"])[:50]
    for nd in node_table:
        lat_n,lon_n=rc2ll(nd["r"],nd["c"])
        nd["lat"]=round(lat_n,6); nd["lon"]=round(lon_n,6)

    return path_out, heatmap_out, node_table

# ═══════════════════════════════════════════════════════════════════
#  SHARED STATE
# ═══════════════════════════════════════════════════════════════════

state       = ServerState()
_lock       = threading.Lock()
_frame_b64  = None
_latest_dets: list = []
_latest_telem = Telemetry()
_targets:  dict = {}
_alt_hist: deque = deque(maxlen=120)
_clients:  set   = set()

detector = YOLODetector()
hud_reader = HUDReader()

# ═══════════════════════════════════════════════════════════════════
#  VIDEO THREAD
# ═══════════════════════════════════════════════════════════════════

def video_thread():
    global _frame_b64,_latest_dets,_latest_telem
    cap=cv2.VideoCapture(cfg.camera_index)
    if not cap.isOpened():
        log.warning(f"Camera {cfg.camera_index} not found — DEMO mode")
        _demo_thread(); return
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,cfg.camera_w)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT,cfg.camera_h)
    cap.set(cv2.CAP_PROP_FPS,cfg.target_fps)
    log.info(f"Camera {cfg.camera_index} open ({cfg.camera_w}×{cfg.camera_h})")
    fps_t=time.time(); fps_c=0
    while True:
        ok,frame=cap.read()
        if not ok: time.sleep(0.1); continue
        telem = hud_reader.read(frame)
        dets,ann = detector.detect(frame)
        for d in dets:
            if telem.lat and telem.lon:
                d.gps_lat,d.gps_lon=project_to_gps(
                    d.cx_frac,d.cy_frac,
                    telem.lat,telem.lon,telem.alt or 100,telem.mag or 0)
        for tid,tgt in _targets.items():
            bx=tgt.get("bbox")
            if bx:
                cv2.rectangle(ann,(bx[0]-2,bx[1]-2),(bx[2]+2,bx[3]+2),(0,0,255),3)
                cv2.putText(ann,f"TARGET:{tgt['label']}",(bx[0],bx[1]-14),
                            cv2.FONT_HERSHEY_SIMPLEX,0.6,(0,0,255),2)
        hw=frame.shape[1]; hh_=frame.shape[0]
        hx1=int(cfg.hud_x*hw); hy2=int((cfg.hud_y+cfg.hud_h)*hh_)
        cv2.rectangle(ann,(hx1,0),(hw-1,hy2),(0,255,180),1)
        _,buf=cv2.imencode('.jpg',ann,[cv2.IMWRITE_JPEG_QUALITY,cfg.jpeg_quality])
        b64=base64.b64encode(buf).decode()
        fps_c+=1
        if time.time()-fps_t>=1.0:
            state.fps=round(fps_c/(time.time()-fps_t),1); fps_c=0; fps_t=time.time()
        with _lock:
            _frame_b64=b64; _latest_dets=dets; _latest_telem=telem
            _alt_hist.append({"t":_now(),"alt":telem.alt or 0})
            state.frame_count+=1; state.connected=True
        time.sleep(1.0/cfg.target_fps)
    cap.release()

def _demo_thread():
    import random
    global _frame_b64,_latest_dets,_latest_telem
    lat=cfg.manual_lat or 27.1751
    lon=cfg.manual_lon or 78.0421
    alt=cfg.manual_alt or 100.0
    mag=45.0; tick=0
    while True:
        tick+=1
        lat+=0.00002+random.gauss(0,0.000005)
        lon+=0.00003+random.gauss(0,0.000005)
        alt+=random.gauss(0,0.5); alt=max(20,min(200,alt))
        mag=(mag+random.gauss(0,0.5))%360
        telem=Telemetry(lat=round(lat,7),lon=round(lon,7),
                        alt=round(alt,1),mag=round(mag,1),timestamp=_now())
        frame=np.zeros((cfg.camera_h,cfg.camera_w,3),dtype=np.uint8)
        for x in range(0,cfg.camera_w,80): cv2.line(frame,(x,0),(x,cfg.camera_h),(0,40,20),1)
        for y in range(0,cfg.camera_h,80): cv2.line(frame,(0,y),(cfg.camera_w,y),(0,40,20),1)
        for i,line in enumerate([f"LAT: {lat:.6f}",f"LON: {lon:.6f}",
                                  f"ALT: {alt:.1f}m",f"MAG: {mag:.0f}"]):
            cv2.putText(frame,line,(900,25+i*22),cv2.FONT_HERSHEY_SIMPLEX,0.65,(0,255,180),1)
        objs=[("person",200,300),("car",600,400),("dog",900,500),("truck",400,200)]
        dets=[]
        for cls,bx,by in objs:
            jx=bx+random.randint(-5,5); jy=by+random.randint(-5,5)
            c=CLASS_CFG.get(cls,CLASS_CFG["_default"])
            bgr=_hex_bgr(c["color"])
            cv2.rectangle(frame,(jx-30,jy-30),(jx+30,jy+30),bgr,2)
            cv2.putText(frame,c["label"],(jx-28,jy-34),cv2.FONT_HERSHEY_SIMPLEX,0.5,bgr,1)
            gx,gy=project_to_gps(jx/cfg.camera_w,jy/cfg.camera_h,lat,lon,alt,mag)
            dets.append(Detection(id=f"{cls}_{jx}_{jy}",class_name=cls,
                label=c["label"],group=c["group"],color=c["color"],icon=c["icon"],
                confidence=round(random.uniform(0.6,0.95),2),
                bbox=[jx-30,jy-30,jx+30,jy+30],
                cx_frac=round(jx/cfg.camera_w,4),cy_frac=round(jy/cfg.camera_h,4),
                gps_lat=gx,gps_lon=gy,timestamp=_now()))
        for tid,tgt in _targets.items():
            bx2=tgt.get("bbox",[100,100,160,160])
            cv2.rectangle(frame,(bx2[0]-2,bx2[1]-2),(bx2[2]+2,bx2[3]+2),(0,0,255),3)
        _,buf=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,cfg.jpeg_quality])
        b64=base64.b64encode(buf).decode()
        with _lock:
            _frame_b64=b64; _latest_dets=dets; _latest_telem=telem
            _alt_hist.append({"t":_now(),"alt":round(alt,1)})
            state.fps=cfg.target_fps*1.0; state.frame_count+=1; state.connected=True
        time.sleep(1.0/cfg.target_fps)

# ═══════════════════════════════════════════════════════════════════
#  FASTAPI
# ═══════════════════════════════════════════════════════════════════

app = FastAPI(title="DRONEIQ",version="3.0")
app.add_middleware(CORSMiddleware,allow_origins=["*"],
                   allow_methods=["*"],allow_headers=["*"])

@app.on_event("startup")
async def startup():
    detector.load()
    threading.Thread(target=video_thread,daemon=True).start()
    log.info("Video thread started.")

# ── Main data WebSocket ───────────────────────────────────────────
@app.websocket("/ws")
async def ws_data(ws: WebSocket):
    await ws.accept(); _clients.add(ws)
    try:
        while True:
            await asyncio.sleep(0.05)
            with _lock:
                fb=_frame_b64
                dets=[asdict(d) for d in _latest_dets]
                telem=asdict(_latest_telem)
                ah=list(_alt_hist)
            if fb is None: continue
            await ws.send_text(json.dumps({
                "type":"frame","frame":fb,
                "detections":dets,"telemetry":telem,
                "targets":_targets,"alt_history":ah[-60:],
                "fps":state.fps,"frame_count":state.frame_count,
                "config":asdict(cfg),
            }))
    except WebSocketDisconnect: pass
    except Exception as e: log.warning(f"WS err:{e}")
    finally: _clients.discard(ws)

# ── Command WebSocket ─────────────────────────────────────────────
@app.websocket("/ws/cmd")
async def ws_cmd(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            raw=await ws.receive_text()
            cmd=json.loads(raw)
            result=_handle_cmd(cmd)
            payload={"ok":True,"targets":_targets}
            if isinstance(result,dict): payload["aim_result"]=result
            await ws.send_text(json.dumps(payload))
    except WebSocketDisconnect: pass
    except Exception as e: log.warning(f"CMD WS err:{e}")

def _handle_cmd(cmd):
    action=cmd.get("action")
    if action=="mark_target":
        d=cmd.get("detection",{})
        tid=d.get("id",f"tgt_{int(time.time()*1000)}")
        _targets[tid]={
            "id":tid,"label":d.get("label","Target"),
            "class":d.get("class_name","unknown"),
            "color":d.get("color","#ff0000"),"icon":d.get("icon","📍"),
            "group":d.get("group","unknown"),"confidence":d.get("confidence",0),
            "bbox":d.get("bbox"),"gps_lat":d.get("gps_lat"),
            "gps_lon":d.get("gps_lon"),"marked_at":_now(),"note":cmd.get("note",""),
        }
    elif action=="unmark_target":
        tid=cmd.get("target_id")
        if tid in _targets: del _targets[tid]
    elif action=="clear_targets":
        _targets.clear()
    elif action=="aim_query":
        cx=float(cmd.get("cx_frac",0.5)); cy=float(cmd.get("cy_frac",0.5))
        with _lock: t=_latest_telem; dets=list(_latest_dets)
        res=aim_compute(cx,cy,t.lat,t.lon,t.alt,t.mag or 0)
        if "error" not in res:
            obs=[asdict(d) for d in dets]
            path,hmap,ntable=astar_find_path(t.lat,t.lon,
                                              res["obj_lat"],res["obj_lon"],obs)
            res["path"]=path; res["heatmap"]=hmap; res["node_table"]=ntable
        return res
    elif action=="update_config":
        patch=cmd.get("config",{})
        for k,v in patch.items():
            if hasattr(cfg,k): setattr(cfg,k,type(getattr(cfg,k))(v) if getattr(cfg,k) is not None else v)
        log.info(f"Config updated: {patch}")

# ── REST endpoints ────────────────────────────────────────────────
@app.post("/api/aim")
async def api_aim(body:dict):
    cx=float(body.get("cx_frac",0.5)); cy=float(body.get("cy_frac",0.5))
    with _lock: t=_latest_telem; dets=list(_latest_dets)
    res=aim_compute(cx,cy,t.lat,t.lon,t.alt,t.mag or 0)
    if "error" not in res:
        obs=[asdict(d) for d in dets]
        path,hmap,ntable=astar_find_path(t.lat,t.lon,res["obj_lat"],res["obj_lon"],obs)
        res["path"]=path; res["heatmap"]=hmap; res["node_table"]=ntable
    return {"ok":"error" not in res,**res}

@app.get("/api/config")
def get_config(): return asdict(cfg)

@app.post("/api/config")
async def set_config(body:dict):
    for k,v in body.items():
        if hasattr(cfg,k): setattr(cfg,k,v)
    return asdict(cfg)

@app.get("/api/targets")
def get_targets(): return {"targets":list(_targets.values())}

@app.delete("/api/targets/{tid}")
def del_target(tid:str):
    if tid in _targets: del _targets[tid]
    return {"ok":True}

@app.delete("/api/targets")
def clear_targets(): _targets.clear(); return {"ok":True}

@app.get("/api/hud/debug")
def hud_debug():
    with _lock: t=_latest_telem
    return {"raw_ocr":hud_reader.get_debug_text(),
            "parsed":asdict(t),
            "hud_region":{"x":cfg.hud_x,"y":cfg.hud_y,"w":cfg.hud_w,"h":cfg.hud_h}}

@app.get("/api/status")
def status(): return {"connected":state.connected,"fps":state.fps,
                      "frames":state.frame_count,"targets":len(_targets)}

# ── Helpers ───────────────────────────────────────────────────────
def _hex_bgr(h):
    h=h.lstrip("#"); r,g,b=int(h[0:2],16),int(h[2:4],16),int(h[4:6],16)
    return (b,g,r)
def _now(): return datetime.now(timezone.utc).isoformat()

import base64   # ensure imported

if __name__=="__main__":
    uvicorn.run("drone_server:app",host="0.0.0.0",port=8000,
                log_level="info",ws_ping_interval=20,ws_ping_timeout=20)
