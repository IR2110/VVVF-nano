// State transport targets 30 updates/s; the ESP32 control loop publishes at 100 Hz.
export const STATE_PERIOD_MS=1000/30;
// VVS3 adds PWM-resolution trigger position to consecutive int8 samples.
export const SCOPE_MAX_PACKET_BYTES=65535;
export function pwmBadgeMode(s){return s.state==='stop'||s.state==='coast'||s.jpt?'none':s.mode==='async'?'async':'sync';}
export function displayState(s){
  const stopped=s.state==='stop', coast=s.state==='coast'||s.jpt;
  const frequency=stopped?'—':`${s.frequency_hz.toFixed(s.frequency_hz<10?2:1)} Hz`;
  const amplitude=stopped||coast?'—':`${(Math.max(0,Math.min(1,s.amplitude))*100).toFixed(1)} %`;
  let mode='—', pulse='—', detail='';
  if(!stopped&&!coast){
    if(s.mode==='async'){mode='非同期';pulse=`${Math.round(s.carrier_hz)} Hz`;}
    else if(s.mode==='carrier_sync'){mode='同期';pulse=`${s.ratio} パルス`;}
    else if(s.mode==='angle_sync'){mode='同期';pulse=`${s.pulses} パルス`;}
  }
  return {frequency,amplitude,mode,pulse,detail,label:{power:'力行',brake:'回生',regen_loss:'回生失効',coast:'惰性',stop:'停止'}[s.state]||'停止'};
}
export function formatSpeed(speed){return Math.max(0,speed).toFixed(1);}
export function waveformY(level,height){return height/2-level*(height*.42/126);}
export function decodeScope(buffer){
  const v=new DataView(buffer);
  if(v.byteLength<28)throw Error('波形データが不正です');
  const version=v.getUint32(0,true),precise=version===0x33535656,header=precise?32:28;
  if((!precise&&version!==0x32535656)||v.byteLength<header)throw Error('波形データが不正です');
  const count=v.getUint32(20,true),window=v.getUint32(12,true),position=v.getUint32(16,true),sampleHz=v.getUint32(8,true);
  const flags=v.getUint32(24,true);
  if(!window||!sampleHz||count<2||
    window!==Math.floor(count*1000000/sampleHz)||flags>3||
    v.byteLength>SCOPE_MAX_PACKET_BYTES||v.byteLength!==header+count)throw Error('波形データが不正です');
  let trigger=position,pwmHz=0,triggerTicks=0,sampleOffset=0,sampleSpan=count-1;
  if(precise){
    pwmHz=v.getUint32(28,true);triggerTicks=position;
    const bin=pwmHz/sampleHz,totalTicks=count*bin;
    if(!pwmHz||pwmHz%sampleHz||triggerTicks>totalTicks||
      Math.abs(triggerTicks-totalTicks/2)>=bin)throw Error('波形データが不正です');
    trigger=triggerTicks*1000000/pwmHz;
    // Each value is the average at the centre of its raw PWM acquisition bin.
    // Shift the sub-sample trigger to the exact visual centre of the window.
    sampleOffset=(totalTicks/2-triggerTicks+(bin-1)/2)/bin;
    sampleSpan=count;
  }else if(trigger!==Math.floor(window/2))throw Error('波形データが不正です');
  const samples=new Int8Array(buffer,header,count);
  for(const y of samples)if(Math.abs(y)>126||((flags&2)&&y!==0))throw Error('波形データが不正です');
  return {id:v.getUint32(4,true),sampleHz,window,trigger,pwmHz,triggerTicks,sampleOffset,sampleSpan,auto:!!(flags&1),zero:!!(flags&2),samples};
}
