import {peripherals,installedPeripherals} from './peripherals.mjs';
import {part,batteryPacks} from './model.mjs';

export const mmPerUnit=40;

export function balance(entries,frameMass,frameY){
  let mass=frameMass, x=0,y=frameMass*frameY,z=0;
  for(const {mass:weight,position} of entries){
    if(!position)continue;
    mass+=weight;
    x+=position.x*weight;
    y+=position.y*weight;
    z+=position.z*weight;
  }
  return {x:x/mass,y:y/mass,z:z/mass};
}

export function placementOptions(s){
  const options=[];
  for(const [id,type] of [['ESC','esc'],['FC','controller']]){
    const spec=part(s,type);
    if(spec)options.push({id,label:spec.name,mass:spec.mass-(id==='FC'&&s.controller===2?15:0)});
  }
  const packs=batteryPacks(s);
  options.unshift(...packs.map(({id,spec},i)=>({id,label:(packs.length>1?'Pack '+(i+1)+' · ':'')+spec.name,mass:spec.mass})));
  if(s.controller===2)options.push({id:'PM',label:'Pixhawk power module',mass:15});
  for(let i=0;i<s.n;i++){
    const motor=part(s,'motor',i),prop=part(s,'prop',i);
    if(motor||prop)options.push({id:'M'+(i+1),label:'Rotor '+(i+1),mass:(motor?.mass??0)+(prop?.mass??0)});
  }
  for(const id of installedPeripherals(s))options.push({id,label:peripherals[id].name,mass:peripherals[id].mass});
  if(s.payload>0)options.push({id:'LOAD',label:'Additional mass',mass:s.payload});
  return options;
}
