import {parseBenchCSV} from './bench.mjs';
import {readProject,writeProject} from './project.mjs';
import {peripherals,installedPeripherals,busConflict,wireTypes,wireRole,wirePalette} from './peripherals.mjs';
import {catalog,singleton,empty,part,circuit,edge,analyze,upgradeWires,batteryPacks,maxBatteryPacks,firstThreeS} from './model.mjs';
import {createScene} from './scene.mjs';
import {STLLoader} from './STLLoader.mjs';
import {balance,mmPerUnit,placementOptions} from './layout.mjs';
import {gravity,hoverEnvelope,rotorMoments} from './flight.mjs';

const $=id=>document.getElementById(id);
const display=(n,d,suffix)=>Number.isFinite(n)?n.toFixed(d)+suffix:'—';
const key='rotorbench-build-v1';
let state=empty();
try{
  const saved=JSON.parse(localStorage.getItem(key));
  if(saved&&[4,6].includes(saved.n)&&saved.motor.length===saved.n&&saved.prop.length===saved.n&&Array.isArray(saved.wires))state={...saved,wires:upgradeWires(saved.wires)};
}catch{}
const viewport=createScene($('canvasHost'));
let custom=null,pendingFrame=null,layoutBalance=null,envelope=null,trim=null,placing=false,importSequence=0;
let pitch=0,roll=0,pitchRate=0,rollRate=0,busVoltage=0,flightOutcome='';
let model,tab='build',picked=null,drag=null,message='',armed=false,hold=false,alt=0,speed=0,soc=1,throttle=0,view='orbit';

