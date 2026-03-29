// MapPanel.jsx v3.0 — Leaflet map with A* path, heatmap, aim marker
// Created by Palash Jana (Trinetra algorithm M1) on 2026-03-15
import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MapPanel.css';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({iconUrl:'',shadowUrl:''});

const GC = { human:'#ff4444',vehicle:'#ffaa00',military:'#ff0000',
             animal:'#44ff88',structure:'#88aaff',unknown:'#ffffff' };

const mkIcon = (color,size=22) => L.divIcon({className:'',
  html:`<div style="width:${size}px;height:${size}px;background:${color}22;border:1.5px solid ${color};border-radius:50%;display:flex;align-items:center;justify-content:center;color:${color};font-size:${size*.5}px;box-shadow:0 0 10px ${color}88">●</div>`,
  iconSize:[size,size],iconAnchor:[size/2,size/2],popupAnchor:[0,-size/2]});

const aimIcon = () => L.divIcon({className:'',
  html:`<div style="width:30px;height:30px;background:rgba(255,220,50,0.15);border:2px solid #ffdc32;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#ffdc32;font-size:14px;box-shadow:0 0 16px rgba(255,220,50,0.6)">⊕</div>`,
  iconSize:[30,30],iconAnchor:[15,15],popupAnchor:[0,-15]});

const tgtIcon = () => L.divIcon({className:'',
  html:`<div style="width:28px;height:28px;background:rgba(255,59,59,0.2);border:2px solid #ff3b3b;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#ff3b3b;font-size:14px;box-shadow:0 0 16px rgba(255,59,59,0.6);animation:pulse-ring 1.5s infinite">⊕</div>`,
  iconSize:[28,28],iconAnchor:[14,14],popupAnchor:[0,-14]});

const droneIcon = () => L.divIcon({className:'',
  html:`<div style="width:36px;height:36px;background:rgba(0,210,255,0.15);border:2px solid #00d2ff;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#00d2ff;font-size:18px;box-shadow:0 0 0 6px rgba(0,210,255,0.08),0 0 20px rgba(0,210,255,0.5)">✈</div>`,
  iconSize:[36,36],iconAnchor:[18,18],popupAnchor:[0,-18]});

