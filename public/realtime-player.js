// Fixed-size PCM ring. No shifting/copying the book and no PCM history on the
// audio thread. All controls and chunks are tagged with the current run id.
class RealtimePlayer extends AudioWorkletProcessor {
  constructor() {
    super(); this.ring = new Float32Array(24000 * 32); this.reset("");
    this.port.onmessage = ({data:m}) => {
      if(m.type === "reset") {this.reset(m.runId); return;}
      if(m.runId !== this.runId) return;
      if(m.type === "pcm") {
        if(this.available + m.pcm.length > this.ring.length) {this.port.postMessage({type:"overflow",runId:this.runId}); return;}
        for(let i=0;i<m.pcm.length;i++) this.ring[(this.write++) % this.ring.length] = m.pcm[i];
        this.available += m.pcm.length;
      }
      if(m.type === "pause") this.paused = m.value;
      if(m.type === "end") this.ended = true;
    };
  }
  reset(id) {
    this.runId=id; this.read=0; this.write=0; this.available=0; this.fraction=0;
    this.played=0; this.paused=false; this.started=false; this.ended=false;
    this.stalls=0; this.starved=false; this.first=false; this.finished=false; this.tick=0;
  }
  process(_, outputs) {
    const out=outputs[0][0]; out.fill(0);
    if(!this.paused && !this.finished) {
      if(!this.started && (this.available >= 12000 || (this.ended && this.available))) this.started=true;
      if(this.started) for(let i=0;i<out.length;i++) {
        if(this.available < 1) {
          if(!this.ended && !this.starved) {this.stalls++;this.starved=true;}
          if(this.ended && !this.finished) {this.finished=true;this.port.postMessage({type:"finished",runId:this.runId});}
          break;
        }
        const a=this.ring[this.read % this.ring.length];
        const b=this.ring[(this.read+(this.available>1 ? 1 : 0)) % this.ring.length];
        out[i]=a+(b-a)*this.fraction;
        if(!this.first && Math.abs(out[i])>0.00001) {
          this.first=true; this.port.postMessage({type:"first",runId:this.runId,audioTime:currentTime+i/sampleRate});
        }
        this.starved=false; this.fraction += 24000/sampleRate;
        const step=Math.min(Math.floor(this.fraction),this.available);
        this.fraction -= step; this.read+=step; this.available-=step; this.played+=step;
      }
    }
    if(++this.tick % 20 === 0) this.port.postMessage({type:"progress",runId:this.runId,playedSeconds:this.played/24000,bufferSeconds:this.available/24000,stalls:this.stalls});
    return true;
  }
}
registerProcessor("qwen-realtime-player",RealtimePlayer);
