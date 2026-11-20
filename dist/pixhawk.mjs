const pin=(name,role='',endpoint=null,note='')=>({name,role,endpoint,note});
const vcc=(endpoint)=>pin('+5 V','power',endpoint,'Regulated 5 V');
const gnd=(endpoint)=>pin('GND','ground',endpoint);
const signal=(name,role,endpoint)=>pin(name,role,endpoint,'3.3 V logic');
const port=(id,label,x,z,pins,kind='socket')=>({id,label,x,z,pins,kind});
const telem=(n,x,z)=>port('TELEM'+n,'TELEM'+n,x,z,[
  vcc('P_TELEM'+n+'.5V'),signal('TX out','tx','P_TELEM'+n+'.T'+n+'_TX'),signal('RX in','rx','P_TELEM'+n+'.T'+n+'_RX'),
  signal('CTS in','signal'),signal('RTS out','signal'),gnd('P_TELEM'+n+'.GND')]);
const gps=(suffix,x,z,primary,extras)=>port('GPS'+suffix,'GPS'+suffix,x,z,[
  vcc(primary?'P_GPS.5V':null),signal('TX out','tx',primary?'P_GPS.GPS_TX':null),
  signal('RX in','rx',primary?'P_GPS.GPS_RX':null),...extras,gnd(primary?'P_GPS.GND':null)]);
const i2c=(x,z)=>port('I2C','I²C',x,z,[
  vcc('P_I2C.5V'),signal('SCL','i2c','P_I2C.SCL'),signal('SDA','i2c','P_I2C.SDA'),gnd('P_I2C.GND')]);
const can=(suffix,x,z,primary)=>port('CAN'+suffix,'CAN'+suffix,x,z,[
  vcc(primary?'P_CAN.5V':null),pin('CAN H','can',primary?'P_CAN.CAN_H':null),
  pin('CAN L','can',primary?'P_CAN.CAN_L':null),gnd(primary?'P_CAN.GND':null)]);
const power=(suffix,x,z,primary)=>port('POWER'+suffix,'POWER'+suffix,x,z,[
  vcc(primary?'FC.5V':null),vcc(),signal('Current sense','signal'),signal('Voltage sense','signal'),
  gnd(primary?'FC.GND':null),gnd()]);
const usb=(x,z)=>port('USB','USB',x,z,[vcc(),pin('D−'),pin('D+'),gnd()]);
const dsm=(x,z)=>port('DSM','DSM',x,z,[pin('+3.3 V','power'),gnd(),signal('DSM input','rc')]);
const main=(id,label,x,z,count,header=false)=>port(id,label,x,z,header?
  Array.from({length:count},(_,j)=>{
    const i=count-j;
    return [gnd(i===1&&id==='MAIN'?'FC.OUTPUT_GND':null),pin('Servo power','power'),
      signal('CH '+i,'signal',id==='MAIN'?'FC.OUT'+i:null)].map((contact,row)=>({...contact,number:i+' '+['−','+','S'][row],column:j,row}));
  }).flat():
  [pin('Servo rail','power'),...Array.from({length:count},(_,i)=>signal('CH '+(i+1),'signal',id==='MAIN'?'FC.OUT'+(i+1):null)),gnd(id==='MAIN'?'FC.OUTPUT_GND':null)],header?'header':'socket');

const legacy={
  name:'Pixhawk 2.4.8 · Pixhawk 1 reference',short:'PIXHAWK 2.4.8',revision:'2.4.8 clone layouts and connector families can vary. Verify the labels and pin 1 on your board.',
  doc:'https://docs.px4.io/v1.16/en/flight_controller/pixhawk', width:6.6,length:10.4, flip:true,
  ports:[
    dsm(-1.8,-1.36),port('BUZZER','BUZZER',.9,-1.36,[pin('Buzzer contact'),pin('Buzzer contact')]),
    telem(2,-2.1,-.34),port('SWITCH','SWITCH',-.15,-.34,[pin('+3.3 V','power'),pin('Safety LED','signal'),pin('Safety switch','signal')]),
    port('SERIAL','SERIAL 4/5',1.95,-.34,[vcc(),signal('TX 4','tx'),signal('RX 4','rx'),signal('TX 5','tx'),signal('RX 5','rx'),gnd()]),
    telem(1,-2.1,.7),gps('',1.95,.7,true,[signal('CAN2 TX','can'),signal('CAN2 RX','can')]),
    usb(-2.1,1.75),port('ADC3','ADC 3.3V',-.1,1.75,[vcc(),pin('ADC input'),gnd(),pin('ADC input'),gnd()]),can('',1.95,1.75,true),
    port('SPI','SPI',-2.0,3.42,[vcc(),pin('SCK'),pin('MISO'),pin('MOSI'),pin('NSS'),pin('GPIO'),gnd()]),i2c(1.95,3.42),
    power('',-2.1,4.47,true),port('ADC6','ADC 6.6V',1.95,4.47,[vcc(),pin('ADC input'),gnd()]),
    port('RC','RC IN',-3,-4.8,[{...gnd('P_RC_IN.GND'),row:0},{...vcc('P_RC_IN.5V'),row:1},{...signal('SBUS / PPM in','rc','P_RC_IN.SBUS'),row:2}],'header'),
    port('SBUS','SBUS OUT',-2.65,-4.8,[{...gnd(),row:0},{...pin('Servo power','power'),row:1},{...signal('SBUS out','rc'),row:2}],'header'),
    main('MAIN','MAIN OUT',-.9,-4.8,8,true),main('AUX','AUX OUT',1.72,-4.8,6,true)
  ]
};
const six={
  name:'Holybro Pixhawk 6C',short:'PIXHAWK 6C',revision:'Holybro documents hardware revisions for TELEM3 and I²C. Check the serial number before wiring those ports.',
  doc:'https://docs.holybro.com/autopilot/pixhawk-6c/pixhawk-6c-ports',width:6.4,length:10.6,flip:false,
  ports:[
    power('1',-1.99,-.22,true),dsm(-.01,-.22),usb(1.98,-.22),
    power('2',-1.99,.7,false),gps('2',-.01,.7,false,[signal('I²C 2 SCL','i2c'),signal('I²C 2 SDA','i2c')]),can('1',1.98,.7,true),
    gps('1',-1.62,1.65,true,[signal('I²C 1 SCL','i2c'),signal('I²C 1 SDA','i2c'),signal('Safety switch','signal'),signal('Safety LED','signal'),pin('I/O +3.3 V','power'),pin('Buzzer −','signal')]),
    port('SBUS','SBUS OUT',.55,1.65,[pin('Not connected'),signal('SBUS out','rc'),gnd()]),can('2',1.98,1.65,false),
    telem(1,-1.99,2.56),telem(2,-.01,2.56),port('TELEM3','TELEM3',1.98,2.56,[vcc(),signal('TX out','tx'),signal('RX in','rx'),pin('Revision dependent'),pin('Revision dependent'),gnd()]),
    port('RC','PPM / SBUS RC',-.98,3.47,[vcc('P_RC_IN.5V'),signal('PPM / SBUS in','rc','P_RC_IN.SBUS'),signal('RSSI in','signal'),pin('Not connected'),gnd('P_RC_IN.GND')]),i2c(1.05,3.47),
    main('AUX','FMU PWM OUT',-1.55,4.4,8),main('MAIN','I/O PWM OUT',1.55,4.4,8)
  ]
};

export function pixhawkBoard(controller){
  return controller===2?legacy:controller===1?six:null;
}
export const logicalPin=pin=>pin.endpoint==='FC.OUTPUT_GND'?'FC.GND':pin.endpoint;
