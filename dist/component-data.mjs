const field=(key,label,min,max,step=1)=>({key,label,min,max,step});
const mass=field('mass','Mass (g)',.1,5000,.1);
export const componentFields={
  motor:[mass,field('kv','Motor KV (rpm/V)',1,50000),field('testVoltage','Test voltage (V)',1,60,.1),
    field('thrust','Static thrust at test voltage (g)',1,30000),field('current','Current at the same test point (A)',.01,500,.01),
    field('cells','Maximum LiPo cells',1,14)],
  prop:[mass,field('diameter','Diameter (in)',1,24,.01),field('pitch','Pitch (in)',.2,20,.01),field('blades','Blade count',2,6)],
  battery:[mass,field('cells','LiPo cells',1,14),field('capacity','Capacity (mAh)',50,40000),
    field('discharge','Continuous discharge (C)',1,300,.1),field('resistance','Pack resistance (mΩ)',.1,1000,.1)],
  esc:[mass,field('channels','Output channels',1,8),field('current','Continuous current per channel (A)',1,300,.1),
    field('cells','Maximum LiPo cells',1,14)],
  controller:[mass,field('watts','Power consumption (W)',.01,40,.01)]
};
export const componentTypeLabels={motor:'Brushless motor',prop:'Propeller',battery:'LiPo battery',esc:'ESC',controller:'5 V flight controller'};
export const customLimit=40;
const string=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';

export function validateComponent(type,raw){
  if(!Object.hasOwn(componentFields,type))throw new Error('Choose a supported component type.');
  const name=string(raw.name,100);
  if(!name)throw new Error('Enter the component name.');
  const spec={name};
  for(const {key,label,min,max,step} of componentFields[type]){
    const value=raw[key];
    if(!Number.isFinite(value)||value<min||value>max||(step===1&&!Number.isInteger(value)))throw new Error('Check '+label.toLowerCase()+'.');
    spec[key]=value;
  }
  const source=string(raw.source,120);
  if(source)spec.source=source;
  return spec;
}

export function toVariant(type,raw){
  const {name,mass}=raw;
  const base={name,mass,custom:true};
  if(type==='motor')return {...base,t:raw.thrust/1000,p:raw.current*raw.testVoltage,v:raw.testVoltage,max:raw.cells,kv:raw.kv};
  if(type==='prop'){
    const size=raw.diameter/5, pitch=raw.pitch/4, blades=raw.blades/3;
    return {...base,diameter:raw.diameter,pitch:raw.pitch,blades:raw.blades,
      t:size**2*Math.sqrt(pitch)*blades**.45,p:size**3*pitch**.7*blades**.55};
  }
  if(type==='battery')return {...base,v:raw.cells*3.7,ah:raw.capacity/1000,r:raw.resistance/1000,a:raw.capacity/1000*raw.discharge};
  if(type==='esc')return {...base,ch:raw.channels,a:raw.current,max:raw.cells,loss:.055};
  return {...base,watts:raw.watts};
}

