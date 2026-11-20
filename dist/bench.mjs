export function parseBenchCSV(text,voltage){
  if(!Number.isFinite(voltage)||voltage<1||voltage>60)throw new Error('Enter the test voltage (1–60 V).');
  const rows=text.trim().split(/\r?\n/).map(line=>line.split(',').map(cell=>cell.trim()));
  const aliases=[['throttle_pct','throttle_percent'],['thrust_g','thrust_grams'],['current_a','amps']];
  const header=rows.shift().map(cell=>cell.toLowerCase());
  const columns=aliases.map(names=>header.findIndex(cell=>names.includes(cell)));
  if(columns.some(index=>index<0))throw new Error('Use CSV headers throttle_pct,thrust_g,current_a.');
  if(rows.length<2||rows.length>300)throw new Error('Provide 2–300 measured rows.');
  const points=rows.map(row=>columns.map(index=>row[index]?Number(row[index]):NaN));
  points.unshift([0,0,0]);
  const curve=points.filter((row,i)=>i!==1||row[0]!==0||row[1]!==0||row[2]!==0);
  const invalid=curve.some(([duty,thrust,current],i)=>{
    const previous=curve[i-1];
    if(![duty,thrust,current].every(v=>Number.isFinite(v)&&v>=0))return true;
    if(duty>100||thrust>30000||current>500)return true;
    return Boolean(previous&&(duty<=previous[0]||thrust<previous[1]||current<previous[2]));
  });
  if(invalid||curve.at(-1)[1]<=0)throw new Error('Measurements must increase by throttle, with nondecreasing thrust and current.');
  return {voltage,points:curve.map(([d,t,a])=>[d/100,t/1000,a])};
}

export function benchValue(curve,duty,column){
  const {points}=curve;
  const upper=points.findIndex(p=>p[0]>=duty);
  if(upper<0)return points.at(-1)[column];
  if(upper===0)return points[0][column];
  const a=points[upper-1],b=points[upper];
  return a[column]+(b[column]-a[column])*(duty-a[0])/(b[0]-a[0]);
}

export function benchDuty(curve,force){
  if(force<=0)return 0;
  const upper=curve.points.findIndex(p=>p[1]>=force);
  if(upper<0)return curve.points.at(-1)[0];
  const a=curve.points[upper-1],b=curve.points[upper];
  return a[0]+(b[0]-a[0])*(force-a[1])/(b[1]-a[1]);
}
