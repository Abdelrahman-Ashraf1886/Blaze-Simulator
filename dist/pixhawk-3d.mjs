import * as T from './three.js';
import {createCanvasView} from './canvas-view.mjs';
import {logicalPin} from './pixhawk.mjs';

const materials={
  case:new T.MeshStandardMaterial({color:0x212630,roughness:.53}),
  lip:new T.MeshStandardMaterial({color:0x485665,roughness:.62}),
  ivory:new T.MeshStandardMaterial({color:0xe1ded0,roughness:.54}),
  well:new T.MeshStandardMaterial({color:0x11161c,roughness:.76}),
  gold:new T.MeshBasicMaterial({color:0xe9b153}),
  mark:new T.MeshBasicMaterial({color:0xff7760}),
  screw:new T.MeshStandardMaterial({color:0xa5aab1,metalness:.42,roughness:.44}),
  light:new T.MeshBasicMaterial({color:0x5dab8b})
};
function box(group,w,h,d,material,x,y,z){
  const mesh=new T.Mesh(new T.BoxGeometry(w,h,d),material);
  mesh.position.set(x,y,z);group.add(mesh);return mesh;
}

export function makePixhawkMesh(board){
  const group=new T.Group(), anchors={}, contacts=[], sockets=[];
  const {width:w,length:d}=board;
  box(group,w,1.65,d,materials.case,0,.825,0);
  box(group,w*.99,.105,d*.989,materials.lip,0,1.04,0);
  box(group,w*.95,.09,d*.96,materials.case,0,1.68,0);
  const accentZ=board.flip?2.65:-3.46;
  const arrow=new T.Shape();
  arrow.moveTo(0,.52);arrow.lineTo(-.31,-.36);arrow.lineTo(0,-.18);arrow.lineTo(.31,-.36);arrow.closePath();
  const arrowMesh=new T.Mesh(new T.ShapeGeometry(arrow),materials.screw);
  arrowMesh.rotation.x=-Math.PI/2;
  if(board.flip)arrowMesh.rotation.z=Math.PI;
  arrowMesh.position.set(0,1.735,accentZ);group.add(arrowMesh);
  for(const x of [-1,1])for(const z of [-1,1]){
    const screw=new T.Mesh(new T.CylinderGeometry(.115,.115,.04,12),materials.screw);
    screw.position.set(x*w*.438,1.74,z*d*.432);group.add(screw);
  }
  for(let row=0;row<3;row++)box(group,.12,.035,.095,row===0?materials.light:materials.lip,w*.38,1.75,(board.flip?-2.55:-3.6)+row*.20);
  for(const port of board.ports){
    const header=port.kind==='header';
    const count=header?Math.ceil(port.pins.length/3):port.pins.length;
    const pitch=header?.329:.19;
    const width=count*pitch+(header?.03:.30),depth=header?.83:.64;
    const y=1.74, x=port.x,z=port.z;
    const socket=box(group,width,.10,depth,materials.well,x,y,z);
    socket.userData.socket=port.id;
    sockets.push(socket);
    const rim=header?materials.lip:materials.ivory;
    for(const side of [-1,1]){
      box(group,width,.23,.065,rim,x,y+.085,z+side*depth*.46).userData.socket=port.id;
      box(group,.065,.23,depth,rim,x+side*width*.46,y+.085,z).userData.socket=port.id;
    }
    if(!header)box(group,width*.28,.20,.07,rim,x,y+.10,z-.29).userData.socket=port.id;
    port.pins.forEach((pin,i)=>{
      const column=header?(pin.column??0):count-1-i;
      const px=x+(column-(count-1)/2)*pitch, pz=z+(header?((pin.row??i)-1)*.218:0);
      const contact=box(group,header?.083:.064,.11,.082,materials.gold,px,y+.109,pz);
      const hit=box(group,header?.22:.15,.04,header?.17:.24,materials.well,px,y+.07,pz);
      for(const object of [contact,hit])object.userData={socket:port.id,pin:i};
      contacts.push({port:port.id,index:i,object:contact,center:new T.Vector3(px,y+.18,pz)});
      if(pin.endpoint&&!anchors[pin.endpoint])anchors[pin.endpoint]=new T.Vector3(px,y+.18,pz);
      if(i===0&&!header)box(group,.07,.04,.09,materials.mark,px,y+.23,z+.24);
    });
  }
  return {group,anchors,contacts,sockets};
}

