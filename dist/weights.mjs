export const maxWeights=12;
export const weightIds=Array.from({length:maxWeights},(_,i)=>'W'+(i+1));

export function mountedWeights(s){
  const weights=s.weights??{};
  return weightIds.flatMap((id,i)=>{
    const mass=weights[id];
    return Number.isFinite(mass)&&mass>=1&&mass<=5000?[{id,mass,label:'Weight '+(i+1)+' · '+mass+' g'}]:[];
  });
}
