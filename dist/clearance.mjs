import {Box3,Line3,Plane,Sphere,Triangle,Vector3} from './three.js';

export function checkClearance(components,rotors,surfaces){
  const warnings=[];
  const overlap=new Box3(), depth=new Vector3();
  const overlapEnough=(a,b)=>{
    overlap.copy(a).intersect(b);
    return !overlap.isEmpty()&&overlap.getSize(depth).toArray().every(d=>d>.025);
  };
  for(let i=0;i<components.length;i++)for(let j=i+1;j<components.length;j++){
    const a=components[i],b=components[j];
    if(overlapEnough(a.box,b.box)&&(a.pieces??[a.box]).some(p=>(b.pieces??[b.box]).some(q=>overlapEnough(p,q)))){
      warnings.push({ids:[a.id,b.id],type:'parts'});
    }
  }
  for(let i=0;i<rotors.length;i++){
    const a=rotors[i];
    for(const b of rotors.slice(i+1)){
      const normalAgreement=Math.abs(a.normal.dot(b.normal));
      const delta=b.center.clone().sub(a.center);
      const height=Math.abs(delta.dot(a.normal));
      if((normalAgreement>.995&&height<.055&&delta.lengthSq()-height*height<(a.radius+b.radius)**2)||
        (normalAgreement<=.995&&delta.length()<(a.radius+b.radius)))warnings.push({ids:[a.id,b.id],type:'propellers'});
    }
    if(surfaces.some(surface=>diskIntersects(a,surface)))warnings.push({ids:[a.id],type:'frame'});
    // Screen for contacts with hardware, excluding the propeller's own motor.
    for(const component of components){
      if(component.id===a.id)continue;
      const hit=(component.pieces??[component.box]).some(box=>{
        const point=box.clampPoint(a.center,new Vector3());
        const boxCenter=box.getCenter(new Vector3());
        const half=box.getSize(new Vector3()).multiplyScalar(.5);
        const height=Math.abs(boxCenter.sub(a.center).dot(a.normal));
        const reach=Math.abs(a.normal.x)*half.x+Math.abs(a.normal.y)*half.y+Math.abs(a.normal.z)*half.z;
        return height<reach+.025&&point.distanceToSquared(a.center)<a.radius**2;
      });
      if(hit)warnings.push({ids:[a.id,component.id],type:'propPart'});
    }
  }
  return warnings;
}

function diskIntersects(disk,mesh){
  const geometry=mesh.geometry;
  if(!geometry.boundingBox)geometry.computeBoundingBox();
  const bounds=geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  if(!bounds.intersectsSphere(new Sphere(disk.center,disk.radius)))return false;
  const normal=disk.normal,plane=new Plane().setFromNormalAndCoplanarPoint(normal,disk.center);
  if(!bounds.intersectsPlane(plane))return false;

  const attribute=geometry.getAttribute('position'), index=geometry.index;
  const vertices=[new Vector3(),new Vector3(),new Vector3()];
  const hits=[new Vector3(),new Vector3(),new Vector3(),new Vector3(),new Vector3(),new Vector3()];
  const segment=new Line3(),closest=new Vector3(),triangle=new Triangle();
  for(let i=0;i<(index?.count??attribute.count);i+=3){
    vertices.forEach((point,j)=>point.fromBufferAttribute(attribute,index?index.getX(i+j):i+j).applyMatrix4(mesh.matrixWorld));
    const distances=vertices.map(point=>plane.distanceToPoint(point));
    const epsilon=1e-5;
    if(distances.every(d=>d>epsilon)||distances.every(d=>d< -epsilon))continue;
    if(distances.every(d=>Math.abs(d)<=epsilon)){
      if(triangle.set(...vertices).closestPointToPoint(disk.center,closest).distanceToSquared(disk.center)<disk.radius**2)return true;
      continue;
    }
    let count=0;
    for(let j=0;j<3;j++){
      const k=(j+1)%3,a=distances[j],b=distances[k];
      if(Math.abs(a)<=epsilon)hits[count++].copy(vertices[j]);
      if(a*b<0)hits[count++].copy(vertices[j]).lerp(vertices[k],a/(a-b));
    }
    if(count===1&&hits[0].distanceToSquared(disk.center)<disk.radius**2)return true;
    for(let j=1;j<count;j++){
      if(segment.set(hits[0],hits[j]).closestPointToPoint(disk.center,true,closest).distanceToSquared(disk.center)<disk.radius**2)return true;
    }
  }
  return false;
}