function stop(){
  armed=false;hold=false;alt=0;speed=0;soc=1;throttle=0;flightOutcome='';
  pitch=roll=pitchRate=rollRate=0;
  busVoltage=model?.battery?.v??0;
  $('throttle').value=0;
  viewport.pose(0,0);
}
function update(save=true){
  const {present}=circuit(state);
  state.wires=state.wires.filter(w=>w.split('|').every(pin=>present.has(pin)));
  if(picked&&!present.has(picked))picked=null;
  if(save){try{localStorage.setItem(key,JSON.stringify(state));}catch{}}
  model=analyze(state,custom?.mass);
  stop();
  layoutBalance=viewport.build(state,custom,mountPositions())??fallbackLayout();
  envelope=allMounted()&&layoutBalance.rotorAligned!==false?hoverEnvelope(layoutBalance.rotors,layoutBalance,model.peak?.rotors):null;
  trim=null;
  if(canHold()){
    const forces=envelope.shares.map(share=>share*model.mass/1000);
    let voltage=model.battery.v;
    for(let i=0;i<10;i++){
      const duties=model.commandsForThrust(forces,voltage);
      trim={...model.sample(duties),duty:duties.reduce((a,b)=>a+b,0)/duties.length};
      voltage=trim.v;
    }
  }
  render();
}
function selectTab(next){
  tab=next;picked=null;drag=null;message='';
  setPlacement(false);
  if(next!=='flight')stop();
  render();
}
function renderCatalog(){
  $('catalog').innerHTML=Object.entries(catalog).map(([type,spec])=>{
    const multi=!singleton.includes(type);
    const n=multi?state[type].filter(v=>v!=null).length:Number(state[type]!=null);
    const next=multi?state[type].indexOf(null):null;
    const slots=multi?state[type].map((_,i)=>i):[null];
    const controls=slots.filter(i=>part(state,type,i)).map(i=>{
      const selected=i==null?state[type]:state[type][i];
      const tag=i==null?'':('M'+(i+1)+' ');
      return '<div class="part-tools"><select aria-label="'+tag+spec.name+' model" data-model="'+type+'" data-slot="'+(i??-1)+'">'+spec.variants.map((v,j)=>'<option value="'+j+'" '+(selected===j?'selected':'')+'>'+tag+v.name+'</option>').join('')+'</select><button aria-label="Remove '+tag+spec.name+'" data-remove="'+type+'" data-slot="'+(i??-1)+'" '+(type==='battery'&&batteryPacks(state).length>1?'disabled title="Remove extra packs first"':'')+'>×</button></div>';
    }).join('');
    return '<div class="part"><span class="part-icon" aria-hidden="true">'+spec.icon+'</span><div><div class="part-name">'+spec.name+'</div><span class="part-spec">'+n+' / '+(multi?state.n:1)+' installed</span></div><button data-add="'+type+'" aria-label="Add '+spec.name+'" '+((multi?next<0:n===1)?'disabled':'')+'>+</button>'+controls+'</div>';
  }).join('');
  const installed=installedPeripherals(state);
  $('peripheralCount').textContent=installed.length?'('+installed.length+')':'';
  $('peripheralCatalog').innerHTML=Object.entries(peripherals).map(([id,item])=>{
    const on=installed.includes(id);
    return '<div class="peripheral-row"><div><strong>'+item.name+'</strong><small>'+item.protocol+' · '+item.port+'</small></div><button data-peripheral="'+id+'" aria-label="'+(on?'Remove ':'Add ')+item.name+'" aria-pressed="'+on+'">'+(on?'×':'+')+'</button></div>';
  }).join('');
}
$('peripheralCatalog').onclick=e=>{
  const id=e.target.closest('button')?.dataset.peripheral;
  if(!id)return;
  const ids=installedPeripherals(state);
  state.peripherals=ids.includes(id)?ids.filter(item=>item!==id):[...ids,id];
  update();
  $('peripheralCatalog').querySelector('[data-peripheral="'+id+'"]')?.focus({preventScroll:true});
};
function renderSeries(){
  const packs=batteryPacks(state);
  $('batterySeries').hidden=!packs.length;
  const battery=model.battery;
  $('seriesStatus').textContent=battery?packs.length+' '+(packs.length===1?'pack':'packs in series')+' · '+battery.cells+'S · '+battery.v.toFixed(1)+' V · '+Math.round(battery.ah*1000)+' mAh':'';
  $('seriesPacks').innerHTML=packs.slice(1).map(({spec},i)=>'<label>Pack '+(i+2)+'<select data-pack="'+i+'">'+catalog.battery.variants.map((choice,j)=>'<option value="'+j+'" '+(choice===spec?'selected':'')+'>'+choice.name+'</option>').join('')+'</select></label>').join('');
  $('addPack').disabled=packs.length>=maxBatteryPacks;
  $('removePack').hidden=packs.length<2;
}
function changeSeries(action){
  const before=circuit(state).links;
  action();
  const after=new Set(circuit(state).links.map(link=>link.key));
  const retired=new Set(before.filter(link=>!after.has(link.key)).map(link=>link.key));
  state.wires=state.wires.filter(wire=>!retired.has(wire));
  update();
}
$('addPack').onclick=()=>changeSeries(()=>{(state.extraBatteries??=[]).push(firstThreeS);});
$('removePack').onclick=()=>changeSeries(()=>{
  const id='BAT'+(state.extraBatteries.length+1);
  if(state.mounts)delete state.mounts[id];
  if(custom)delete custom.positions[id];
  state.extraBatteries.pop();
});
$('seriesPacks').onchange=e=>{
  if(e.target.dataset.pack==null)return;
  state.extraBatteries[Number(e.target.dataset.pack)]=Number(e.target.value);
  update();
};
function render(){
  document.querySelectorAll('[data-tab]').forEach(button=>{
    const active=button.dataset.tab===tab;
    button.classList.toggle('active',active);
    button.setAttribute('aria-current',active?'step':'false');
  });
  document.querySelectorAll('.view-tools button').forEach(b=>b.classList.toggle('active',b.id===view+'View'));
  for(const name of ['build','wire','flight'])$(name+'Panel').hidden=name!==tab;
  $('viewTitle').textContent={build:'Assembly viewport',wire:'Wiring bench',flight:'Flight viewport'}[tab];
  $('viewport').hidden=tab==='wire';
  $('viewStatus').hidden=tab==='wire';
  if(viewport.software)$('viewStatus').textContent='COMPATIBILITY VIEW';
  $('frameLabel').textContent=custom?'IMPORTED STL FRAME':(state.n===4?'QUAD':'HEX')+' X FRAME';
  renderCad();
  $('layout').value=state.n;
  $('payload').value=state.payload;
  $('wireCount').textContent=state.wires.length;
  renderCatalog();
  renderSeries();
  $('assemblyTitle').textContent=model.assembly?'Assembly complete':'Start with the essentials';
  const pendingProps=state.prop.some((prop,i)=>prop!=null&&state.motor[i]==null);
  $('assemblyHint').textContent=pendingProps?'Selected propellers appear in 3D when their motors are installed.':model.assembly?'Connect battery power, controller signals and motor phases in Wiring.':'Add a battery, flight controller, ESC and a motor with propeller at each mount.';
  $('ratio').textContent=display(model.ratio,2,' : 1');
  $('ratioNote').textContent=model.peak?(model.peak.limited?'Peak limited by electrical ratings':model.ratio>1?'Estimated static thrust margin':'Insufficient thrust for hover'):(model.assembly?'Check battery and motor voltage':'Complete the propulsion system');
  const h=trim;
  $('metrics').innerHTML=[
    ['Total mass',display(model.mass,0,' g')],
    ['Peak thrust',display(model.peak?.t,2,' kgf')],
    ['Balanced lift limit',display(envelope?.lift,2,' kgf')],
    ['Hover throttle',display(h?.duty*100,1,'%')],
    ['Hover current',display(h?.a,1,' A')],
    ['Loaded voltage',display(h?.v,2,' V')],
    ['Hover power',display(h?.p,0,' W')],
    ['Electrical loss',display(h?.loss,1,' W')],
    ['Thrust per watt',display(h?h.t*1000/h.p:null,1,' g/W')],
    ['Hover endurance',display(h?model.battery.ah*.8/h.a*60:null,1,' min')]
  ].map(([label,value])=>'<div class="metric"><span>'+label+'</span><strong>'+value+'</strong></div>').join('');
  $('checks').innerHTML=[
    ['Components',model.assembly,model.assembly?'Complete':'Incomplete'],
    ['Voltage / ESC channels',model.voltageOK&&model.esc.ch>=state.n,model.battery&&model.esc?(model.voltageOK&&model.esc.ch>=state.n?'Compatible':'Mismatch'):'Pending'],
    ['Circuit',model.wired,model.wired?'Connected':model.matched+' / '+model.required],
    ...(installedPeripherals(state).length?[['Pixhawk ports',model.accessoryOK,busConflict(state)?'TELEM2 conflict':state.controller>0?'Compatible':'Pixhawk required']]:[]),
    ...(layoutBalance.rotorAligned===false?[['Rotor orientation',false,'Align upward']]:[]),
    ...(custom?[['Component mounts',allMounted(),allMounted()?'Placed':'Incomplete']]:[]),
    ['Lift margin',model.ratio>1,model.ratio==null?'Pending':model.ratio>1?'Sufficient':'Low'],
    ['Hover balance',canHold(),!envelope?'Pending':canHold()?'Trimmable':'Cannot hold']
  ].map(([label,ok,status])=>'<div class="check"><span>'+label+'</span><b class="'+(ok?'ok':'')+'">'+status+'</b></div>').join('');
  renderWiring();
  renderFlight();
  renderEngineering();
}
const board=$('wiringBoard'), terminals=$('terminals'), wirePaths=$('wirePaths');
$('paletteFields').onchange=e=>{
  const role=e.target.dataset.role;
  if(!Object.hasOwn(wireTypes,role))return;
  (state.wireColors??={})[role]=e.target.value;
  update();
};
$('examplePalette').onclick=()=>{
  state.wireColors={...state.wireColors,power:'#ff0000',ground:'#000000',tx:'#ffffff',rx:'#00aa44'};
  update();
};
$('resetPalette').onclick=()=>{delete state.wireColors;update();};
function drawWires(){
  if(tab!=='wire')return;
  const frame=board.getBoundingClientRect();
  const points=new Map([...terminals.querySelectorAll('[data-pin]')].map(button=>{
    const rect=button.querySelector('i').getBoundingClientRect();
    return [button.dataset.pin,{x:rect.x+rect.width/2-frame.x,y:rect.y+rect.height/2-frame.y}];
  }));
  const paint=wirePalette(state.wireColors);
  const kinds=new Map(circuit(state).links.map(l=>[l.key,wireRole(l)]));
  wirePaths.replaceChildren();
  function path(a,b,color,preview=false){
    if(!a||!b)return;
    const distance=Math.hypot(a.x-b.x,a.y-b.y), curve=Math.max(14,Math.min(78,distance*.24));
    const d='M '+a.x+' '+a.y+' C '+a.x+' '+(a.y+curve)+' '+b.x+' '+(b.y+curve)+' '+b.x+' '+b.y;
    for(const [width,stroke] of [[5.5,color==='#000000'?'#8b98a4':'#101619'],[2.5,color]]){
      const line=document.createElementNS('http://www.w3.org/2000/svg','path');
      line.setAttribute('d',d);
      line.setAttribute('stroke',stroke);
      line.setAttribute('stroke-width',width);
      line.setAttribute('fill','none');
      if(preview)line.setAttribute('stroke-dasharray','5 3');
      wirePaths.append(line);
    }
  }
  for(const wire of state.wires){
    const [a,b]=wire.split('|');
    path(points.get(a),points.get(b),paint[kinds.get(wire)??'invalid']);
  }
  if(drag?.moved){
    const kind=drag.target?kinds.get(edge(drag.pin,drag.target)):null;
    path(points.get(drag.pin),points.get(drag.target)??{x:drag.x-frame.x,y:drag.y-frame.y},paint[kind??(drag.target?'invalid':'signal')],true);
  }
}
function renderWiring(){
  const {groups,links,pinKinds}=circuit(state);
  const paint=wirePalette(state.wireColors);
  const kinds=new Map(links.map(l=>[l.key,wireRole(l)]));
  const connected=new Set(state.wires.flatMap(w=>w.split('|')));
  $('autoWire').disabled=!links.length;
  board.hidden=!groups.length;
  $('wireLegend').innerHTML=Object.entries(wireTypes).map(([kind,{name}])=>'<span style="--wire:'+paint[kind]+'" data-kind="'+kind+'">'+name+'</span>').join('');
  $('paletteFields').innerHTML=Object.entries(wireTypes).map(([role,{name}])=>'<label>'+name+' <input type="color" data-role="'+role+'" value="'+paint[role]+'"></label>').join('');
  terminals.innerHTML=groups.map(({id,label,pins,type,protocol})=>{
    const modelMark={battery:'LiPo',pixhawk:'PIXHAWK',controller:'FC',esc:'ESC',motor:'BLDC',module:'5 V',accessory:'I/O',port:'FC'}[type];
    const displayPin=p=>type==='pixhawk'&&p.startsWith('OUT')?'MAIN '+p.slice(3):p;
    return '<div class="terminal-group hardware-'+type+'"><div class="board-heading"><div class="board-mark" aria-hidden="true">'+modelMark+'</div><h4>'+label+(protocol?'<small>'+protocol+'</small>':'')+'</h4></div><div class="pin-bank">'+pins.map(p=>{
      const pin=id+'.'+p, name=displayPin(p);
      const fallback=peripherals[id]?.pins.find(([key])=>key===p)?.[2];
      const kind=pinKinds.get(pin)??(fallback==='uart'?(p==='RX'?'tx':'rx'):fallback);
      const color=paint[kind]??'#a3aab3';
      return '<button style="--wire:'+color+'" title="'+(wireTypes[kind]?.name??'Terminal')+'" data-pin="'+pin+'"  class="'+(picked===pin?'selected':connected.has(pin)?'connected':'')+'" aria-label="'+label+' '+name+'" aria-pressed="'+(picked===pin)+'"><i></i>'+name+'</button>';
    }).join('')+'</div></div>';
  }).join('');
  $('connections').innerHTML=state.wires.map((w,i)=>{
    const tip=w.replace('|',' ↔ ');
    return '<button style="--wire:'+paint[kinds.get(w)??'invalid']+'" class="wire-chip" data-wire="'+i+'" aria-label="Remove wire '+tip+'">'+tip+' ×</button>';
  }).join('');
  $('wireMessage').textContent=message||(picked?'Selected '+picked+' · Choose the destination.':!groups.length?'Install components in Assembly to reveal their pins.':busConflict(state)?'Optical flow and ADS-B both use TELEM2. Install one of them.':!model.accessoryOK?'Select a Pixhawk controller to wire these peripherals.':model.wired?'All required connections are present.':'Match wire colors and pin labels. UART transmit connects to receive.');
  drawWires();
}
new ResizeObserver(drawWires).observe(board);
document.fonts?.ready.then(drawWires);
function allMounted(){
  return !pendingFrame&&(!custom||placementOptions(state).every(({id})=>Number.isFinite(custom.positions[id]?.x)));
}
function mountPositions(){
  return custom?.positions??state.mounts??{};
}
function selectComponent(id){
  $('placePart').value=id;
  viewport.setSelection(id,selectComponent);
}
function setPlacement(active){
  placing=active;
  viewport.setPicker(active?(position,normal)=>{
    if(!position){
      $('cadMessage').textContent='Select a visible mounting surface on the frame.';
      return;
    }
    const mounts=custom?custom.positions:(state.mounts??={});
    const id=$('placePart').value;
    mounts[id]={...mounts[id],x:position.x,y:position.y,z:position.z,normal};
    setPlacement(false);
    $('cadMessage').textContent='Mount placed.';
    update(!custom);
  }:null);
  $('pickMount').textContent=active?'Cancel move':'Move on frame';
  $('pickMount').setAttribute('aria-pressed',String(active));
  $('viewNote').classList.toggle('placing',active);
  $('viewNote').textContent=active?'Click the new mounting surface':'Click a part to select · Drag to orbit';
}
function renderCad(){
  $('cadTools').hidden=tab!=='build';
  $('stlFile').disabled=!viewport.available;
  $('cadSettings').hidden=!custom;
  $('removeStl').hidden=!custom&&!pendingFrame;
  $('stlName').textContent=custom?custom.name:pendingFrame?'Awaiting '+pendingFrame.name:'Built-in frame';
  const positions=mountPositions();
  const options=placementOptions(state);
  const selected=$('placePart').value;
  $('placePart').replaceChildren(...options.map(({id,label})=>new Option(label+(custom?(Number.isFinite(positions[id]?.x)?' · placed':' · unplaced'):(Number.isFinite(positions[id]?.x)?' · moved':'')),id)));
  if(options.some(({id})=>id===selected))$('placePart').value=selected;
  $('pickMount').disabled=!options.length||!viewport.available;
  $('rotatePart').disabled=$('pickMount').disabled;
  viewport.setSelection($('placePart').value,tab==='build'?selectComponent:null);
  if(!options.length&&placing)setPlacement(false);
  $('clearMounts').disabled=!Object.keys(positions).length;
  const mounted=custom?options.filter(({id})=>Number.isFinite(positions[id]?.x)).length:options.length;
  const b=layoutBalance;
  const axis=b?' X '+display(b.x*mmPerUnit,1,' mm')+' · Y (height) '+display(b.y*mmPerUnit,1,' mm')+' · Z '+display(b.z*mmPerUnit,1,' mm'):'';
  const offset=Number.isFinite(b?.offset)&&allMounted()?' · '+display(b.offset*mmPerUnit,1,' mm from rotor center'):'';
  $('massBalance').textContent=options.length?'Center of mass ('+(allMounted()?'estimated':'partial')+')'+axis+offset+' · '+mounted+' of '+options.length+' placed':'';
}
function removeFrame(){
  importSequence++;
  setPlacement(false);
  custom?.geometry.dispose();
  custom=null;pendingFrame=null;
  viewport.setFrame(null);
  $('cadMessage').textContent='';
}
$('stlFile').onchange=async e=>{
  const file=e.target.files[0];
  const request=++importSequence;
  e.target.value='';
  if(!file)return;
  if(!/\.stl$/i.test(file.name)){$('cadMessage').textContent='Choose an STL file.';return;}
  const status=$('cadMessage');
  if(file.size>25*1024*1024){status.textContent='Choose an STL under 25 MB.';return;}
  status.textContent='Reading STL…';
  let geometry;
  try{
    const data=await file.arrayBuffer();
    if(request!==importSequence)return;
    if(data.byteLength<20)throw new Error('The STL file is empty or invalid.');
    geometry=new STLLoader().parse(data);
    const vertices=geometry.getAttribute('position');
    if(!vertices||vertices.count<3||!vertices.array.every(Number.isFinite))throw new Error('The STL has no valid triangles.');
    geometry.computeBoundingBox();
    const {min,max}=geometry.boundingBox;
    const extent=Math.max(max.x-min.x,max.y-min.y,max.z-min.z);
    const units=pendingFrame?.units??[1,10,25.4,1000].find(scale=>extent*scale>=1&&extent*scale<=10000);
    if(!units)throw new Error('The STL has unsupported dimensions.');
    const frame=pendingFrame??{mass:state.n===4?128:196,positions:{},units,axis:'Z'};
    viewport.setFrame(geometry,frame.units,frame.axis);
    custom?.geometry.dispose();
    custom={...frame,name:file.name,geometry,bytes:data};
    pendingFrame=null;
    syncFrameInputs();
    selectTab('build');
    status.textContent='STL loaded. Verify its units, up axis and measured frame mass.';
    view='orbit';
    update(false);
  }catch(error){
    if(custom?.geometry!==geometry)geometry?.dispose();
    status.textContent=error.message||'Unable to read the STL file.';
  }
};
$('removeStl').onclick=()=>{removeFrame();view='orbit';update(false);};
function reorient(){
  const units=Number($('stlUnits').value),axis=$('stlAxis').value;
  try{
    viewport.setFrame(custom.geometry,units,axis);
    Object.assign(custom,{units,axis,positions:{}});
    setPlacement(false);
    $('cadMessage').textContent='Frame orientation or scale changed. Pick new mounting points.';
    view='orbit';
    update(false);
  }catch(error){
    $('stlUnits').value=custom.units;$('stlAxis').value=custom.axis;
    $('cadMessage').textContent=error.message;
  }
}
$('stlUnits').onchange=reorient;
$('stlAxis').onchange=reorient;
$('stlMass').onchange=e=>{
  custom.mass=Math.max(1,Math.min(50000,Number(e.target.value)||custom.mass));
  e.target.value=custom.mass;
  update(false);
};
$('clearMounts').onclick=()=>{
  if(custom)custom.positions={};else state.mounts={};
  setPlacement(false);
  $('cadMessage').textContent='Mounting points reset.';
  update(!custom);
};
$('placePart').onchange=e=>selectComponent(e.target.value);
$('pickMount').onclick=()=>{
  setPlacement(!placing);
  $('cadMessage').textContent=placing?'Click on the frame in the viewport.':'';
  if(placing)$('viewport').scrollIntoView({block:'nearest'});
};
function rotateSelected(){
  const id=$('placePart').value;
  if(tab!=='build'||!id||!viewport.available)return false;
  const mounts=custom?custom.positions:(state.mounts??={});
  const turn=((mounts[id]?.turn??0)+1)%4;
  mounts[id]={...mounts[id],turn};
  $('cadMessage').textContent='Mount rotation '+turn*90+'°.';
  update(!custom);
  return true;
}
$('rotatePart').onclick=rotateSelected;
document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&!e.altKey&&!e.shiftKey&&!e.repeat&&e.key.toLowerCase()==='r'&&
    !e.target.matches?.('input, textarea, [contenteditable="true"]')&&rotateSelected())e.preventDefault();
});
function fallbackLayout(){
  const radius=state.n===4?2.52:2.93;
  const rotors=state.motor.map((_,i)=>{
    const a=(i+.5)*2*Math.PI/state.n;
    return {x:Math.sin(a)*radius,y:.65,z:-Math.cos(a)*radius};
  });
  const fixed={BAT:{x:-.17,y:.68,z:.51},ESC:{x:0,y:.55,z:-.48},FC:{x:0,y:.73,z:-.48},PM:{x:.55,y:.54,z:.42},LOAD:{x:0,y:.46,z:0}};
  const entries=placementOptions(state).map(e=>({...e,position:fixed[e.id]??rotors[Number(e.id.slice(1))-1]}));
  return {...balance(entries,state.n===4?128:196,.25),rotors,pitchInertia:.005,rollInertia:.005};
}
function canHold(){
  return Boolean(envelope?.shares&&envelope.lift>model.mass/1000);
}
function canArm(){
  return model.wired&&model.voltageOK&&allMounted()&&layoutBalance.rotorAligned!==false;
}
function renderFlight(){
  $('arm').disabled=!canArm();
  $('arm').textContent=armed?'Disarm':flightOutcome?'Restart simulation':'Arm simulation';
  $('throttle').disabled=!armed||hold;
  $('hold').disabled=!armed||!canHold();
  $('hold').textContent=hold?'Release hold':'Hold 1 m';
  let hint='Resolve the wiring, voltage, and mount checks to arm.';
  if(layoutBalance.rotorAligned===false)hint='This hover model requires all rotor thrust axes to point up.';
  if(canArm()){
    if(model.ratio<=1)hint='Insufficient total lift. Use manual throttle to see why this build stays grounded.';
    else if(!canHold())hint='The motors cannot balance this center of mass with enough lift. Move the load or test in manual mode.';
    else hint=armed?'Throttle controls lift with automatic motor balancing. Hold 1 m also controls altitude.':'Arm to test the drone from the launch pad.';
  }
  $('flightHint').textContent=flightOutcome||hint;
}
const change=(type,slot,value)=>{
  const replacingController=type==='controller'&&state.controller!=null&&value!=null;
  const oldLinks=replacingController?circuit(state).links:[];
  if(slot===-1)state[type]=value;else state[type][slot]=value;
  if(replacingController){
    const current=new Set(circuit(state).links.map(link=>link.key));
    const retired=new Set(oldLinks.filter(link=>!current.has(link.key)).map(link=>link.key));
    state.wires=state.wires.filter(wire=>!retired.has(wire));
  }
  update();
};
$('catalog').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.add){
    const k=b.dataset.add;
    change(k,singleton.includes(k)?-1:state[k].indexOf(null),k==='esc'&&state.n===6?1:0);
  }else if(b.dataset.remove)change(b.dataset.remove,Number(b.dataset.slot),null);
});
$('catalog').addEventListener('change',e=>{
  const s=e.target;
  if(s.dataset.model)change(s.dataset.model,Number(s.dataset.slot),Number(s.value));
});
$('payload').addEventListener('change',e=>{state.payload=Math.max(0,Math.min(5000,Number(e.target.value)||0));update();});
$('layout').addEventListener('change',e=>{
  const n=Number(e.target.value);
  for(const k of ['motor','prop'])state[k]=Array.from({length:n},(_,i)=>state[k][i]??null);
  state.n=n;update();
});
$('reset').onclick=()=>{if(custom)custom.positions={};state=empty(state.n);selectTab('build');update();};
$('demo').onclick=()=>{
  removeFrame();
  state=empty(state.n);
  Object.assign(state,{battery:1,controller:0,esc:state.n===6?1:0,motor:Array(state.n).fill(0),prop:Array(state.n).fill(0)});
  state.wires=circuit(state).links.map(l=>l.key);
  selectTab('build');update();
};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>selectTab(b.dataset.tab));
$('goWire').onclick=()=>selectTab('wire');
$('goFlight').onclick=()=>selectTab('flight');
for(const mode of ['top','bottom','left','right','orbit'])$(mode+'View').onclick=()=>{view=mode;viewport.view(mode);for(const b of document.querySelectorAll('.view-tools button'))b.classList.toggle('active',b.id===view+'View');};
$('autoWire').onclick=()=>{state.wires=circuit(state).links.map(l=>l.key);picked=null;message='Reference harness connected.';update();};
function connectPins(a,b){
  const wire=edge(a,b);
  picked=null;
  if(state.wires.includes(wire)){message='These pins are already connected.';renderWiring();return;}
  const expected=circuit(state).links.some(l=>l.key===wire);
  state.wires.push(wire);
  message=expected?'Connection added.':'Unexpected connection. Remove this lead before arming.';
  update();
}
function selectPin(pin){
  message='';
  if(picked&&picked!==pin){connectPins(picked,pin);return;}
  picked=picked===pin?null:pin;
  renderWiring();
  [...terminals.querySelectorAll('[data-pin]')].find(b=>b.dataset.pin===pin)?.focus({preventScroll:true});
}
function pinAt(e){
  return document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-pin]')?.dataset.pin;
}
terminals.addEventListener('pointerdown',e=>{
  const button=e.target.closest('[data-pin]');
  if(!button||e.button!==0||!e.isPrimary)return;
  drag={pin:button.dataset.pin,id:e.pointerId,x:e.clientX,y:e.clientY};
  terminals.setPointerCapture(e.pointerId);
});
terminals.addEventListener('pointermove',e=>{
  if(drag?.id!==e.pointerId)return;
  if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;
  drag.moved=true;
  drag.x=e.clientX;drag.y=e.clientY;
  const target=pinAt(e);
  drag.target=target===drag.pin?null:target;
  drawWires();
});
terminals.addEventListener('pointerup',e=>{
  if(drag?.id!==e.pointerId)return;
  const {pin,moved}=drag;
  const target=pinAt(e);
  drag=null;
  if(target&&target!==pin){connectPins(pin,target);return;}
  if(!moved&&target===pin){selectPin(pin);return;}
  drawWires();
});
for(const event of ['lostpointercapture','pointercancel'])terminals.addEventListener(event,e=>{
  if(drag?.id!==e.pointerId)return;
  drag=null;drawWires();
});
terminals.addEventListener('click',e=>{
  const pin=e.target.closest('[data-pin]')?.dataset.pin;
  if(pin&&e.detail===0)selectPin(pin);
});
$('connections').onclick=e=>{
  const {wire}=e.target.dataset;
  if(wire==null)return;
  state.wires.splice(Number(wire),1);message='Connection removed.';update();
};
$('arm').onclick=()=>{if(armed)stop();else {stop();armed=true;}$('throttle').value=0;renderFlight();};
$('hold').onclick=()=>{hold=!hold;renderFlight();};
$('throttle').oninput=e=>{throttle=Number(e.target.value)/100;};

