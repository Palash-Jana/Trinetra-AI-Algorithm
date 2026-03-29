# DRONEIQ — Aerial Intelligence Mapping System
# Created by Palash Jana 
## Architecture

```
droneiq/
├── drone_server.py          ← Python FastAPI backend (WebSocket + REST)
├── requirements.txt
└── frontend/
    ├── package.json
    ├── public/index.html
    └── src/
        ├── App.jsx            ← Root layout
        ├── App.css
        ├── index.js
        ├── index.css          ← Global styles + CSS variables
        ├── hooks/
        │   └── useDroneSocket.js   ← WebSocket state manager
        └── components/
            ├── VideoPanel.jsx      ← Live feed + click-to-target
            ├── VideoPanel.css
            ├── MapPanel.jsx        ← Leaflet 2D map
            ├── MapPanel.css
            ├── BottomBar.jsx       ← Detections, Telemetry, Chart, Compass
            └── BottomBar.css
```

## Setup

### 1. Python Backend

```bash
# Install Tesseract OCR
# Windows: https://github.com/UB-Mannheim/tesseract/wiki
# Linux:   sudo apt install tesseract-ocr
# macOS:   brew install tesseract

pip install -r requirements.txt
python drone_server.py
```

If no camera is found, the server automatically runs in **DEMO mode**
with synthetic data so you can test the full dashboard.

### 2. React Frontend

```bash
cd frontend
npm install
npm start
```

Open http://localhost:3000

---

## How It Works

### Video + Detection
- USB camera feed captured at 25 FPS
- YOLOv8 runs object detection every frame
- Detected objects: Humans, Vehicles, Tanks, Helicopters, Animals, Structures
- Bounding boxes drawn on video, sent to frontend as base64 JPEG

### HUD OCR (top-right corner)
- Tesseract crops the top-right 35% × 18% of the frame
- Parses: LAT, LON, ALT, MAG (magnetometer/heading)
- Runs every 5 frames (for performance)
- Values cached between OCR runs for smooth updates

### GPS Projection
- Each detected object's pixel centre is projected to real GPS
- Uses drone altitude + heading + camera FOV geometry
- Objects appear as map markers at their real-world positions

### Click-to-Target
- Click any detected object in the video panel
- Object is marked as TARGET (red border in video, red pin on map)
- Target appears in the map with popup (label, class, GPS, time)
- Target list shown in bottom bar; can remove individually or all at once

### Dashboard Layout
```
┌─────────────────────────────────────────────────────────────┐
│  HEADER: Logo | LAT LON ALT MAG strip | Objects Targets FPS │
├────────────────────────┬────────────────────────────────────┤
│                        │                                    │
│   LIVE VIDEO FEED      │      2D TACTICAL MAP               │
│   (with YOLO boxes)    │      (Leaflet, real GPS)           │
│   Click → TARGET       │      Drone pos, trail, objects     │
│                        │                                    │
├──────────┬─────────────┴──────────────┬─────────┬──────────┤
│DETECTIONS│   TELEMETRY               │ ALT     │ COMPASS  │
│grouped + │   LAT/LON/ALT/MAG         │ CHART   │ ROSE     │
│list+btns │   live values             │recharts │animated  │
└──────────┴───────────────────────────┴─────────┴──────────┘
```

## Configuration

Edit `drone_server.py`:
```python
CAMERA_INDEX = 0       # USB camera (0=first, 1=second …)
YOLO_MODEL   = "yolov8n.pt"  # nano=fast, s/m=accurate
YOLO_CONF    = 0.40    # detection confidence threshold
HUD_X_FRAC   = 0.65   # HUD region start x (fraction of width)
HUD_Y_FRAC   = 0.00   # HUD region start y
HUD_W_FRAC   = 0.35   # HUD width fraction
HUD_H_FRAC   = 0.18   # HUD height fraction
HFOV_DEG     = 70.0   # camera horizontal FOV (degrees)
VFOV_DEG     = 50.0   # camera vertical FOV
```

# Creator👨‍💻: PALASH JANA
# Creator GitHub🖇️: https://github.com/Palash-Jana