export function createPixhawkInspector(host,onHit){
  let renderer;
  try{renderer=new T.WebGLRenderer({alpha:true,antialias:true});}catch{renderer=createCanvasView();}
  if(!renderer){host.textContent='3D is unavailable. Select a socket below to inspect its pins.';return {update(){},focus(){}};}
  if('setPixelRatio' in renderer)renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  const label=document.createElement('span');
  label.className='pixhawk-socket-label';
  label.setAttribute('aria-hidden','true');
  host.append(renderer.domElement,label);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(35,1,.03,100);
  scene.add(new T.HemisphereLight(0xf1f5ff,0x6f7692,2.6));
  const key=new T.DirectionalLight(0xffeed7,2.2);key.position.set(-5,12,7);scene.add(key);
  const gold=new T.MeshBasicMaterial({color:0xffd071}), linked=new T.MeshBasicMaterial({color:0x756044}), active=new T.MeshBasicMaterial({color:0xffffff});
  const wireColors=new Map();
  let current=null,model=null,highlighted=null,yaw=-.22,pitch=1.17,distance=20,focusPoint=new T.Vector3(),pointer=null,queued=false,focused=false;
  const raycaster=new T.Raycaster();
  function redraw(){
    if(queued)return;
    queued=true;
    requestAnimationFrame(()=>{
      queued=false;
      const {clientWidth:w,clientHeight:h}=host;
      if(!w||!h||!model)return;
      if(camera.aspect!==w/h||renderer.domElement.clientWidth!==w){renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
      const d=distance*Math.max(1,.66/camera.aspect);
      camera.position.copy(focusPoint).add(new T.Vector3(Math.sin(yaw)*Math.cos(pitch)*d,Math.sin(pitch)*d,Math.cos(yaw)*Math.cos(pitch)*d));
      camera.lookAt(focusPoint);camera.updateMatrixWorld();scene.updateMatrixWorld();
      const result=renderer.render(scene,camera);
      if(highlighted){
        const mark=socketPoint(highlighted.id);
        mark.z-=.39;
        mark.y+=.28;
        mark.project(camera);
        label.hidden=Math.abs(mark.x)>.94||Math.abs(mark.y)>.90||Math.abs(mark.z)>1;
        label.style.left=(mark.x+1)*50+'%';
        label.style.top=(1-mark.y)*50+'%';
        label.textContent=highlighted.label;
      }
      if(!renderer.isWebGLRenderer&&!result)redraw();
    });
  }
  function socketPoint(selected){
    const socket=current?.ports.find(port=>port.id===selected);
    return socket?new T.Vector3(socket.x,1.78,socket.z):new T.Vector3();
  }
  function focus(selected){
    focused=Boolean(selected);
    focusPoint=socketPoint(selected);
    pitch=selected?1.31:1.17;
    yaw=selected?0:-.22;
    distance=selected?5.4:20;
    redraw();
  }
  function update(board,socket,palette,selected,connected,inspected){
    if(board!==current){
      if(model){scene.remove(model.group);model.group.traverse(object=>object.geometry?.dispose());}
      model=makePixhawkMesh(board);scene.add(model.group);current=board;focus(null);
    }
    highlighted=board.ports.find(port=>port.id===socket);
    if(focused)focusPoint=socketPoint(socket);
    for(const contact of model.contacts){
      const port=board.ports.find(port=>port.id===contact.port);
      const pin=port.pins[contact.index], endpoint=logicalPin(pin), color=palette[pin.role];
      if(color&&!wireColors.has(color))wireColors.set(color,new T.MeshBasicMaterial({color,toneMapped:false}));
      contact.object.material=(socket===port.id&&inspected===contact.index)||(endpoint&&endpoint===selected)?active:
        endpoint&&connected.has(endpoint)&&color?wireColors.get(color):
        socket===port.id?(color?wireColors.get(color):gold):materials.gold;
    }
    for(const mesh of model.sockets)mesh.material=mesh.userData.socket===socket?linked:materials.well;
    redraw();
  }
  const canvas=renderer.domElement;
  canvas.addEventListener('pointerdown',event=>{
    pointer={x:event.clientX,y:event.clientY,dragged:false};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove',event=>{
    if(!pointer)return;
    const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
    if(!pointer.dragged&&Math.hypot(dx,dy)<4)return;
    pointer={x:event.clientX,y:event.clientY,dragged:true};
    yaw-=dx*.012;pitch=Math.max(.20,Math.min(1.565,pitch+dy*.009));redraw();
  });
  canvas.addEventListener('pointerup',event=>{
    if(pointer&&!pointer.dragged&&model){
      const rect=canvas.getBoundingClientRect();
      raycaster.setFromCamera({x:(event.clientX-rect.left)/rect.width*2-1,y:1-(event.clientY-rect.top)/rect.height*2},camera);
      const hit=raycaster.intersectObject(model.group,true).find(x=>x.object.userData.socket);
      if(hit)onHit(hit.object.userData);
    }
    pointer=null;
  });
  canvas.addEventListener('pointercancel',()=>{pointer=null;});
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();distance=Math.max(2.8,Math.min(35,distance*Math.exp(event.deltaY*.001)));redraw();
  },{passive:false});
  const observer=new ResizeObserver(redraw);observer.observe(host);
  return {update,focus};
}
