import {catalog,empty,maxBatteryPacks} from './model.mjs';
import {peripherals,wireTypes,wirePalette} from './peripherals.mjs';
import {parseBenchCSV} from './bench.mjs';

const maxSTL=25*1024*1024;
const validNumber=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
const label=(v,fallback)=>typeof v==='string'&&v.trim()?v.trim().slice(0,120):fallback;
function mounts(value){
  const known=['BAT','BAT2','BAT3','BAT4','BAT5','BAT6','ESC','FC','PM','LOAD',...Object.keys(peripherals),'M1','M2','M3','M4','M5','M6'];
  const output={};
  for(const id of known){
    const mount=value?.[id];
    if(!mount||typeof mount!=='object')continue;
    const {x,y,z,normal,turn}=mount;
    if(Number.isInteger(turn)&&turn>=0&&turn<=3)output[id]={turn};
    if([x,y,z].every(v=>validNumber(v,-300,300))){
      output[id]={...output[id],x,y,z};
      if(Array.isArray(normal)&&normal.length===3&&normal.every(v=>validNumber(v,-1,1))&&Math.hypot(...normal)>.1)output[id].normal=normal;
    }
  }
  return output;
}
export function readProject(text){
  const doc=JSON.parse(text);
  if(doc?.format!=='blaze-build'||doc.version!==1||![4,6].includes(doc.build?.n))throw new Error('Unsupported BLAZE project file.');
  const raw=doc.build,state=empty(raw.n);
  const variant=(type,value)=>Number.isInteger(value)&&catalog[type].variants[value]?value:null;
  for(const type of ['battery','controller','esc'])state[type]=variant(type,raw[type]);
  for(const type of ['motor','prop'])state[type]=state[type].map((_,i)=>variant(type,raw[type]?.[i]));
  state.extraBatteries=state.battery!=null&&Array.isArray(raw.extraBatteries)?raw.extraBatteries.slice(0,maxBatteryPacks-1).map(i=>variant('battery',i)).filter(i=>i!=null):[];
  if(raw.wireColors&&typeof raw.wireColors==='object')state.wireColors=Object.fromEntries(Object.entries(wirePalette(raw.wireColors)).filter(([role,color])=>color!==wireTypes[role].color));
  state.payload=validNumber(raw.payload,0,5000)?raw.payload:0;
  state.peripherals=[...new Set(Array.isArray(raw.peripherals)?raw.peripherals.filter(id=>typeof id==='string'&&Object.hasOwn(peripherals,id)):[])];
  state.wires=Array.isArray(raw.wires)?[...new Set(raw.wires.slice(0,300).filter(w=>typeof w==='string'&&w.length<=100&&w.split('|').length===2))]:[];
  state.mounts=mounts(raw.mounts);
  state.bench={};
  for(const [key,curve] of Object.entries(raw.bench??{}).slice(0,60)){
    if(!/^\d+:\d+$/.test(key)||!Array.isArray(curve?.points)||curve.points.length>301)continue;
    try{
      const csv='throttle_pct,thrust_g,current_a\n'+curve.points.map(([d,t,a])=>[d*100,t*1000,a].join(',')).join('\n');
      state.bench[key]=parseBenchCSV(csv,curve.voltage);
    }catch{}
  }
  let frame=null;
  if(doc.frame){
    const f=doc.frame;
    if(!validNumber(f.mass,1,50000)||![1,10,25.4,1000].includes(f.units)||!['Y','Z'].includes(f.axis))throw new Error('Invalid imported-frame settings.');
    if(f.stl!=null&&(typeof f.stl!=='string'||f.stl.length>Math.ceil(maxSTL/3)*4))throw new Error('Invalid embedded STL.');
    frame={name:label(f.name,'frame.stl'),mass:f.mass,units:f.units,axis:f.axis,positions:mounts(f.positions),stl:f.stl??null};
  }
  return {name:label(doc.name,'Imported build'),state,frame};
}

export function writeProject(name,state,frame,embed){
  const metadata=frame?{name:frame.name,mass:frame.mass,units:frame.units,axis:frame.axis,positions:frame.positions}:null;
  if(metadata&&embed&&frame.bytes){
    const bytes=new Uint8Array(frame.bytes);
    let binary='';
    for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
    metadata.stl=btoa(binary);
  }
  return JSON.stringify({format:'blaze-build',version:1,name:label(name,'BLAZE build'),build:state,frame:metadata});
}
