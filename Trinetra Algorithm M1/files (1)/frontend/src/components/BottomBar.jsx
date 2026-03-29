// components/BottomBar.jsx
// Created by Palash Jana (Trinetra algorithm M1) on 2026-03-15
// Bottom bar with 4 sections:
//  1. DetectionsList  — grouped object classes
//  2. TelemetryPanel  — live lat/lon/alt/mag
//  3. AltitudeChart   — Recharts real-time altitude graph
//  4. CompassPanel    — animated compass rose

import React, { useRef, useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import './BottomBar.css';

// ── 1. Detections List ────────────────────────────────────────────

const GROUP_ORDER = ['human', 'military', 'vehicle', 'animal', 'structure', 'unknown'];
const GROUP_LABEL = {
  human:    'HUMANS',
  military: 'MILITARY',
  vehicle:  'VEHICLES',
  animal:   'ANIMALS',
  structure:'STRUCTURES',
  unknown:  'OBJECTS',
};

export function DetectionsList({ detections, targets, onMarkTarget, onRemoveTarget }) {
  // Count by group
  const grouped = {};
  for (const det of detections) {
    if (!grouped[det.group]) grouped[det.group] = [];
    grouped[det.group].push(det);
  }

  const targetList = Object.values(targets);

  return (
    <div className="bb-section det-section">
      <div className="bb-title">
        <span className="bb-title-bar" />
        DETECTED OBJECTS
      </div>

      {/* Group counts */}
      <div className="det-groups">
        {GROUP_ORDER.map(g => {
          const items = grouped[g] || [];
          if (items.length === 0) return null;
          const sample = items[0];
          return (
            <div key={g} className="det-group-chip"
                 style={{ '--gc': sample.color }}>
              <span className="dgc-icon">{sample.icon}</span>
              <span className="dgc-count">{items.length}</span>
              <span className="dgc-label">{GROUP_LABEL[g]}</span>
            </div>
          );
        })}
        {detections.length === 0 && (
          <div className="det-empty">No objects detected</div>
        )}
      </div>

      {/* Individual detections */}
      <div className="det-list">
        {detections.slice(0, 12).map(det => {
          const isTgt = Object.values(targets).some(t => t.id === det.id);
          return (
            <div key={det.id} className={`det-row ${isTgt ? 'det-row-target' : ''}`}
                 style={{ '--dc': det.color }}>
              <span className="dr-dot" />
              <span className="dr-label">{det.icon} {det.label}</span>
              <span className="dr-conf">{(det.confidence*100).toFixed(0)}%</span>
              <span className="dr-gps">
                {det.gps_lat ? `${det.gps_lat.toFixed(4)},${det.gps_lon.toFixed(4)}` : 'NO GPS'}
              </span>
              <button
                className={`dr-btn ${isTgt ? 'dr-btn-remove' : ''}`}
                onClick={() => isTgt ? onRemoveTarget(det.id) : onMarkTarget(det)}
              >
                {isTgt ? '✕' : '⊕ TARGET'}
              </button>
            </div>
          );
        })}
      </div>

      {/* Marked targets */}
      {targetList.length > 0 && (
        <>
          <div className="bb-divider">MARKED TARGETS ({targetList.length})</div>
          <div className="tgt-list">
            {targetList.map(tgt => (
              <div key={tgt.id} className="tgt-row">
                <span className="tgt-dot">⊕</span>
                <span className="tgt-label">{tgt.label}</span>
                <span className="tgt-gps">
                  {tgt.gps_lat ? `${tgt.gps_lat.toFixed(4)},${tgt.gps_lon.toFixed(4)}` : '—'}
                </span>
                <button className="dr-btn dr-btn-remove"
                        onClick={() => onRemoveTarget(tgt.id)}>✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


// ── 2. Telemetry Panel ────────────────────────────────────────────

export function TelemetryPanel({ telemetry }) {
  const fmt = (v, d = 6) => v != null ? parseFloat(v).toFixed(d) : '---';

  return (
    <div className="bb-section telem-section">
      <div className="bb-title">
        <span className="bb-title-bar" style={{ background: 'var(--amber)' }} />
        TELEMETRY
      </div>

      <div className="telem-grid">
        <div className="telem-card">
          <div className="tc-label">LATITUDE</div>
          <div className="tc-value tc-lat">{fmt(telemetry.lat)}</div>
          <div className="tc-unit">° N/S</div>
        </div>
        <div className="telem-card">
          <div className="tc-label">LONGITUDE</div>
          <div className="tc-value tc-lon">{fmt(telemetry.lon)}</div>
          <div className="tc-unit">° E/W</div>
        </div>
        <div className="telem-card">
          <div className="tc-label">ALTITUDE</div>
          <div className="tc-value tc-alt">{fmt(telemetry.alt, 1)}</div>
          <div className="tc-unit">METRES ASL</div>
        </div>
        <div className="telem-card">
          <div className="tc-label">MAGNETOMETER</div>
          <div className="tc-value tc-mag">{fmt(telemetry.mag, 1)}</div>
          <div className="tc-unit">DEGREES</div>
        </div>
      </div>

      {/* Update indicator */}
      <div className="telem-ts">
        {telemetry.timestamp
          ? `LAST UPDATE: ${telemetry.timestamp.slice(11, 23)} UTC`
          : 'AWAITING SIGNAL'}
      </div>
    </div>
  );
}


// ── 3. Altitude Chart ─────────────────────────────────────────────

const CustomTooltip = ({ active, payload }) => {
  if (active && payload?.length) {
    return (
      <div style={{
        background: 'var(--panel)', border: '1px solid var(--border-b)',
        padding: '4px 8px', fontSize: 9, fontFamily: 'var(--font-mono)',
        color: 'var(--cyan)',
      }}>
        {payload[0].value?.toFixed(1)}m
      </div>
    );
  }
  return null;
};

export function AltitudeChart({ altHistory }) {
  const data = altHistory.slice(-60).map((h, i) => ({
    i,
    alt: parseFloat(h.alt || 0),
  }));

  const current = data[data.length - 1]?.alt ?? 0;
  const min = data.length ? Math.min(...data.map(d => d.alt)) : 0;
  const max = data.length ? Math.max(...data.map(d => d.alt)) : 100;

  return (
    <div className="bb-section chart-section">
      <div className="bb-title">
        <span className="bb-title-bar" style={{ background: 'var(--green)' }} />
        ALTITUDE HISTORY
        <span className="bb-badge">{current.toFixed(1)}m</span>
      </div>

      <div className="chart-stats">
        <div className="cs-item"><span>MAX</span><b>{max.toFixed(0)}m</b></div>
        <div className="cs-item"><span>MIN</span><b>{min.toFixed(0)}m</b></div>
        <div className="cs-item"><span>NOW</span>
          <b style={{ color: 'var(--green)' }}>{current.toFixed(1)}m</b>
        </div>
      </div>

      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#00ff9d" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#00ff9d" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="i" hide />
            <YAxis domain={[Math.max(0, min - 10), max + 10]}
                   tick={{ fontSize: 8, fill: 'var(--text-dim)' }} />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="alt"
              stroke="#00ff9d"
              strokeWidth={1.5}
              fill="url(#altGrad)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


// ── 4. Compass Panel ──────────────────────────────────────────────

const COMPASS_DIRS = ['N','NE','E','SE','S','SW','W','NW'];

export function CompassPanel({ mag }) {
  const heading = parseFloat(mag) || 0;

  // Compass direction label
  const idx  = Math.round(heading / 45) % 8;
  const dir  = COMPASS_DIRS[idx];

  return (
    <div className="bb-section compass-section">
      <div className="bb-title">
        <span className="bb-title-bar" style={{ background: 'var(--purple)' }} />
        COMPASS
      </div>

      <div className="compass-wrap">
        {/* Rose */}
        <div className="compass-rose">
          {/* Cardinal labels */}
          {['N','E','S','W'].map((d, i) => (
            <span key={d} className={`compass-card compass-card-${d}`}
                  style={{ color: d === 'N' ? 'var(--red)' : 'var(--text-dim)' }}>
              {d}
            </span>
          ))}

          {/* Tick marks */}
          {Array.from({ length: 36 }).map((_, i) => (
            <div key={i} className="compass-tick"
                 style={{ transform: `rotate(${i * 10}deg)` }} />
          ))}

          {/* Needle */}
          <div
            className="compass-needle"
            style={{ transform: `rotate(${heading}deg)` }}
          >
            <div className="needle-north" />
            <div className="needle-south" />
          </div>

          {/* Centre dot */}
          <div className="compass-centre" />
        </div>

        {/* Heading display */}
        <div className="compass-readout">
          <div className="cr-heading">{heading.toFixed(0).padStart(3, '0')}°</div>
          <div className="cr-dir">{dir}</div>
        </div>
      </div>
    </div>
  );
}
