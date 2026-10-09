// Disposable synthetic local keyring. No network, no user keyring or existing wallet.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {toBase64} from '@cosmjs/encoding';
import {TxRaw} from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import {InferencedAdapter} from '../../dist/src/adapters/inferenced.js';
import {txJson,wire,verifySigned} from '../../dist/src/transactions.js';
import {same} from '../../dist/src/chain.js';
import {ROUTE,CLAIM} from '../../dist/src/native.js';
const cli=process.argv[2],parent=resolve('.forward'),home=mkdtempSync(join(parent,'synthetic-signing-'));
if(relative(parent,home).startsWith('..'))throw Error('Keyring outside test root');
try{
  const created=spawnSync(cli,['keys','add','tools-fixture','--home',home,'--keyring-backend','file','--output','json'],{stdio:['inherit','pipe','inherit'],encoding:'utf8'});
  if(created.status!==0)throw Error('Cannot create disposable fixture key');
  // CLI key creation includes a mnemonic; consume only the address in memory and never log its output.
  const owner=JSON.parse(created.stdout).address;
  const key=spawnSync(cli,['keys','show','tools-fixture','--pubkey','--home',home,'--keyring-backend','file'],{stdio:['inherit','pipe','inherit'],encoding:'utf8'});
  if(key.status!==0)throw Error('Cannot read public fixture key');const pub=JSON.parse(key.stdout).key;
  const d=JSON.parse(readFileSync('deployments/mainnet-v1.json','utf8'));d.chainId='synthetic-signing-chain';
  const op={schema:'gonka24/forward-operation/1',deployment:d,sender:owner,action:'lock',input:{},messages:[{typeUrl:'/cosmwasm.wasm.v1.MsgExecuteContract',value:{sender:owner,contract:d.factory,msg:{lock:{}},funds:[]}}],terms:{},checkedAt:'synthetic',checkedHeight:'1'};
  const u={schema:'gonka24/forward-unsigned/1',operation:op,publicKey:pub,accountNumber:'1',sequence:'0',gas:'1000000',fee:'1000000'};u.tx=txJson(op,u.sequence,pub,u.gas,u.fee);
  const messages=[op.messages[0],{typeUrl:ROUTE,value:{creator:owner,entries:[{epoch:'11',recipient:d.factory}]}},{typeUrl:CLAIM,value:{creator:owner,seed:'7',epoch_index:'11'}}];
  for(let index=0;index<messages.length;index++){
    u.operation.messages=[messages[index]];u.tx=txJson(u.operation,u.sequence,pub,u.gas,u.fee);
    const input=join(home,`unsigned-${index}.json`),output=join(home,`signed-${index}.json`);writeFileSync(input,JSON.stringify(u.tx));
    const adapter=new InferencedAdapter(cli,'tools-fixture',home,'file');await adapter.sign(u,{unsignedTx:input,signedTx:output});
    const signed=JSON.parse(readFileSync(output,'utf8'));
    if(!same(signed.body,u.tx.body)||!same(signed.auth_info,u.tx.auth_info))throw Error('CLI changed transaction fields');
    const raw=wire(u);raw.signatures=signed.signatures.map(s=>Buffer.from(s,'base64'));await verifySigned(u,toBase64(TxRaw.encode(raw).finish()));
  }
  console.log(JSON.stringify({status:'PASSED',adapter:'inferenced',backend:'file',network:false,syntheticKeyOnly:true,typeUrls:messages.map(m=>m.typeUrl)}));
}finally{rmSync(home,{recursive:true,force:true});}
