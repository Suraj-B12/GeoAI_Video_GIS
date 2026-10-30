const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function setup(t, missingSDK = false) {
  const dom = new JSDOM('<div id="map"></div>', { url: 'http://localhost/gis/app/', runScripts: 'outside-only' });
  const w = dom.window;
  let now = 0, sequence = 0;
  const timers = new Map();
  w.setTimeout = (fn, ms = 0) => { const id = ++sequence; timers.set(id,{ fn, at:now+ms }); return id; };
  w.clearTimeout = id => timers.delete(id);
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([,timer]) => timer.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = end;
  };
  const evented = () => {
    const listeners = new Map();
    return {
      on(name,fn){ const all = listeners.get(name)||[]; all.push(fn); listeners.set(name,all); return this; },
      off(name,fn){ listeners.set(name,(listeners.get(name)||[]).filter(f=>f!==fn)); return this; },
      once(name,fn){ const call=e=>{this.off(name,call);fn(e);};this.on(name,call); return this; },
      fire(name,event={}){ for(const fn of [...(listeners.get(name)||[])]) fn(event);return this; }
    };
  };
  const viewport = { lat:12.93, lon:77.565 }, layers = new Set(), attributions = new Set();
  const map = {
    ...evented(),
    getBounds:()=>({getWest:()=>viewport.lon-.002,getEast:()=>viewport.lon+.002,getNorth:()=>viewport.lat+.002,getSouth:()=>viewport.lat-.002}),
    getCenter:()=>({lat:viewport.lat,lng:viewport.lon}),getZoom:()=>17,
    removeLayer(layer){layers.delete(layer);layer.onRemove?.(this);},
    attributionControl:{addAttribution:s=>attributions.add(s),removeAttribution:s=>attributions.delete(s)}
  };
  const vectors = [], rasters = [];
  w.L = {
    Util:{ cancelAnimFrame(){},requestAnimFrame(fn){ return w.setTimeout(fn,16); } },
    DomUtil:{setTransform(){}},
    maplibreGL(config){
      const container=w.document.createElement('div');
      const gl={...evented(),loaded:()=>true,areTilesLoaded:()=>true,triggerRepaint(){},
        getStyle:()=>({sources:{osm:{type:'vector'}},layers:[{id:'land',type:'fill'}]}),
        setLayoutProperty(){},setPaintProperty(){} };
      const layer={config,gl,container,getContainer:()=>container,getMaplibreMap:()=>gl,
        addTo(){layers.add(this);return this;},onRemove(){container.remove();}};
      vectors.push(layer);return layer;
    },
    tileLayer(url,options){
      const layer={...evented(),url,options,addTo(){layers.add(this);return this;},setOpacity(value){this.options.opacity=value;},isLoading:()=>false};
      rasters.push(layer);return layer;
    }
  };
  if(!missingSDK)w.maplibregl={};
  w.eval(fs.readFileSync(path.join(__dirname,'../webgis/basemaps.js'),'utf8'));
  const active=[],notices=[],progress=[];
  const manager=new w.GeoAIBasemaps({map,L:w.L,styles:{light:{vector:'positron'},dark:{vector:'dark'}},
    streetAttribution:'OpenFreeMap · OpenMapTiles · OpenStreetMap',fallback:{url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',options:{attribution:'OpenStreetMap'}},
    timeoutMs:40,notice:value=>notices.push(value),onActive:value=>active.push(value),onProgress:value=>progress.push(value)});
  const coord=()=>{const z=15,n=2**z;return {z,x:Math.floor((viewport.lon+180)/360*n),y:Math.floor((1-Math.asinh(Math.tan(viewport.lat*Math.PI/180))/Math.PI)/2*n)};};
  const ready=vector=>vector.gl.fire('style.load').fire('load').fire('sourcedata',{sourceId:'osm',sourceDataType:'content',coord:{canonical:coord()}}).fire('idle');
  const rasterReady=raster=>raster.fire('tileload',{coords:coord()}).fire('load');
  t.after(()=>{manager.destroy();dom.window.close();});
  return {manager,vectors,rasters,ready,rasterReady,advance,active,notices,progress,map,viewport,layers,attributions};
}

test('preloads only light and dark styles and keeps the ready map visible while the other style loads',async t=>{
  const app=setup(t),startup=app.manager.start('light');
  assert.equal(app.vectors.length,2);assert.equal(app.rasters.length,0);
  assert.equal(app.progress.at(-1).total,2);
  const light=app.vectors[0],dark=app.vectors[1];app.ready(light);
  assert.equal(app.manager.current.vector,light);
  const changing=app.manager.select('dark');
  assert.equal(light.container.style.opacity,'1');assert.equal(dark.container.style.opacity,'0');
  app.ready(dark);await changing;await startup;
  assert.equal(light.container.style.opacity,'0');assert.equal(dark.container.style.opacity,'1');
  await app.manager.select('light');
  assert.equal(app.vectors.length,2);assert.equal(app.manager.current.vector,light);
  assert.equal(app.attributions.size,1);
});

test('panning marks cached styles unready for their new viewport and preserves the old visible map',async t=>{
  const app=setup(t);app.manager.start();app.vectors.forEach(app.ready);
  app.map.fire('movestart');app.viewport.lat=19.08;app.viewport.lon=72.88;app.map.fire('moveend');
  const changing=app.manager.select('dark');
  assert.equal(app.manager.current.key,'light');
  app.vectors[1].gl.fire('idle');
  assert.equal(app.manager.current.key,'light','old Bengaluru tiles do not prove the new viewport is loaded');
  app.ready(app.vectors[1]);await changing;
  assert.equal(app.manager.current.key,'dark');
});

test('bounded vector failure falls back to attributed OSM and late vector events cannot replace it',async t=>{
  const app=setup(t),startup=app.manager.start('dark');app.advance(40);
  assert.equal(app.rasters.length,1);assert.match(app.rasters[0].url,/tile.openstreetmap.org/);
  app.rasterReady(app.rasters[0]);await startup;
  assert.equal(app.manager.current.fallback,true);assert.equal(app.manager.current.raster,app.rasters[0]);
  app.vectors.forEach(app.ready);
  assert.equal(app.manager.current.fallback,true);
  assert.equal([...app.attributions][0],'OpenStreetMap');
});

test('missing WebGL SDK reaches OSM without waiting for a vector timeout; total offline also settles',async t=>{
  const app=setup(t,true),startup=app.manager.start();
  assert.equal(app.rasters.length,1);
  app.advance(8000);await startup;
  assert.equal(app.manager.current,null);
  assert.ok(app.notices.some(n=>/could not load/.test(n)));
});