function syncFrameInputs(){
  if(!custom)return;
  $('stlUnits').value=String(custom.units);
  $('stlAxis').value=custom.axis;
  $('stlMass').value=custom.mass;
}

const compareKey='blaze-compare-v1';
let comparisons={};
try{comparisons=JSON.parse(localStorage.getItem(compareKey))??{};}catch{}
const comparisonFields=[
  ['mass','All-up mass',0,' g'],['ratio','Thrust-to-weight',2,' ×'],
  ['lift','Balanced lift',2,' kgf'],['current','Hover current',1,' A'],
  ['voltage','Loaded hover voltage',2,' V'],['power','Hover power',0,' W'],
  ['endurance','Estimated hover time',1,' min'],['offset','Center-of-mass offset',1,' mm']
];
function capture(slot){
  const name=$('projectName').value.trim()||'Build '+slot;
  comparisons[slot]={name,mass:model.mass,ratio:model.ratio,lift:envelope?.lift,current:trim?.a,voltage:trim?.v,power:trim?.p,
    endurance:trim?model.battery.ah*.8/trim.a*60:null,offset:Number.isFinite(layoutBalance.offset)?layoutBalance.offset*mmPerUnit:null};
  storeComparison();
}
function storeComparison(){
  try{localStorage.setItem(compareKey,JSON.stringify(comparisons));}catch{}
  renderComparison();
}
$('captureA').onclick=()=>capture('A');
$('captureB').onclick=()=>capture('B');
$('clearCompare').onclick=()=>{comparisons={};storeComparison();};
function renderComparison(){
  const {A,B}=comparisons;
  $('compareNameA').textContent=A?.name??'Build A';
  $('compareNameB').textContent=B?.name??'Build B';
  $('compareValues').replaceChildren(...comparisonFields.map(([key,label,digits,unit])=>{
    const row=document.createElement('tr');
    const both=Number.isFinite(A?.[key])&&Number.isFinite(B?.[key]);
    const delta=both?B[key]-A[key]:null;
    for(const [index,value] of [label,display(A?.[key],digits,unit),display(B?.[key],digits,unit),(delta>0?'+':'')+display(delta,digits,unit)].entries()){
      const cell=document.createElement(index?'td':'th');cell.textContent=value;row.append(cell);
    }
    return row;
  }));
}

