// Local validation only. Connects to disposable Testermint nodes, never mainnet.
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
createServer(async(req,res)=>{try{const {ip}=JSON.parse(readFileSync('/tools/.forward/local-live/proxy.json','utf8'));let p=req.url;const api=p.startsWith('/chain-api');p=p.replace(api?'/chain-api':'/chain-rpc','');let body='';for await(const c of req)body+=c;
  const r=await fetch(`http://${ip}:${api?1317:26657}${p}`,{method:req.method,headers:body?{'content-type':'application/json'}:undefined,body:body||undefined,signal:AbortSignal.timeout(30000)});const text=await r.text();if(p.includes('/participant/')||p.includes('/hardware_nodes/'))writeFileSync('/tools/.forward/local-live/participant-observation.local.json',text);res.writeHead(r.status,{'content-type':'application/json'});res.end(text);
}catch(e){res.writeHead(502);res.end(JSON.stringify({error:String(e)}));}}).listen(17843,'127.0.0.1');