function quantity(text,label,unit){
  const match=new RegExp('(?:^|\\b)(?:'+label+')\\b\\s*[:=–-]?\\s*(\\d+(?:[.,]\\d+)?)\\s*('+unit+')(?![a-z])','im').exec(text);
  return match?{value:Number(match[1].replace(',','.')),unit:match[2].toLowerCase()}:null;
}
export function extractComponent(type,source){
  const text=source.replace(/[\u00a0\u202f]/g,' ').replace(/\r/g,'\n')
    .replace(/^([a-z 0-9]+),[ \t]*(\d+(?:\.\d+)?)[ \t]*,[ \t]*([a-zµω]+)$/gim,'$1 $2 $3');
  const fields={};
  const massReading=quantity(text,'(?:net\\s+)?(?:weight|mass)','kg|g(?:rams?)?');
  if(massReading)fields.mass=massReading.value*(massReading.unit==='kg'?1000:1);
  const cells=/\b(\d+)\s*S\s*(?:[-–~]|to)\s*(\d+)\s*S\b/i.exec(text)??/\b(\d+)\s*(?:[-–~]|to)\s*(\d+)\s*S\b/i.exec(text);
  const oneCell=quantity(text,'(?:max(?:imum)?\\s+)?(?:lipo\\s+)?(?:cell count|cells?|battery|voltage rating)','s');
  if(cells||oneCell)fields.cells=cells?Number(cells[2]):oneCell.value;
  if(type==='motor'){
    const kv=/\b(?:motor\s+)?k\s*v\s*[:=]?\s*(\d{2,5})\b|\b(\d{2,5})\s*(?:k\s*v|rpm\s*\/\s*v)\b/i.exec(text);
    if(kv)fields.kv=Number(kv[1]??kv[2]);
    const v=quantity(text,'test voltage|bench voltage|voltage at test|rated voltage','v');
    const thrust=quantity(text,'(?:max(?:imum)?\\s+)?(?:static\\s+)?thrust','kgf|kg|gf|g|n');
    const current=quantity(text,'test current|current at test|current at (?:peak|max(?:imum)?) thrust|current draw','a');
    if(v)fields.testVoltage=v.value;
    if(thrust)fields.thrust=Math.round(thrust.value*(thrust.unit.startsWith('kg')?1000:thrust.unit==='n'?1000/9.80665:1));
    if(current)fields.current=current.value;
  }else if(type==='prop'){
    const pattern=/\b(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*[x×]\s*([2-6]))?\s*(?:in(?:ch(?:es)?)?\b|["″])?/i.exec(text);
    if(pattern&&Number(pattern[1])<=24){fields.diameter=Number(pattern[1]);fields.pitch=Number(pattern[2]);if(pattern[3])fields.blades=Number(pattern[3]);}
    for(const key of ['diameter','pitch']){
      const value=quantity(text,key,'mm|in(?:ch(?:es)?)?|["″]');
      if(value)fields[key]=Math.round(value.value/(value.unit==='mm'?25.4:1)*100)/100;
    }
    const blades=/\b([2-6])\s*[- ]?blades?\b|\b(?:blade count|blades)\s*[:=]?\s*([2-6])\b/i.exec(text);
    if(blades)fields.blades=Number(blades[1]??blades[2]);
  }else if(type==='battery'){
    const capacity=quantity(text,'(?:rated\\s+)?capacity','mah|ah')??(text.match(/\b(\d{2,5})\s*mAh\b/i)?.[1]&&{value:Number(text.match(/\b(\d{2,5})\s*mAh\b/i)[1]),unit:'mah'});
    const discharge=quantity(text,'continuous discharge(?: rate)?|discharge rating','c');
    const resistance=quantity(text,'(?:internal|pack) resistance','mω|mohm|milliohms?|ohms?|ω');
    if(capacity)fields.capacity=capacity.value*(capacity.unit==='ah'?1000:1);
    if(discharge)fields.discharge=discharge.value;
    if(resistance)fields.resistance=resistance.value*(/^(?:ohms?|ω)$/.test(resistance.unit)?1000:1);
    if(fields.cells==null){const pack=/\b(\d{1,2})\s*S\b/i.exec(text);if(pack)fields.cells=Number(pack[1]);}
  }else if(type==='esc'){
    const current=quantity(text,'continuous (?:current|rating)|rated current','a');
    const outputs=/\b([1-8])\s*[- ]?(?:in[- ]?1|channels?)\b|\bchannels\s*[:=]?\s*([1-8])\b/i.exec(text);
    if(current)fields.current=current.value;
    if(outputs)fields.channels=Number(outputs[1]??outputs[2]);
  }else{
    const power=quantity(text,'power consumption|power draw','w|mw');
    if(power)fields.watts=power.value/(power.unit==='mw'?1000:1);
  }
  return fields;
}

export async function readDatasheet(file){
  if(file.size>12*1024*1024)throw new Error('Choose a datasheet under 12 MB.');
  if(!/\.pdf$/i.test(file.name)){
    if(!/\.(?:txt|csv|md)$/i.test(file.name))throw new Error('Choose a PDF, TXT, CSV, or Markdown datasheet.');
    return (await file.text()).slice(0,200000);
  }
  const pdfjs=await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.min.mjs',import.meta.url).href;
  const task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,disableFontFace:true,
    standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href});
  try{
    const pdf=await task.promise;
    const text=[];
    for(let n=1;n<=Math.min(pdf.numPages,12);n++){
      const page=await pdf.getPage(n);
      const contents=await page.getTextContent();
      text.push(contents.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join(''));
    }
    return text.join('\n').slice(0,200000);
  }finally{await task.destroy();}
}
