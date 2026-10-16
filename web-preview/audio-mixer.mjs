import {audibleTracks} from './audio-policy.mjs';
export class ArenaAudio {
  constructor(onChange) {
    this.enabled=true; this.master=.5; this.onChange=onChange; this.wanted=new Set(); this.signature=null;
    this.blocked=false; this.lastState=null;
    this.tracks=Object.fromEntries(Object.entries({music:.38,crowd:.42,robot:.55,laser:.85}).map(([name,gain])=>{
      const media=document.createElement('audio'); media.src=new URL(`./audio/${name}.mp3`,import.meta.url).href;
      media.preload='none'; media.loop=true; media.dataset.track=name; media.hidden=true; document.body.append(media);
      media.addEventListener('error',()=>{this.onChange('Áudio indisponível');});
      return [name,{media,gain,pending:false}];
    }));
  }
  setVolume(value) {this.master=Math.max(0,Math.min(1,Number(value)||0));for(const t of Object.values(this.tracks))t.media.volume=this.master*t.gain;}
  stop() {this.wanted.clear();this.signature=null;for(const t of Object.values(this.tracks))t.media.pause();}
  sync(state) {
    this.lastState=state;
    const names=audibleTracks({...state,enabled:this.enabled}); const sig=names.join(',');
    if(sig===this.signature)return;
    this.signature=sig;this.wanted=new Set(names);
    for(const [name,t] of Object.entries(this.tracks)) {
      t.media.volume=this.master*t.gain;
      if(!this.wanted.has(name)) {t.media.pause();continue;}
      if(this.blocked||t.pending||!t.media.paused)continue;
      t.pending=true;
      t.media.play().then(()=>{if(!this.wanted.has(name))t.media.pause();}).catch(()=>{
        // Autoplay can be rejected by browser policy. Keep the user's intent
        // enabled and wait for a real gesture instead of reporting sound off.
        this.blocked=true;
      }).finally(()=>{t.pending=false;});
    }
    this.onChange(this.enabled?(names.length?'Som ligado':'Som pausado'):'Som desligado');
  }
  retryAfterGesture() {
    if(!this.enabled||!this.blocked||!this.lastState)return;
    this.blocked=false;
    this.signature=null;
    this.sync(this.lastState);
  }
}