for(const [id,type] of [['benchMotor','motor'],['benchProp','prop']]){
  $(id).replaceChildren(...catalog[type].variants.map((spec,i)=>new Option(spec.name,i)));
  $(id).onchange=()=>{benchMessage='';renderBench();};
}
const benchKey=()=>$('benchMotor').value+':'+$('benchProp').value;
let benchMessage='';
function renderBench(){
  const curve=state.bench?.[benchKey()];
  $('removeBench').disabled=!curve;
  $('benchStatus').textContent=benchMessage||(curve?curve.points.length+' points at '+curve.voltage+' V. '+model.measuredRotors.filter(Boolean).length+' installed rotors use measured curves.':'No measured curve for this pair. Estimates remain active.');
}
$('benchFile').onchange=async e=>{
  const [file]=e.target.files;
  e.target.value='';
  if(!file)return;
  const selected=benchKey(),target=state,voltage=Number($('benchVoltage').value);
  try{
    if(file.size>128*1024)throw new Error('Choose a CSV under 128 KB.');
    const curve=parseBenchCSV(await file.text(),voltage);
    if(state!==target)return;
    (state.bench??={})[selected]=curve;
    benchMessage='Measured curve imported.';
    update();
  }catch(error){benchMessage=error.message;renderBench();}
};
$('removeBench').onclick=()=>{
  delete state.bench[benchKey()];
  benchMessage='Curve removed. This pair uses the built-in estimates.';
  update();
};

