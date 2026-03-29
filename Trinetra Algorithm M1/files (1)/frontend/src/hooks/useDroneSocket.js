// hooks/useDroneSocket.js v3.0
// Created by Palash Jana (Trinetra algorithm M1) on 2026-03-15
import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL     = 'ws://localhost:8000/ws';
const WS_CMD_URL = 'ws://localhost:8000/ws/cmd';

export function useDroneSocket() {
  const [frame,      setFrame]      = useState(null);
  const [detections, setDetections] = useState([]);
  const [telemetry,  setTelemetry]  = useState({lat:null,lon:null,alt:null,mag:null});
  const [targets,    setTargets]    = useState({});
  const [altHistory, setAltHistory] = useState([]);
  const [fps,        setFps]        = useState(0);
  const [connected,  setConnected]  = useState(false);
  const [aimResult,  setAimResult]  = useState(null);
  const [astarPath,  setAstarPath]  = useState([]);

  const wsRef  = useRef(null);
  const cmdRef = useRef(null);
  const r1=useRef(null), r2=useRef(null);

  const connect = useCallback(()=>{
    if(wsRef.current?.readyState===WebSocket.OPEN) return;
    const ws=new WebSocket(WS_URL);
    wsRef.current=ws;
    ws.onopen=()=>{ setConnected(true); if(r1.current) clearTimeout(r1.current); };
    ws.onmessage=(ev)=>{
      try{
        const d=JSON.parse(ev.data);
        if(d.type==='frame'){
          setFrame(d.frame); setDetections(d.detections||[]);
          setTelemetry(d.telemetry||{}); setTargets(d.targets||{});
          setAltHistory(d.alt_history||[]); setFps(d.fps||0);
        }
      }catch(_){}
    };
    ws.onclose=()=>{ setConnected(false); r1.current=setTimeout(connect,2000); };
    ws.onerror=()=>ws.close();
  },[]);

  const connectCmd = useCallback(()=>{
    if(cmdRef.current?.readyState===WebSocket.OPEN) return;
    const ws=new WebSocket(WS_CMD_URL);
    cmdRef.current=ws;
    ws.onmessage=(ev)=>{
      try{
        const d=JSON.parse(ev.data);
        if(d.targets) setTargets(d.targets);
        if(d.aim_result && !d.aim_result.error){
          const ar=d.aim_result;
          setAimResult(ar);
          if(ar.path?.length) setAstarPath(ar.path);
        }
      }catch(_){}
    };
    ws.onclose=()=>{ r2.current=setTimeout(connectCmd,2000); };
    ws.onerror=()=>ws.close();
  },[]);

  useEffect(()=>{
    connect(); connectCmd();
    return ()=>{
      wsRef.current?.close(); cmdRef.current?.close();
      if(r1.current) clearTimeout(r1.current);
      if(r2.current) clearTimeout(r2.current);
    };
  },[connect,connectCmd]);

  const sendCommand = useCallback((cmd)=>{
    if(cmdRef.current?.readyState===WebSocket.OPEN)
      cmdRef.current.send(JSON.stringify(cmd));
  },[]);

  return { frame,detections,telemetry,targets,altHistory,fps,
           connected,aimResult,astarPath,sendCommand };
}
