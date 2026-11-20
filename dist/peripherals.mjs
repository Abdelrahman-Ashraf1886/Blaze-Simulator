const power=['5V','5V','power'], ground=['GND','GND','ground'];
const uart=(port)=>[power,ground,['RX',port+'_TX','uart'],['TX',port+'_RX','uart']];
const bus=(a,b,kind)=>[power,ground,[a,a,kind],[b,b,kind]];
const define=(name,protocol,port,mass,watts,pins)=>({name,protocol,port,mass,watts,pins});

export const peripherals={
  RC:define('RC receiver','SBUS','RC IN',8,.18,[power,ground,['SBUS','SBUS','rc']]),
  RADIO:define('Telemetry radio','MAVLink over UART','TELEM1',18,.75,uart('T1')),
  GPS:define('GPS / GNSS module','GNSS over UART','GPS',24,.28,uart('GPS')),
  COMPASS:define('External compass','I²C','I2C',6,.10,bus('SDA','SCL','i2c')),
  AIR:define('Digital airspeed sensor','I²C','I2C',10,.12,bus('SDA','SCL','i2c')),
  PRESSURE:define('External barometer','I²C','I2C',5,.08,bus('SDA','SCL','i2c')),
  RANGE:define('LiDAR rangefinder','DroneCAN','CAN',16,.65,bus('CAN_H','CAN_L','can')),
  FLOW:define('Optical flow sensor','MAVLink over UART','TELEM2',10,.30,uart('T2')),
  GPSCAN:define('CAN GNSS / compass','DroneCAN','CAN',30,.45,bus('CAN_H','CAN_L','can')),
  ADSB:define('ADS-B receiver','MAVLink over UART','TELEM2',18,.48,uart('T2')),
  BUZZ:define('Buzzer','Buzzer output','BUZZER',5,.12,[['SIG','BUZZ','signal'],ground]),
  SAFE:define('Safety button','Safety switch','SAFETY',5,.04,[['SW','SAFETY','signal'],ground])
};

export const installedPeripherals=s=>(s.peripherals??[]).filter(id=>Object.hasOwn(peripherals,id));
export const busConflict=s=>{
  const ports=installedPeripherals(s).map(id=>peripherals[id].port).filter(port=>port.startsWith('TELEM'));
  return ports.length!==new Set(ports).size;
};

export const wireTypes={
  power:{color:'#ff765d',name:'Power'},ground:{color:'#bdc7d2',name:'Ground'},
  signal:{color:'#ffcd75',name:'Control / PWM'},phase:{color:'#72b5ff',name:'Motor phase'},
  rc:{color:'#ffae64',name:'SBUS'},uart:{color:'#c7a0ff',name:'UART'},
  i2c:{color:'#72dcb0',name:'I²C'},can:{color:'#55e1e8',name:'CAN'},
  invalid:{color:'#ff6391',name:'Unexpected'}
};
