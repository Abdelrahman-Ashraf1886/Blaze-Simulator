export const gravity=9.80665;
const epsilon=1e-7;

function determinant(a,b,c){
  return a[0]*(b[1]*c[2]-b[2]*c[1])-b[0]*(a[1]*c[2]-a[2]*c[1])+c[0]*(a[1]*b[2]-a[2]*b[1]);
}

// Find a bounded thrust allocation on the intersection of the lift and torque constraints.
export function allocate(rotors,center,caps,target){
  const axes=rotors.map(r=>[1,r.x-center.x,r.z-center.z]);
  const n=axes.length;
  let best=null,bestCost=Infinity;
  for(let i=0;i<n-2;i++)for(let j=i+1;j<n-1;j++)for(let k=j+1;k<n;k++){
    const a=axes[i],b=axes[j],c=axes[k],det=determinant(a,b,c);
    if(Math.abs(det)<epsilon)continue;
    const fixed=axes.map((_,p)=>p).filter(p=>p!==i&&p!==j&&p!==k);
    for(let mask=0;mask<2**fixed.length;mask++){
      const rhs=[target,0,0], forces=Array(n).fill(0);
      fixed.forEach((p,bit)=>{
        const f=mask&(1<<bit)?caps[p]:0;
        forces[p]=f;
        for(let row=0;row<3;row++)rhs[row]-=axes[p][row]*f;
      });
      forces[i]=determinant(rhs,b,c)/det;
      forces[j]=determinant(a,rhs,c)/det;
      forces[k]=determinant(a,b,rhs)/det;
      if(forces.some((f,p)=>f < -epsilon||f>caps[p]+epsilon))continue;
      const cost=forces.reduce((sum,f,p)=>sum+(f/caps[p])**2,0);
      if(cost<bestCost){best=forces.map(f=>Math.max(0,f));bestCost=cost;}
    }
  }
  return best;
}

export function hoverEnvelope(rotors,center,caps){
  if(!center||!caps||rotors.some(r=>!r)||caps.some(c=>c<=0))return null;
  let lower=0,upper=caps.reduce((a,b)=>a+b,0);
  let allocation=null;
  for(let i=0;i<20;i++){
    const target=(lower+upper)/2;
    const next=allocate(rotors,center,caps,target);
    if(next){lower=target;allocation=next;}else upper=target;
  }
  return {lift:lower,shares:allocation?.map(f=>f/lower)??null};
}

export function rotorMoments(rotors,center,forces){
  let pitch=0,roll=0;
  for(let i=0;i<rotors.length;i++){
    const r=rotors[i],force=forces[i]*gravity;
    pitch-=(r.z-center.z)*.04*force;
    roll+=(r.x-center.x)*.04*force;
  }
  return {pitch,roll};
}