export default function MapPanel({ telemetry,detections,targets,onRemoveTarget,
                                    aimResult,astarPath,heatmap }) {
  const mapRef    = useRef(null);
  const mapInst   = useRef(null);
  const droneM    = useRef(null);
  const aimM      = useRef(null);
  const trailRef  = useRef(null);
  const trailPts  = useRef([]);
  const pathRef   = useRef(null);
  const detMs     = useRef({});
  const tgtMs     = useRef({});
  const heatCircs = useRef([]);
  const [follow,    setFollow]    = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [showDets,  setShowDets]  = useState(true);
  const [wpts, setWpts] = useState(0);

  // Init map
  useEffect(()=>{
    if(mapInst.current) return;
    const m=L.map(mapRef.current,{zoomControl:true,attributionControl:false});
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:20}).addTo(m);
    mapInst.current=m;
    m.setView([20,0],3);
  },[]);

  // Drone + trail
  useEffect(()=>{
    const m=mapInst.current; if(!m||!telemetry.lat||!telemetry.lon) return;
    const ll=[telemetry.lat,telemetry.lon];
    if(!droneM.current){ droneM.current=L.marker(ll,{icon:droneIcon(),zIndexOffset:1000}).addTo(m); m.setView(ll,17); }
    else droneM.current.setLatLng(ll);
    droneM.current.bindPopup(
      `<b style="color:#00d2ff">DRONE</b><br>LAT:${telemetry.lat?.toFixed(6)}<br>LON:${telemetry.lon?.toFixed(6)}<br>ALT:${telemetry.alt?.toFixed(1)}m<br>MAG:${telemetry.mag?.toFixed(0)}°`);
    const last=trailPts.current[trailPts.current.length-1];
    if(!last||last[0]!==ll[0]||last[1]!==ll[1]){
      trailPts.current.push(ll); setWpts(trailPts.current.length);
      if(showTrail){ if(trailRef.current) m.removeLayer(trailRef.current);
        trailRef.current=L.polyline(trailPts.current,{color:'#00d2ff',weight:1.5,opacity:0.45,dashArray:'4 8'}).addTo(m); }
    }
    if(follow) m.panTo(ll);
  },[telemetry,follow,showTrail]);

  // Detection markers
  useEffect(()=>{
    const m=mapInst.current; if(!m) return;
    const ids=new Set(detections.map(d=>d.id));
    for(const[id,mk] of Object.entries(detMs.current)) if(!ids.has(id)){ m.removeLayer(mk); delete detMs.current[id]; }
    if(!showDets) return;
    for(const det of detections){
      if(!det.gps_lat||!det.gps_lon) continue;
      const ll=[det.gps_lat,det.gps_lon];
      const color=GC[det.group]||'#fff';
      if(!detMs.current[det.id]){
        const mk=L.marker(ll,{icon:mkIcon(color)}).addTo(m);
        mk.bindPopup(`<b style="color:${color}">${det.icon} ${det.label}</b><br>Conf:${(det.confidence*100).toFixed(0)}%<br>LAT:${det.gps_lat.toFixed(6)}<br>LON:${det.gps_lon.toFixed(6)}`);
        detMs.current[det.id]=mk;
      } else detMs.current[det.id].setLatLng(ll);
    }
  },[detections,showDets]);

  // Target markers
  useEffect(()=>{
    const m=mapInst.current; if(!m) return;
    for(const[id,mk] of Object.entries(tgtMs.current)) if(!targets[id]){ m.removeLayer(mk); delete tgtMs.current[id]; }
    for(const[id,tgt] of Object.entries(targets)){
      if(!tgt.gps_lat||!tgt.gps_lon||tgtMs.current[id]) continue;
      const mk=L.marker([tgt.gps_lat,tgt.gps_lon],{icon:tgtIcon(),zIndexOffset:500}).addTo(m);
      mk.bindPopup(`<div style="min-width:140px"><b style="color:#ff3b3b">⊕ TARGET</b><br>${tgt.label}<br>${tgt.gps_lat?.toFixed(6)}<br>${tgt.gps_lon?.toFixed(6)}<br><a href="#" onclick="window.__rmTgt('${id}');return false" style="color:#ff3b3b;font-size:10px">✕ Remove</a></div>`).openPopup();
      tgtMs.current[id]=mk;
      window.__rmTgt=(tid)=>{ onRemoveTarget(tid); m.closePopup(); };
    }
  },[targets,onRemoveTarget]);

  // A* path + aim marker + heatmap
  useEffect(()=>{
    const m=mapInst.current; if(!m) return;
    // Aim marker
    if(aimResult && !aimResult.error && aimResult.obj_lat){
      const ll=[aimResult.obj_lat,aimResult.obj_lon];
      if(!aimM.current){ aimM.current=L.marker(ll,{icon:aimIcon(),zIndexOffset:800}).addTo(m); }
      else aimM.current.setLatLng(ll);
      aimM.current.bindPopup(
        `<b style="color:#ffdc32">⊕ AIM POINT</b><br>LAT:${aimResult.obj_lat?.toFixed(6)}<br>LON:${aimResult.obj_lon?.toFixed(6)}<br>Range:${aimResult.slant_range_m?.toFixed(1)}m<br>Bearing:${aimResult.bearing_deg?.toFixed(0)}°`);
    }
    // Path
    if(pathRef.current){ m.removeLayer(pathRef.current); pathRef.current=null; }
    if(astarPath?.length>1){
      const pts=astarPath.map(w=>[w.lat,w.lon]);
      pathRef.current=L.polyline(pts,{color:'#ffdc32',weight:2.5,opacity:0.8,dashArray:'6 4'}).addTo(m);
      // Waypoint markers
      astarPath.forEach((wp,i)=>{
        if(wp.type==='path' && i%3!==0) return;
        const color=wp.type==='start'?'#00ff9d':wp.type==='goal'?'#ff3b3b':'#ffdc32';
        L.circleMarker([wp.lat,wp.lon],{radius:4,color,fillColor:color,fillOpacity:0.8,weight:1.5})
         .bindPopup(`<b style="color:${color}">${wp.type.toUpperCase()}</b><br>g=${wp.g?.toFixed(1)} h=${wp.h?.toFixed(1)} f=${wp.f?.toFixed(1)}<br>${wp.lat?.toFixed(5)},${wp.lon?.toFixed(5)}`)
         .addTo(m);
      });
    }
    // Heatmap circles
    heatCircs.current.forEach(c=>m.removeLayer(c)); heatCircs.current=[];
    if(heatmap?.length){
      for(const cell of heatmap){
        const c=L.circle([cell.lat,cell.lon],{radius:8,
          color:`rgba(255,${Math.round(255*(1-cell.heat))},0,0.6)`,
          fillColor:`rgba(255,${Math.round(255*(1-cell.heat))},0,${cell.heat*0.35})`,
          weight:0,fillOpacity:cell.heat*0.4}).addTo(m);
        heatCircs.current.push(c);
      }
    }
  },[aimResult,astarPath,heatmap]);

  const fitAll=useCallback(()=>{
    const m=mapInst.current; if(!m) return;
    const pts=[...trailPts.current];
    Object.values(tgtMs.current).forEach(mk=>pts.push(mk.getLatLng()));
    if(aimM.current) pts.push(aimM.current.getLatLng());
    if(pts.length>0) m.fitBounds(L.latLngBounds(pts),{padding:[40,40]});
  },[]);

  const clearTrail=useCallback(()=>{
    const m=mapInst.current; if(!m) return;
    trailPts.current=[];
    if(trailRef.current){ m.removeLayer(trailRef.current); trailRef.current=null; }
    setWpts(0);
  },[]);

  return (
    <div className="map-panel">
      <div className="mp-header">
        <div className="mp-title"><span className="mp-title-bar"/>2D TACTICAL MAP</div>
        <div className="vp-badges">
          <span className="badge badge-fps">{wpts} WAYPTS</span>
          <span className="badge badge-det">{Object.keys(targets).length} TARGETS</span>
          {aimResult && !aimResult.error &&
            <span className="badge badge-aim">AIM {aimResult.ground_dist_m?.toFixed(0)}m</span>}
          {astarPath?.length>0 &&
            <span className="badge badge-live">{astarPath.length} PATH</span>}
        </div>
      </div>
      <div ref={mapRef} className="mp-map"/>
      <div className="mp-controls">
        <button className={`mc-btn ${follow?'mc-active':''}`} onClick={()=>setFollow(f=>!f)}>⊙ FOLLOW</button>
        <button className={`mc-btn ${showTrail?'mc-active':''}`} onClick={()=>setShowTrail(s=>!s)}>∿ TRAIL</button>
        <button className={`mc-btn ${showDets?'mc-active':''}`} onClick={()=>setShowDets(s=>!s)}>◈ OBJECTS</button>
        <button className="mc-btn" onClick={fitAll}>⊞ FIT</button>
        <button className="mc-btn mc-danger" onClick={clearTrail}>✕ TRAIL</button>
      </div>
    </div>
  );
}
