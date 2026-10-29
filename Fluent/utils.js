"use strict";export function getStackTrace(e=2){const r=new Error().stack;return r?r.split(`
`).slice(e).filter(s=>!s.includes("node:internal")).join(`
`):""}export function countInputs(e,r,s){let u=0;for(let t=0;t<e.length-1;t++)e[t]==="-i"&&u++;const n=s.filter(t=>t.type==="url").length;return{streams:r.length,stringInputs:u,urlInputs:n,total:u+r.length+n}}export function summarizeInputs(e,r,s,u){const n={stringInputs:[],urlInputs:[],pipeStreams:[],complexFilters:[...s]};for(let t=0;t<e.length-1;t++)if(e[t]==="-i"){const i=e[t+1];/^pipe:\d+$/.test(i)?n.pipeStreams.push(i):n.stringInputs.push(i)}for(const t of u)t.type==="url"&&n.urlInputs.push(t.url);return n}
//# sourceMappingURL=utils.js.map
