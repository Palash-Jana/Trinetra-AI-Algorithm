// VideoPanel.jsx  v3.0
// Created by Palash Jana (Trinetra algorithm M1) on 2026-03-15
// Features:
//  • Military aim reticle (yellow crosshair + rings + diagonal ticks)
//  • Mouse hover → real-time GPS via hypotenuse trig
//  • Click → lock aim + run A* pathfinding
//  • Floating GPS popup beside reticle
//  • Trig math panel (toggle)
//  • YOLO detection overlays with click-to-target
//  • Setup panel shown on first load (camera angle + initial position)

import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import './VideoPanel.css';

const ORIG_W = 1280, ORIG_H = 720;
const THROTTLE_MS = 80;

export default function VideoPanel({
  frame, detections, targets, fps, connected,
  onMarkTarget, sendCommand, aimResult, astarPath,
  showSetup,   // bool — parent controls whether setup modal is shown
}) {
  const containerRef = useRef(null);
  const lastSent     = useRef(0);

  const [aimPos,    setAimPos]    = useState({ x: 0.5, y: 0.5 });
  const [locked,    setLocked]    = useState(false);
  const [flash,     setFlash]     = useState(false);
  const [showMath,  setShowMath]  = useState(false);
  const [hoverDet,  setHoverDet]  = useState(null);
  const [detFlash,  setDetFlash]  = useState(null);

  const pxToFrac = useCallback((cx, cy) => {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return { x: 0.5, y: 0.5 };
    return {
      x: Math.max(0, Math.min(1, (cx - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (cy - r.top)  / r.height)),
    };
  }, []);

  const sendAim = useCallback((fx, fy) => {
    const now = Date.now();
    if (now - lastSent.current < THROTTLE_MS) return;
    lastSent.current = now;
    sendCommand({ action: 'aim_query', cx_frac: fx, cy_frac: fy });
  }, [sendCommand]);

  const onMouseMove = useCallback((e) => {
    if (locked) return;
    const { x, y } = pxToFrac(e.clientX, e.clientY);
    setAimPos({ x, y });
    sendAim(x, y);
  }, [locked, pxToFrac, sendAim]);

  const onClick = useCallback((e) => {
    if (e.detail === 2) return; // handled by dblclick
    const { x, y } = pxToFrac(e.clientX, e.clientY);

    // Check detection hit
    let hit = null;
    for (const det of detections) {
      const dx = det.cx_frac - x, dy = det.cy_frac - y;
      if (Math.sqrt(dx*dx + dy*dy) < 0.09) { hit = det; break; }
    }
    if (hit) {
      setDetFlash(hit.id);
      setTimeout(() => setDetFlash(null), 600);
      onMarkTarget(hit);
      return;
    }
    // Lock aim + query
    setAimPos({ x, y });
    setFlash(true);
    setTimeout(() => setFlash(false), 400);
    sendAim(x, y);
  }, [pxToFrac, detections, onMarkTarget, sendAim]);

  const onDblClick = useCallback((e) => {
    setLocked(l => !l);
    if (!locked) {
      const { x, y } = pxToFrac(e.clientX, e.clientY);
      setAimPos({ x, y });
      sendAim(x, y);
    }
  }, [locked, pxToFrac, sendAim]);

  const onTouchMove = useCallback((e) => {
    e.preventDefault();
    if (locked) return;
    const t = e.touches[0];
    const { x, y } = pxToFrac(t.clientX, t.clientY);
    setAimPos({ x, y });
    sendAim(x, y);
  }, [locked, pxToFrac, sendAim]);

  const isTarget = useCallback((det) =>
    Object.values(targets).some(t => t.id === det.id), [targets]);

  const aimStyle = useMemo(() => ({
    left: `${aimPos.x * 100}%`,
    top:  `${aimPos.y * 100}%`,
  }), [aimPos]);

  // Clamp popup so it doesn't go off right/bottom edge
  const popupStyle = useMemo(() => {
    const offX = aimPos.x > 0.75 ? '-160px' : '46px';
    const offY = aimPos.y > 0.8  ? '-80px'  : '-20px';
    return { left: `calc(${aimPos.x*100}% + ${offX})`,
             top:  `calc(${aimPos.y*100}% + ${offY})` };
  }, [aimPos]);

  const ar = aimResult;

  return (
    <div className="video-panel">
      {/* Header */}
      <div className="vp-header">
        <div className="vp-title"><span className="vp-title-bar"/>LIVE AERIAL FEED</div>
        <div className="vp-badges">
          <span className="badge badge-fps">{fps.toFixed(0)} FPS</span>
          <span className="badge badge-det">{detections.length} OBJECTS</span>
          <span className="badge badge-aim"
                onClick={() => setShowMath(m => !m)}
                title="Toggle trig math">
            ⊕ AIM {locked ? '🔒' : ''}
          </span>
          <span className={`badge ${connected ? 'badge-live' : 'badge-off'}`}>
            {connected ? '● LIVE' : '○ OFFLINE'}
          </span>
        </div>
      </div>

      {/* Video area */}
      <div className="vp-container" ref={containerRef}
           onMouseMove={onMouseMove} onClick={onClick}
           onDoubleClick={onDblClick} onTouchMove={onTouchMove}
           style={{ cursor: 'none' }}>

        {frame
          ? <img className="vp-frame" src={`data:image/jpeg;base64,${frame}`}
                 alt="drone" draggable={false}/>
          : <div className="vp-waiting">
              <div className="vp-spinner"/>
              <div className="vp-wait-title">ACQUIRING FEED</div>
              <div className="vp-wait-sub">Connect drone · Start drone_server.py</div>
            </div>
        }

        {/* YOLO overlays */}
        {frame && containerRef.current && detections.map(det => {
          const W = containerRef.current.clientWidth;
          const H = containerRef.current.clientHeight;
          const [b1,b2,b3,b4] = det.bbox;
          const sx=W/ORIG_W, sy=H/ORIG_H;
          const color = det.color || '#fff';
          const isTgt = isTarget(det);
          return (
            <div key={det.id}
                 className={`det-overlay ${isTgt?'det-target':''} ${detFlash===det.id?'det-flash':''}`}
                 style={{ left:b1*sx, top:b2*sy,
                          width:(b3-b1)*sx, height:(b4-b2)*sy,
                          '--det-color':color, pointerEvents:'none' }}
                 onMouseEnter={()=>setHoverDet(det.id)}
                 onMouseLeave={()=>setHoverDet(null)}>
              <span className="det-label">{det.icon} {det.label} {(det.confidence*100).toFixed(0)}%</span>
              {isTgt && <span className="det-target-badge">TARGET</span>}
              {(hoverDet===det.id||isTgt) && det.gps_lat &&
                <span className="det-gps">{det.gps_lat.toFixed(5)}, {det.gps_lon.toFixed(5)}</span>}
            </div>
          );
        })}

        {/* Corner brackets */}
        <div className="corner corner-tl"/><div className="corner corner-tr"/>
        <div className="corner corner-bl"/><div className="corner corner-br"/>

        {/* HUD region box */}
        <div className="hud-indicator"><span className="hud-label">HUD OCR</span></div>

        {/* ═══════ AIM RETICLE ═══════ */}
        {frame && (
          <div className={`reticle-aim ${locked?'reticle-locked':''} ${flash?'reticle-flash':''}`}
               style={aimStyle}>
            <div className="ra-ring ra-ring-outer"/>
            <div className="ra-ring ra-ring-mid"/>
            <div className="ra-dot"/>
            {/* 4-segment crosshair with centre gap */}
            <div className="ra-cross ra-t"/>
            <div className="ra-cross ra-b"/>
            <div className="ra-cross ra-l"/>
            <div className="ra-cross ra-r"/>
            {/* Diagonal ticks */}
            <div className="ra-tick ra-tick-tl"/>
            <div className="ra-tick ra-tick-tr"/>
            <div className="ra-tick ra-tick-bl"/>
            <div className="ra-tick ra-tick-br"/>
            {/* Range badge */}
            {ar && !ar.error && (
              <div className="ra-range-badge">
                <span className="rrb-dist">{ar.ground_dist_m?.toFixed(0)}m</span>
                <span className="rrb-bearing">{ar.bearing_deg?.toFixed(0)}°</span>
              </div>
            )}
          </div>
        )}

        {/* GPS popup beside reticle */}
        {frame && ar && !ar.error && (
          <div className="aim-popup" style={popupStyle}>
            <div className="ap-row"><span>LAT</span><b>{ar.obj_lat?.toFixed(6)}</b></div>
            <div className="ap-row"><span>LON</span><b>{ar.obj_lon?.toFixed(6)}</b></div>
            <div className="ap-row"><span>RNG</span>
              <b style={{color:'var(--amber)'}}>{ar.slant_range_m?.toFixed(1)}m</b></div>
            <div className="ap-row"><span>BRG</span><b>{ar.bearing_deg?.toFixed(0)}°</b></div>
            {locked && <div className="ap-locked">🔒 LOCKED</div>}
          </div>
        )}

        {/* Trig math panel */}
        {showMath && ar && !ar.error && (
          <div className="math-panel">
            <div className="mp-title">⊕ HYPOTENUSE CALCULATION</div>
            {[
              ['Drone Alt (H)',        `${ar.drone_alt_m}m`],
              ['Camera HFOV',         `${ar.hfov_deg}°`],
              ['Camera VFOV',         `${ar.vfov_deg}°`],
              ['Heading (ψ)',          `${ar.mag_heading}°`],
              ['αx = (cx-0.5)×HFOV', `${ar.alpha_x_deg}°`],
              ['αy = (cy-0.5)×VFOV', `${ar.alpha_y_deg}°`],
              ['θ=arctan(√tan²αx+tan²αy)', `${ar.theta_deg}°`],
              ['R = H/cos(θ)',         `${ar.slant_range_m}m`, true],
              ['dx = H·tan(αx)',       `${ar.d_x_m}m`],
              ['dy = H·tan(αy)',       `${ar.d_y_m}m`],
              ['ΔNorth',               `${ar.delta_north_m}m`],
              ['ΔEast',                `${ar.delta_east_m}m`],
              ['Ground dist',          `${ar.ground_dist_m}m`, true],
              ['Bearing to obj',       `${ar.bearing_deg}°`, true],
            ].map(([k,v,hi])=>(
              <div key={k} className={`mp-row ${hi?'mp-hi':''}`}>
                <span>{k}</span><b>{v}</b>
              </div>
            ))}
            <div className="mp-gps">{ar.obj_lat?.toFixed(7)}<br/>{ar.obj_lon?.toFixed(7)}</div>
          </div>
        )}

        {/* Bottom hint bar */}
        {frame && (
          <div className="vp-hint">
            <span>HOVER → aim</span>
            <span>CLICK → lock + A*</span>
            <span>DBL-CLICK → {locked?'unlock':'lock'}</span>
            <span>⊕ AIM → math</span>
          </div>
        )}
      </div>
    </div>
  );
}
