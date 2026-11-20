import {benchValue,benchDuty} from './bench.mjs';
import {peripherals,installedPeripherals,busConflict,wireRole} from './peripherals.mjs';

export const catalog = {
  battery:{name:'LiPo battery', icon:'▰', variants:[
    {name:'4S 1500 mAh',mass:185,v:14.8,ah:1.5,r:.024,a:90},
    {name:'6S 1300 mAh',mass:220,v:22.2,ah:1.3,r:.032,a:97.5},
    {name:'4S 2200 mAh',mass:250,v:14.8,ah:2.2,r:.020,a:110},
    {name:'6S 1500 mAh',mass:247,v:22.2,ah:1.5,r:.027,a:120},
    {name:'3S 1500 mAh',mass:143,v:11.1,ah:1.5,r:.019,a:75},
    {name:'3S 2200 mAh',mass:181,v:11.1,ah:2.2,r:.016,a:88},
    {name:'2S 1500 mAh',mass:106,v:7.4,ah:1.5,r:.014,a:60}]},
  controller:{name:'Flight controller',icon:'▦',variants:[
    {name:'F405-style · 5 V',mass:10},{name:'Pixhawk 6C-style · 5 V',mass:34},
    {name:'Pixhawk 2.4.8 + power module',mass:55,externalPower:true}]},
  esc:{name:'Multirotor ESC',icon:'▤',variants:[
    {name:'4-in-1 · 35 A',mass:17,ch:4,a:35,max:6,loss:.055},
    {name:'6-channel · 40 A',mass:45,ch:6,a:40,max:6,loss:.06},
    {name:'4-in-1 · 55 A',mass:24,ch:4,a:55,max:6,loss:.047},
    {name:'6 × 30 A discrete',mass:60,ch:6,a:30,max:6,loss:.07}]},
  motor:{name:'Brushless motor',icon:'◉',variants:[
    {name:'2207 · 1750 KV',mass:33,t:1.22,p:470,v:22.2},
    {name:'2306 · 2400 KV',mass:31,t:1.10,p:410,v:14.8,max:4},
    {name:'EMAX ECO II 2207 · 1700 KV',mass:34,t:1.26,p:480,v:22.2,max:6},
    {name:'iFlight XING2 2207 · 1855 KV',mass:34,t:1.40,p:545,v:22.2,max:6},
    {name:'T-Motor F60 Pro V · 1950 KV',mass:33,t:1.53,p:610,v:22.2,max:6},
    {name:'Emax RS2205 · 2300 KV',mass:30,t:.92,p:320,v:14.8,max:4}]},
  prop:{name:'Propeller',icon:'✣',variants:[
    {name:'5 × 4.0 in · 3 blade',mass:5,t:1,p:1},
    {name:'5 × 3.1 in · 2 blade',mass:4,t:.87,p:.77},
    {name:'5 × 4.3 in · 3 blade',mass:5.5,t:1.06,p:1.13}]}
};
export const singleton = ['battery','controller','esc'];
export const empty = (n=4) => ({n, battery:null, controller:null, esc:null, motor:Array(n).fill(null),prop:Array(n).fill(null),payload:0,peripherals:[],extraBatteries:[],wires:[]});
export const part = (s,k,i) => catalog[k].variants[i==null?s[k]:s[k][i]];
export const edge = (a,b) => [a,b].sort().join('|');
export const phases = ['U','V','W'];

export const maxBatteryPacks=6;
export const firstThreeS=4;
export function batteryPacks(s){
  if(!part(s,'battery'))return [];
  return [s.battery,...(s.extraBatteries??[]).slice(0,maxBatteryPacks-1)]
    .map((index,i)=>({id:i?'BAT'+(i+1):'BAT',spec:catalog.battery.variants[index]}))
    .filter(pack=>pack.spec);
}

export function seriesBattery(s){
  const packs=batteryPacks(s);
  if(!packs.length)return null;
  const specs=packs.map(pack=>pack.spec);
  const cells=specs.reduce((sum,b)=>sum+Math.round(b.v/3.7),0);
  return {cells,v:cells*3.7,mass:specs.reduce((sum,b)=>sum+b.mass,0),
    ah:Math.min(...specs.map(b=>b.ah)),r:specs.reduce((sum,b)=>sum+b.r,0),a:Math.min(...specs.map(b=>b.a)),
    mismatch:new Set(specs.map(b=>b.ah)).size>1};
}

