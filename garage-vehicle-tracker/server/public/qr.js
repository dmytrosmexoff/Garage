/* qr.js: компактный генератор QR-кода (байтовый режим, коррекция M, версии 1-9, до ~180 байт) */
(function(g){
const EXP=new Array(512),LOG=new Array(256);
let x=1;for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&256)x^=0x11d}
for(let i=255;i<512;i++)EXP[i]=EXP[i-255];
const mul=(a,b)=>a&&b?EXP[LOG[a]+LOG[b]]:0;
function rsGen(n){let q=[1];for(let i=0;i<n;i++){const r=new Array(q.length+1).fill(0);for(let j=0;j<q.length;j++){r[j]^=q[j];r[j+1]^=mul(q[j],EXP[i])}q=r}return q}
function rsEnc(data,n){const q=rsGen(n),res=new Array(n).fill(0);for(const d of data){const f=d^res[0];res.shift();res.push(0);if(f)for(let i=0;i<n;i++)res[i]^=mul(q[i+1],f)}return res}
const VER={1:{ec:10,b:[[1,16]],al:[]},2:{ec:16,b:[[1,28]],al:[6,18]},3:{ec:26,b:[[1,44]],al:[6,22]},4:{ec:18,b:[[2,32]],al:[6,26]},5:{ec:24,b:[[2,43]],al:[6,30]},6:{ec:16,b:[[4,27]],al:[6,34]},7:{ec:18,b:[[4,31]],al:[6,22,38]},8:{ec:22,b:[[2,38],[2,39]],al:[6,24,42]},9:{ec:22,b:[[3,36],[2,37]],al:[6,26,46]}};
const cap=v=>VER[v].b.reduce((a,[n,d])=>a+n*d,0);
function matrix(text){
  const bytes=[...unescape(encodeURIComponent(text))].map(c=>c.charCodeAt(0));
  let ver=0;for(let v=1;v<=9;v++)if(bytes.length+2<=cap(v)){ver=v;break}
  if(!ver)throw new Error('QR: text too long');
  const bits=[];const put=(val,len)=>{for(let i=len-1;i>=0;i--)bits.push((val>>i)&1)};
  put(4,4);put(bytes.length,8);bytes.forEach(b=>put(b,8));
  const total=cap(ver)*8;put(0,Math.min(4,total-bits.length));while(bits.length%8)bits.push(0);
  const cw=[];for(let i=0;i<bits.length;i+=8){let b=0;for(let j=0;j<8;j++)b=b<<1|bits[i+j];cw.push(b)}
  for(let p=0xEC;cw.length<cap(ver);p^=0xEC^0x11)cw.push(p);
  const V=VER[ver],blocks=[];let o=0;
  V.b.forEach(([n,d])=>{for(let i=0;i<n;i++){const data=cw.slice(o,o+d);o+=d;blocks.push({data,ec:rsEnc(data,V.ec)})}});
  const out=[];const maxD=Math.max(...blocks.map(b=>b.data.length));
  for(let i=0;i<maxD;i++)blocks.forEach(b=>{if(i<b.data.length)out.push(b.data[i])});
  for(let i=0;i<V.ec;i++)blocks.forEach(b=>out.push(b.ec[i]));
  const size=17+4*ver,m=[],fn=[];
  for(let i=0;i<size;i++){m.push(new Array(size).fill(false));fn.push(new Array(size).fill(false))}
  const set=(x,y,v)=>{m[y][x]=v;fn[y][x]=true};
  for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0)}
  const finder=(cx,cy)=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const d=Math.max(Math.abs(dx),Math.abs(dy)),xx=cx+dx,yy=cy+dy;if(xx>=0&&xx<size&&yy>=0&&yy<size)set(xx,yy,d!==2&&d!==4)}};
  finder(3,3);finder(size-4,3);finder(3,size-4);
  const al=V.al;
  al.forEach((cy,i)=>al.forEach((cx,j)=>{
    if((i===0&&j===0)||(i===0&&j===al.length-1)||(i===al.length-1&&j===0))return;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(cx+dx,cy+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
  }));
  const fmt=mask=>{
    const data=mask;let r=data<<10;
    for(let i=14;i>=10;i--)if((r>>i)&1)r^=0x537<<(i-10);
    const b=((data<<10)|r)^0x5412,bit=i=>((b>>i)&1)===1;
    for(let i=0;i<=5;i++)set(8,i,bit(i));set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));
    for(let i=9;i<15;i++)set(14-i,8,bit(i));
    for(let i=0;i<8;i++)set(size-1-i,8,bit(i));
    for(let i=8;i<15;i++)set(8,size-15+i,bit(i));
    set(8,size-8,true);
  };
  fmt(0);
  if(ver>=7){
    let r=ver;for(let i=0;i<12;i++)r=(r<<1)^((r>>11)*0x1F25);
    const b=(ver<<12)|r;
    for(let i=0;i<18;i++){const bit=((b>>i)&1)===1,a=size-11+i%3,c=Math.floor(i/3);set(a,c,bit);set(c,a,bit)}
  }
  let k=0;
  for(let right=size-1;right>=1;right-=2){
    if(right===6)right=5;
    for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){
      const xx=right-j,up=((right+1)&2)===0,yy=up?size-1-vert:vert;
      if(!fn[yy][xx]&&k<out.length*8){m[yy][xx]=((out[k>>3]>>(7-(k&7)))&1)===1;k++}
    }
  }
  const conds=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,(x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];
  const penalty=mm=>{
    let p=0;
    for(let t=0;t<2;t++){
      for(let a=0;a<size;a++){
        let run=1,prev=t?mm[0][a]:mm[a][0];
        const line=[prev];
        for(let b=1;b<size;b++){const c=t?mm[b][a]:mm[a][b];line.push(c);if(c===prev)run++;else{if(run>=5)p+=3+run-5;run=1;prev=c}}
        if(run>=5)p+=3+run-5;
        for(let b=0;b+11<=size;b++){
          const s=line.slice(b,b+11).map(v=>v?1:0).join('');
          if(s==='10111010000'||s==='00001011101')p+=40;
        }
      }
    }
    for(let y=0;y<size-1;y++)for(let xx=0;xx<size-1;xx++){const c=mm[y][xx];if(c===mm[y][xx+1]&&c===mm[y+1][xx]&&c===mm[y+1][xx+1])p+=3}
    let dark=0;mm.forEach(r=>r.forEach(v=>{if(v)dark++}));
    p+=10*Math.floor(Math.abs(dark*20-size*size*10)/(size*size));
    return p;
  };
  let best=null,bp=1e9,bm=0;
  for(let mask=0;mask<8;mask++){
    const mm=m.map(r=>r.slice());
    for(let y=0;y<size;y++)for(let xx=0;xx<size;xx++)if(!fn[y][xx]&&conds[mask](xx,y))mm[y][xx]=!mm[y][xx];
    const keep=m.map(r=>r.slice());
    // записать формат этой маски в копию
    for(let y=0;y<size;y++)for(let xx=0;xx<size;xx++)m[y][xx]=mm[y][xx];
    fmt(mask);
    const res=m.map(r=>r.slice()),pen=penalty(res);
    for(let y=0;y<size;y++)for(let xx=0;xx<size;xx++)m[y][xx]=keep[y][xx];
    if(pen<bp){bp=pen;best=res;bm=mask}
  }
  return best;
}
function svg(text,px){
  const m=matrix(text),n=m.length,q=4;let d='';
  for(let y=0;y<n;y++){let x=0;while(x<n){if(m[y][x]){let e=x;while(e<n&&m[y][e])e++;d+=`M${x+q} ${y+q}h${e-x}v1h-${e-x}z`;x=e}else x++}}
  const s=n+q*2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const api={matrix,svg};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
g.QR=api;
})(typeof window!=='undefined'?window:globalThis);