$('exportProject').onclick=()=>{
  const name=$('projectName').value.trim()||'BLAZE build';
  const blob=new Blob([writeProject(name,state,custom??pendingFrame,$('embedSTL').checked)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.download=(name.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'blaze-build')+'.blaze.json';
  a.href=url;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  $('projectStatus').textContent='Build exported.';
};
$('importProject').onchange=async e=>{
  const [file]=e.target.files;
  e.target.value='';
  if(!file)return;
  const status=$('projectStatus'),request=++importSequence;
  let geometry;
  try{
    if(file.size>36*1024*1024)throw new Error('Choose a build file under 36 MB.');
    const project=readProject(await file.text());
    if(request!==importSequence)return;
    let bytes;
    if(project.frame?.stl){
      if(!viewport.available)throw new Error('The 3D viewport is required to restore an embedded STL.');
      bytes=Uint8Array.from(atob(project.frame.stl),c=>c.charCodeAt(0)).buffer;
      geometry=new STLLoader().parse(bytes);
      const vertices=geometry.getAttribute('position');
      if(!vertices||vertices.count<3||!vertices.array.every(Number.isFinite))throw new Error('The embedded STL is invalid.');
      viewport.setFrame(geometry,project.frame.units,project.frame.axis);
    }else viewport.setFrame(null);
    custom?.geometry.dispose();
    state=project.state;
    state.wires=upgradeWires(state.wires);
    const frame=project.frame?{...project.frame,stl:undefined}:null;
    custom=geometry?{...frame,bytes,geometry}:null;
    pendingFrame=frame&&!custom?frame:null;
    syncFrameInputs();
    $('projectName').value=project.name;
    view='orbit';benchMessage='';
    tab='build';setPlacement(false);
    update();
    status.textContent=pendingFrame?'Build restored. Use Import STL to attach '+pendingFrame.name+' and restore its mounting positions.':'Build restored.';
  }catch(error){
    if(custom?.geometry!==geometry)geometry?.dispose();
    status.textContent=error.message||'Unable to import build.';
  }
};
function fillList(id,items){
  $(id).replaceChildren(...items.map(message=>{
    const li=document.createElement('li');li.textContent=message;return li;
  }));
}
function renderEngineering(){
  $('embedSTL').disabled=!custom?.bytes;
  renderComparison();renderBench();
  const notes=[];
  if(pendingFrame)notes.push('Attach the original STL before testing this build.');
  if(!model.assembly)notes.push('Install the battery, controller, ESC, motors and propellers first.');
  if(model.assembly&&!model.wired)notes.push('Complete the required wiring and remove unexpected leads.');
  if(model.measuredRotors.some(Boolean))notes.push(model.measuredRotors.filter(Boolean).length+' of '+state.n+' rotors use measured thrust and current.');
  if(model.assembly&&!model.voltageOK){
    const cells=model.battery.cells;
    const incompatible=state.motor.map((_,i)=>part(state,'motor',i)?.max<cells?'M'+(i+1):null).filter(Boolean);
    if(incompatible.length)notes.push(incompatible.join(', ')+' exceed their supported battery cell count.');
    if(model.esc.max<cells)notes.push('Battery cell count exceeds the ESC rating.');
  }
  if(model.battery?.mismatch)notes.push('Series packs have different capacities. Usable capacity and current are limited by the weakest pack.');
  if(model.peak?.limited)notes.push(...model.peak.requested.reasons);
  if(model.peak){
    const draw=model.peak.requested;
    notes.push('Full-throttle demand: '+display(draw.a,1,' A')+' total, '+display(draw.v,2,' V')+' loaded. Highest draw: M'+draw.limitMotor+' at '+display(draw.amps,1,' A')+'.');
  }
  if(model.ratio!=null&&model.ratio<=1)notes.push('Total thrust is below the build weight.');
  if(layoutBalance.rotorAligned===false)notes.push('Rotate or remount the sideways rotor so its thrust axis points up.');
  if(model.ratio>1&&envelope&&!canHold())notes.push('Total thrust is available, but a level hover exceeds the balanced lift limit. Move the heaviest component toward the rotor center.');
  if(Number.isFinite(layoutBalance.offset))notes.push('The center of mass is '+display(layoutBalance.offset*mmPerUnit,1,' mm')+' from the rotor center.');
  fillList('diagnosticList',notes.length?notes:['No electrical or hover checks are available yet.']);
  const names=new Map(placementOptions(state).map(({id,label})=>[id,label]));
  const warnings=layoutBalance.clearance?.map(({ids,type})=>{
    const [a,b]=ids.map(id=>names.get(id)??id);
    if(type==='frame')return a+' propeller sweep intersects the frame.';
    if(type==='propellers')return a+' and '+b+' propeller sweeps may overlap.';
    if(type==='propPart')return a+' propeller sweep may contact '+b+'.';
    return a+' and '+b+' may overlap.';
  });
  fillList('clearanceList',warnings?.length?warnings:[!warnings?'3D clearance is unavailable.':custom&&!allMounted()?'Place all components to complete the clearance check.':'No overlaps detected among placed parts.']);
}

let last=performance.now(),tick=0,reading=null;
function animate(now){
  const dt=Math.min(.05,(now-last)/1000);last=now;
  if(armed){
    let command=throttle;
    if(hold){
      const weight=model.mass/1000;
      const demand=Math.max(0,Math.min(envelope.lift,weight*(1+(1-alt)*.28-speed*.29)));
      command=model.commandsForThrust(envelope.shares.map(share=>share*demand),busVoltage);
      throttle=command.reduce((a,b)=>a+b,0)/command.length;
    }else if(canHold()){
      const demand=Math.min(envelope.lift,model.peak.t*throttle**2);
      command=model.commandsForThrust(envelope.shares.map(share=>share*demand),busVoltage);
    }
    reading=model.sample(command,soc);
    busVoltage=reading.v;
    const moment=rotorMoments(layoutBalance.rotors,layoutBalance,reading.rotors);
    const lift=reading.t*1000/model.mass;
    if(alt>0||lift>1){
      pitchRate+=(moment.pitch/layoutBalance.pitchInertia-2.1*pitchRate)*dt;
      rollRate+=(moment.roll/layoutBalance.rollInertia-2.1*rollRate)*dt;
      pitch+=pitchRate*dt;roll+=rollRate*dt;
    }else pitch=roll=pitchRate=rollRate=0;
    speed+=(gravity*(lift*Math.cos(pitch)*Math.cos(roll)-1)-1.05*speed)*dt;
    alt+=speed*dt;
    if(alt<0){alt=0;speed=0;}
    if(alt>12){alt=12;speed=Math.min(0,speed);}
    soc=Math.max(0,soc-reading.a*dt/(model.battery.ah*3600));
    const tipped=Math.hypot(pitch,roll)>.88;
    if(soc<=.2||tipped){
      armed=false;
      hold=false;
      flightOutcome=tipped?'Test stopped after excessive tilt. Final telemetry is shown below.':'Battery limit reached. Final telemetry is shown below.';
      renderFlight();
    }
  }else if(!flightOutcome)reading=null;
  viewport.pose(alt,armed?throttle:0,pitch,roll);
  if(tab==='flight'&&now-tick>100){
    tick=now;
    $('throttleValue').textContent=display(throttle*100,1,'%');
    if(hold)$('throttle').value=100*throttle;
    $('telemetry').innerHTML=[
      display(alt,2,' m altitude'),display(speed,2,' m/s vertical speed'),
      display(pitch*180/Math.PI,1,'° pitch'),display(roll*180/Math.PI,1,'° roll'),
      display(reading?.v,2,' V'),display(reading?.a,1,' A'),display(reading?.t,2,' kgf'),display(soc*100,0,'% battery')
    ].map(v=>'<span>'+v+'</span>').join('');
  }
  requestAnimationFrame(animate);
}
update(false);
requestAnimationFrame(animate);