export function upgradeWires(wires){
  return [...new Set(wires.flatMap(wire=>{
    const phase=/^ESC\.PH(\d+)\|M(\d+)\.UVW$/.exec(wire);
    return phase?phases.map(p=>edge('ESC.M'+phase[1]+p,'M'+phase[2]+'.'+p)):[wire];
  }))];
}
export function circuit(s){
  const groups = [], links = [];
  const add = (id,label,pins,type) => groups.push({id,label,pins,type});
  const connect = (a,b,kind) => links.push({a,b,kind,key:edge(a,b)});
  const packs=batteryPacks(s), fc=part(s,'controller'), esc=part(s,'esc');
  packs.forEach(({id,spec},i)=>add(id,(packs.length>1?'Pack '+(i+1)+' · ':'')+spec.name,['+','−'],'battery'));
  if(fc){
    add('FC',fc.name,['5V','GND',...Array.from({length:s.n},(_,i)=>'OUT'+(i+1))],fc.externalPower?'pixhawk':'controller');
    if(fc.externalPower)add('PM','Pixhawk power module',['IN+','IN−','5V','GND'],'module');
  }
  if(esc)add('ESC',esc.name,['VBAT','GND','BEC','SGND',...Array.from({length:esc.ch},(_,i)=>['IN'+(i+1),...phases.map(p=>'M'+(i+1)+p)]).flat()],'esc');
  s.motor.forEach((m,i)=>{if(m!=null)add('M'+(i+1),'M'+(i+1)+' · '+part(s,'motor',i).name,phases,'motor');});
  for(const id of installedPeripherals(s)){
    const item=peripherals[id], port='P_'+item.port.replaceAll(' ','_');
    add(id,item.name,item.pins.map(([pin])=>pin),'accessory');
    groups.at(-1).protocol=item.protocol;
    if(fc&&s.controller>0){
      let group=groups.find(g=>g.id===port);
      if(!group){add(port,'Pixhawk '+item.port,[],'port');group=groups.at(-1);}
      for(const [pin,target,kind] of item.pins){
        if(!group.pins.includes(target))group.pins.push(target);
        connect(id+'.'+pin,port+'.'+target,kind);
      }
    }
  }
  const present = new Set(groups.flatMap(g=>g.pins.map(p=>g.id+'.'+p)));
  const positive=(packs.at(-1)?.id??'BAT')+'.+';
  for(let i=0;i<packs.length-1;i++)connect(packs[i].id+'.+',packs[i+1].id+'.−','series');
  connect(positive,'ESC.VBAT','power');connect('BAT.−','ESC.GND','ground');
  if(fc?.externalPower){
    connect(positive,'PM.IN+','power');connect('BAT.−','PM.IN−','ground');
    connect('PM.5V','FC.5V','power');connect('PM.GND','FC.GND','ground');
    connect('ESC.SGND','FC.GND','ground');
  }else{
    connect('ESC.BEC','FC.5V','power');connect('ESC.SGND','FC.GND','ground');
  }
  for(let i=1;i<=s.n;i++){
    connect('FC.OUT'+i,'ESC.IN'+i,'signal');
    for(const p of phases)connect('ESC.M'+i+p,'M'+i+'.'+p,'phase');
  }
  const pinKinds=new Map(links.flatMap(link=>[[link.a,wireRole(link)],[link.b,wireRole(link)]]));
  return {groups,present,pinKinds,required:links.length,links:links.filter(l=>present.has(l.a)&&present.has(l.b))};
}
export function analyze(s,frameMass=s.n===4?128:196){
  const battery=seriesBattery(s), esc=part(s,'esc'), fc=part(s,'controller');
  const motors=s.motor.map((_,i)=>part(s,'motor',i));
  const props=s.prop.map((_,i)=>part(s,'prop',i));
  const {links,required}=circuit(s);
  const matched=links.filter(l=>s.wires.includes(l.key)).length;
  const assembly=Boolean(battery&&esc&&fc&&motors.every(Boolean)&&props.every(Boolean));
  const accessoryOK=(!installedPeripherals(s).length||s.controller>0)&&!busConflict(s);
  const wired=assembly&&accessoryOK&&links.length===required&&matched===links.length&&matched===s.wires.length;
  const voltageOK=Boolean(battery&&esc&&battery.cells<=esc.max&&motors.every(m=>!m?.max||battery.cells<=m.max));
  const curves=motors.map((_,i)=>s.bench?.[s.motor[i]+':'+s.prop[i]]);
  const hardware=installedPeripherals(s).map(id=>peripherals[id]);
  const accessoryMass=hardware.reduce((sum,item)=>sum+item.mass,0);
  const accessoryPower=hardware.reduce((sum,item)=>sum+item.watts,0);
  const mass=frameMass+accessoryMass+Number(s.payload)+(battery?.mass??0)+(esc?.mass??0)+(fc?.mass??0)+[...motors,...props].reduce((sum,p)=>sum+(p?.mass??0),0)+s.wires.length*.55;
  function sample(duty,soc=1){
    if(!battery||!esc||!voltageOK)return {v:0,a:0,t:0,p:0,loss:0,amps:0,limited:false};
    const open=battery.v*(.88+.12*soc);
    const resistance=battery.r+.006;
    const idle=(fc?.mass>20?3:1.4)+accessoryPower;
    const channels=motors.map((m,i)=>({m,prop:props[i]}));
    const duties=Array.isArray(duty)?duty:channels.map(()=>duty);
    const electrical=(scale,v)=>channels.map(({m,prop},i)=>{
      if(!m||!prop)return 0;
      const curve=curves[i];
      return curve?benchValue(curve,duties[i]*scale*v/curve.voltage,2)*curve.voltage/(1-esc.loss):
        m.p*prop.p*Math.pow(duties[i]*scale*v/m.v,3)/(1-esc.loss);
    });
    function solve(command){
      let lo=open*.5,hi=open;
      for(let j=0;j<22;j++){
        const v=(lo+hi)/2;
        const demand=electrical(command,v).reduce((a,b)=>a+b,idle)/v;
        if((open-v)/resistance>demand)lo=v;else hi=v;
      }
      const v=(lo+hi)/2;
      const loads=electrical(command,v);
      const a=loads.reduce((sum,w)=>sum+w,idle)/v;
      const amps=Math.max(...loads)/v;
      const currents=loads.map(w=>w/v);
      const reasons=[];
      if(a>battery.a)reasons.push('Battery current exceeds '+battery.a+' A');
      const limitMotor=currents.indexOf(amps)+1;
      if(amps>esc.a)reasons.push('Motor '+limitMotor+' exceeds the ESC channel limit of '+esc.a+' A');
      if(v<(battery.cells)*3.15)reasons.push('Battery voltage drops below 3.15 V per cell');
      return {v,a,amps,currents,limitMotor,reasons,invalid:reasons.length>0};
    }
    let command=1;
    let result=solve(command);
    const limited=result.invalid;
    const requested=result;
    if(limited){
      let lo=0,hi=command;
      for(let j=0;j<17;j++){
        const mid=(lo+hi)/2;
        if(solve(mid).invalid)hi=mid;else lo=mid;
      }
      command=lo;
      result=solve(command);
    }
    const {v,a,amps}=result;
    const rotors=channels.map(({m,prop},i)=>{
      if(!m||!prop)return 0;
      const curve=curves[i];
      return curve?benchValue(curve,duties[i]*command*v/curve.voltage,1):m.t*prop.t*Math.pow(duties[i]*command*v/m.v,2);
    });
    const t=rotors.reduce((a,b)=>a+b,0);
    return {v,a,amps,t,rotors,p:open*a,loss:a*a*resistance+(v*a-idle)*esc.loss,limited,requested,currents:result.currents};
  }
  function commandsForThrust(forces,voltage){
    return motors.map((m,i)=>{
      const prop=props[i];
      if(!m||!prop||!voltage)return 0;
      const curve=curves[i];
      if(curve)return Math.min(1,benchDuty(curve,forces[i])*curve.voltage/voltage);
      return Math.min(1,Math.sqrt(forces[i]/(m.t*prop.t))*m.v/voltage);
    });
  }
  const peak=assembly&&voltageOK?sample(1):null;
  const ratio=peak?peak.t*1000/mass:null;
  let hover=null;
  if(ratio>1){
    let lo=0,hi=1;
    for(let j=0;j<20;j++){
      const mid=(lo+hi)/2;
      if(sample(mid).t*1000<mass)lo=mid;else hi=mid;
    }
    hover={duty:hi,...sample(hi)};
  }
  return {mass,measuredRotors:curves.map(Boolean),assembly,wired,accessoryOK,required,voltageOK,matched,ratio,peak,hover,sample,commandsForThrust,ready:wired&&voltageOK&&ratio>1,battery,esc};
}
