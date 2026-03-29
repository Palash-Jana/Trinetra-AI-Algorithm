// App.jsx v3.0 — DRONEIQ Dashboard
// New in v3:
// Created by Palash Jana (Trinetra algorithm M1) on 2026-03-15
//  • Setup modal: user enters camera HFOV/VFOV + initial drone position
//  • A* Node Table panel: shows explored nodes with g/h/f values
//  • Heatmap data passed to MapPanel
//  • Aim result wired from socket → VideoPanel → MapPanel

import React, { useCallback, useState, useEffect } from 'react';
import './App.css';
import { useDroneSocket } from './hooks/useDroneSocket';
import VideoPanel from './components/VideoPanel';
import MapPanel   from './components/MapPanel';
import {
  DetectionsList, TelemetryPanel, AltitudeChart, CompassPanel,
} from './components/BottomBar';

// ═══════════════════════════════════════════════════════════════════
//  SETUP MODAL
// ═══════════════════════════════════════════════════════════════════
function SetupModal({ onDone }) {
  const [hfov, setHfov]   = useState(70);
  const [vfov, setVfov]   = useState(50);
  const [lat,  setLat]    = useState('');
  const [lon,  setLon]    = useState('');
  const [alt,  setAlt]    = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onDone({
      hfov_deg:   parseFloat(hfov),
      vfov_deg:   parseFloat(vfov),
      manual_lat: lat  ? parseFloat(lat)  : null,
      manual_lon: lon  ? parseFloat(lon)  : null,
      manual_alt: alt  ? parseFloat(alt)  : null,
    });
  };

  return (
    <div className="setup-overlay">
      <div className="setup-modal">
        <div className="sm-header">
          <div className="sm-emblem">⊕</div>
          <div>
            <div className="sm-title">DRONEIQ SYSTEM SETUP</div>
            <div className="sm-sub">Configure camera and initial position</div>
          </div>
        </div>

        <form onSubmit={handleSubmit}>

          {/* Camera angle section */}
          <div className="sm-section">
            <div className="sm-section-title">📷 CAMERA FIELD OF VIEW</div>
            <div className="sm-hint">
              Check your drone camera spec sheet for FOV values.<br/>
              Common: DJI Mini = 83°H / 56°V · FPV = 160°H / 110°V
            </div>
            <div className="sm-row">
              <div className="sm-field">
                <label>Horizontal FOV (HFOV)</label>
                <div className="sm-input-wrap">
                  <input type="number" min="20" max="200" step="0.5"
                         value={hfov} onChange={e=>setHfov(e.target.value)} required/>
                  <span className="sm-unit">°</span>
                </div>
                <div className="sm-field-hint">Typical: 60–120°</div>
              </div>
              <div className="sm-field">
                <label>Vertical FOV (VFOV)</label>
                <div className="sm-input-wrap">
                  <input type="number" min="10" max="180" step="0.5"
                         value={vfov} onChange={e=>setVfov(e.target.value)} required/>
                  <span className="sm-unit">°</span>
                </div>
                <div className="sm-field-hint">Typical: 45–90°</div>
              </div>
            </div>
            {/* Visual FOV diagram */}
            <div className="fov-diagram">
              <svg viewBox="0 0 200 100" fill="none">
                <rect x="85" y="35" width="30" height="30" stroke="#00d2ff" strokeWidth="1.5" rx="2"/>
                <line x1="100" y1="35" x2="30" y2="5" stroke="rgba(0,210,255,0.4)" strokeWidth="1"/>
                <line x1="100" y1="35" x2="170" y2="5" stroke="rgba(0,210,255,0.4)" strokeWidth="1"/>
                <line x1="100" y1="65" x2="20" y2="95" stroke="rgba(0,210,255,0.2)" strokeWidth="1"/>
                <line x1="100" y1="65" x2="180" y2="95" stroke="rgba(0,210,255,0.2)" strokeWidth="1"/>
                <text x="100" y="50" textAnchor="middle" fill="#00d2ff" fontSize="8" fontFamily="monospace">LENS</text>
                <text x="100" y="20" textAnchor="middle" fill="rgba(0,210,255,0.6)" fontSize="7">← HFOV {hfov}° →</text>
                <text x="18" y="55" fill="rgba(0,210,255,0.5)" fontSize="6" transform="rotate(-90,18,55)">VFOV {vfov}°</text>
              </svg>
            </div>
          </div>

          {/* Initial position */}
          <div className="sm-section">
            <div className="sm-section-title">📍 INITIAL DRONE POSITION <span className="sm-optional">(optional — uses HUD OCR if blank)</span></div>
            <div className="sm-row">
              <div className="sm-field">
                <label>Latitude</label>
                <div className="sm-input-wrap">
                  <input type="number" step="0.000001" placeholder="e.g. 27.175100"
                         value={lat} onChange={e=>setLat(e.target.value)}/>
                  <span className="sm-unit">°</span>
                </div>
              </div>
              <div className="sm-field">
                <label>Longitude</label>
                <div className="sm-input-wrap">
                  <input type="number" step="0.000001" placeholder="e.g. 78.042100"
                         value={lon} onChange={e=>setLon(e.target.value)}/>
                  <span className="sm-unit">°</span>
                </div>
              </div>
              <div className="sm-field">
                <label>Altitude (AGL)</label>
                <div className="sm-input-wrap">
                  <input type="number" step="0.1" placeholder="e.g. 100"
                         value={alt} onChange={e=>setAlt(e.target.value)}/>
                  <span className="sm-unit">m</span>
                </div>
              </div>
            </div>
          </div>

          <button type="submit" className="sm-btn">
            ▶ LAUNCH SYSTEM
          </button>
        </form>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  A* NODE TABLE
// ═══════════════════════════════════════════════════════════════════
function AStarPanel({ aimResult }) {
  const [show, setShow] = useState(true);
  if (!aimResult || aimResult.error || !aimResult.node_table) return null;
  const { node_table, path } = aimResult;

  return (
    <div className="astar-panel">
      <div className="asp-header" onClick={()=>setShow(s=>!s)}>
        <span className="asp-title">A* PATHFINDER NODES</span>
        <span className="asp-meta">
          {path?.length} path pts · {node_table.length} explored
          · dist {aimResult.ground_dist_m?.toFixed(0)}m
        </span>
        <span className="asp-toggle">{show?'▲':'▼'}</span>
      </div>
      {show && (
        <>
          {/* Path summary */}
          <div className="asp-path-bar">
            {path?.map((wp,i)=>(
              <div key={i} className={`apb-node apb-${wp.type}`}>
                <div className="apb-type">{wp.type.toUpperCase()}</div>
                <div className="apb-coords">{wp.lat?.toFixed(4)},{wp.lon?.toFixed(4)}</div>
                {wp.f>0 && <div className="apb-f">f={wp.f?.toFixed(1)}</div>}
              </div>
            ))}
          </div>
          {/* Node table */}
          <div className="asp-table-wrap">
            <table className="asp-table">
              <thead>
                <tr>
                  <th>#</th><th>Row</th><th>Col</th>
                  <th>g (cost from start)</th>
                  <th>h (heuristic to goal)</th>
                  <th>f = g + h</th>
                  <th>LAT</th><th>LON</th>
                </tr>
              </thead>
              <tbody>
                {node_table.map((nd,i)=>(
                  <tr key={i} className={i===0?'nt-best':''}>
                    <td>{i+1}</td>
                    <td>{nd.r}</td><td>{nd.c}</td>
                    <td className="nt-g">{nd.g?.toFixed(2)}</td>
                    <td className="nt-h">{nd.h?.toFixed(2)}</td>
                    <td className="nt-f">{nd.f?.toFixed(2)}</td>
                    <td>{nd.lat?.toFixed(5)}</td>
                    <td>{nd.lon?.toFixed(5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [setupDone, setSetupDone] = useState(false);

  const {
    frame, detections, telemetry, targets,
    altHistory, fps, connected,
    aimResult, astarPath,
    sendCommand,
  } = useDroneSocket();

  // Send config to server after setup
  const handleSetupDone = useCallback((config) => {
    setSetupDone(true);
    sendCommand({ action: 'update_config', config });
  }, [sendCommand]);

  const handleMarkTarget   = useCallback(det => sendCommand({action:'mark_target',detection:det}),[sendCommand]);
  const handleRemoveTarget = useCallback(tid => sendCommand({action:'unmark_target',target_id:tid}),[sendCommand]);
  const handleClearTargets = useCallback(()  => sendCommand({action:'clear_targets'}),[sendCommand]);

  const targetCount = Object.keys(targets).length;

  return (
    <div className="app-root">
      {/* Setup modal on first load */}
      {!setupDone && <SetupModal onDone={handleSetupDone}/>}

      {/* ── HEADER ──────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="hdr-left">
          <div className="hdr-emblem">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10
                       10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
            </svg>
          </div>
          <div>
            <div className="hdr-title">DRONEIQ</div>
            <div className="hdr-sub">AERIAL INTELLIGENCE MAPPING SYSTEM v3.0</div>
          </div>
        </div>

        <div className="hdr-center">
          <div className="hdr-telem-strip">
            {[['LAT',telemetry.lat?.toFixed(6),''],
              ['LON',telemetry.lon?.toFixed(6),''],
              ['ALT',telemetry.alt?.toFixed(1)+'m','var(--green)'],
              ['MAG',telemetry.mag?.toFixed(0)+'°','var(--purple)'],
            ].map(([lbl,val,col],i)=>(
              <React.Fragment key={lbl}>
                {i>0 && <div className="hts-sep">|</div>}
                <div className="hts-item">
                  <span className="hts-label">{lbl}</span>
                  <span className="hts-val" style={col?{color:col}:{}}>{val??'---'}</span>
                </div>
              </React.Fragment>
            ))}
            {/* Aim point live read */}
            {aimResult && !aimResult.error && (
              <>
                <div className="hts-sep">|</div>
                <div className="hts-item">
                  <span className="hts-label" style={{color:'#ffdc32'}}>AIM LAT</span>
                  <span className="hts-val" style={{color:'#ffdc32'}}>{aimResult.obj_lat?.toFixed(6)}</span>
                </div>
                <div className="hts-sep">|</div>
                <div className="hts-item">
                  <span className="hts-label" style={{color:'#ffdc32'}}>AIM LON</span>
                  <span className="hts-val" style={{color:'#ffdc32'}}>{aimResult.obj_lon?.toFixed(6)}</span>
                </div>
                <div className="hts-sep">|</div>
                <div className="hts-item">
                  <span className="hts-label" style={{color:'var(--amber)'}}>RNG</span>
                  <span className="hts-val" style={{color:'var(--amber)'}}>{aimResult.slant_range_m?.toFixed(0)}m</span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="hdr-right">
          {[['OBJECTS',detections.length,''],
            ['TARGETS',targetCount,'var(--red)'],
            ['FPS',fps.toFixed(0),''],
          ].map(([lbl,val,col])=>(
            <div key={lbl} className="hdr-stat">
              <span className="hs-label">{lbl}</span>
              <span className="hs-val" style={col?{color:col}:{}}>{val}</span>
            </div>
          ))}
          <div className={`hdr-conn ${connected?'hdr-conn-live':''}`}>
            <span className="hdr-conn-dot"/>
            {connected?'CONNECTED':'OFFLINE'}
          </div>
          <button className="hdr-setup-btn" onClick={()=>setSetupDone(false)}>⚙ SETUP</button>
          {targetCount>0 &&
            <button className="hdr-clear-btn" onClick={handleClearTargets}>✕ TARGETS</button>}
        </div>
      </header>

      {/* ── MAIN CONTENT ────────────────────────────────────────── */}
      <main className="app-main">
        <VideoPanel
          frame={frame} detections={detections} targets={targets}
          fps={fps} connected={connected}
          onMarkTarget={handleMarkTarget}
          sendCommand={sendCommand}
          aimResult={aimResult}
          astarPath={astarPath}
        />
        <MapPanel
          telemetry={telemetry} detections={detections}
          targets={targets} onRemoveTarget={handleRemoveTarget}
          aimResult={aimResult} astarPath={astarPath}
          heatmap={aimResult?.heatmap}
        />
      </main>

      {/* ── BOTTOM BAR ──────────────────────────────────────────── */}
      <footer className="app-footer">
        <DetectionsList
          detections={detections} targets={targets}
          onMarkTarget={handleMarkTarget} onRemoveTarget={handleRemoveTarget}/>
        <TelemetryPanel telemetry={telemetry}/>
        <AltitudeChart altHistory={altHistory}/>
        <CompassPanel mag={telemetry.mag}/>
      </footer>

      {/* ── A* NODE TABLE (below footer, collapsible) ──────────── */}
      <AStarPanel aimResult={aimResult}/>
    </div>
  );
}
