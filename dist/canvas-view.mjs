import {Vector3} from './three.js';

export function createCanvasView(){
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d');
  if(!ctx)return null;
  let last=0;
  const colorCache=new WeakMap();
  const a=new Vector3(),b=new Vector3(),c=new Vector3(),edge=new Vector3(),normal=new Vector3();
  function render(scene,camera){
    if(performance.now()-last<45||!canvas.width||!canvas.height)return;
    last=performance.now();
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    const faces=[], halfW=canvas.width/2,halfH=canvas.height/2;
    scene.traverse(mesh=>{
      if(!mesh.isMesh||!mesh.visible)return;
      const {geometry,material}=mesh;
      const positions=geometry.getAttribute('position'), index=geometry.index;
      const triangles=(index?.count??positions.count)/3;
      const stride=Math.max(1,Math.ceil(triangles/10000));
      const color=colorCache.get(material)??material.color.getHex();
      colorCache.set(material,color);
      for(let i=0;i<triangles;i+=stride){
        for(const [p,offset] of [[a,0],[b,1],[c,2]]){
          const v=i*3+offset;
          p.fromBufferAttribute(positions,index?index.getX(v):v).applyMatrix4(mesh.matrixWorld);
        }
        const nz=normal.subVectors(b,a).cross(edge.subVectors(c,a)).normalize();
        const shade=.52+.47*Math.abs(nz.x*.36+nz.y*.85+nz.z*.38);
        a.project(camera);b.project(camera);c.project(camera);
        if(a.z<-1||b.z<-1||c.z<-1||a.z>1||b.z>1||c.z>1)continue;
        faces.push([a.x,a.y,b.x,b.y,c.x,c.y,(a.z+b.z+c.z)/3,color,shade,mesh.renderOrder]);
      }
    });
    faces.sort((a,b)=>a[9]-b[9]||b[6]-a[6]);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for(const [ax,ay,bx,by,cx,cy,,color,shade] of faces){
      ctx.fillStyle='rgb('+Math.round((color>>16)*shade)+','+Math.round((color>>8&255)*shade)+','+Math.round((color&255)*shade)+')';
      ctx.beginPath();ctx.moveTo((1+ax)*halfW,(1-ay)*halfH);
      ctx.lineTo((1+bx)*halfW,(1-by)*halfH);ctx.lineTo((1+cx)*halfW,(1-cy)*halfH);
      ctx.closePath();ctx.fill();
    }
    return true;
  }
  return {domElement:canvas,capabilities:{getMaxAnisotropy:()=>1},setPixelRatio(){},
    setSize(w,h){canvas.width=w;canvas.height=h;},
    setAnimationLoop(callback){function draw(now){callback(now);requestAnimationFrame(draw);}requestAnimationFrame(draw);},
    render};
}
