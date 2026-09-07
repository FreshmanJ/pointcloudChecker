import { readFileSync } from 'node:fs';
const src = readFileSync('src/i18n/index.ts','utf8');
// crude: split on `const zh: Dict = {` / `const en: Dict = {`
function grab(marker){
  const i = src.indexOf(marker);
  if(i<0) throw new Error('marker '+marker);
  let depth=0, start=src.indexOf('{', i), j=start;
  for(;j<src.length;j++){ const c=src[j]; if(c==='{')depth++; else if(c==='}'){depth--; if(depth===0)break;} }
  return src.slice(start+1,j);
}
const parse = (body) => {
  const keys = new Map();
  const re = /'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  let m; while((m=re.exec(body))) keys.set(m[1], (m[2]??m[3]??''));
  return keys;
};
const zh = parse(grab('const zh: Dict = {'));
const en = parse(grab('const en: Dict = {'));
console.log('zh',zh.size,'en',en.size);
const onlyZh=[...zh.keys()].filter(k=>!en.has(k));
const onlyEn=[...en.keys()].filter(k=>!zh.has(k));
console.log('only zh:',onlyZh);
console.log('only en:',onlyEn);
// placeholder parity
const ph = (s)=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort().join(',');
for(const [k,v] of zh){ if(en.has(k) && ph(v)!==ph(en.get(k))) console.log('placeholder mismatch', k, ph(v), ph(en.get(k))); }
