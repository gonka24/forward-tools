"""Local Gonka validation only; delegates scheduling and oracles to pinned E2E.

Tools replaces successful participant operations. Product sources and the E2E
runner checkout stay unchanged. Synthetic local keys never leave node keyrings.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from decimal import Decimal
import urllib.request

sys.path.insert(0, '/app/scripts')
spec = importlib.util.spec_from_file_location('tools_upstream', '/app/scripts/acceptance_harness.py')
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
m.HARNESS_SCRIPT_PATH = Path(__file__).resolve()
release_check=m.verified_release_artifacts
def verify_release(*args,**kwargs):
    saved=m.HARNESS_SCRIPT_PATH
    try:
        m.HARNESS_SCRIPT_PATH=Path('/app/scripts/acceptance_harness.py')
        return release_check(*args,**kwargs)
    finally:m.HARNESS_SCRIPT_PATH=saved
m.verified_release_artifacts=verify_release
original = m.DockerGonka.tx
ROOT = Path('/tools')
OUT = Path(os.environ.get('TOOLS_LIVE_OUTPUT', '/tools/.forward/local-live'))
OUT.mkdir(parents=True, exist_ok=True)
NODE=os.environ.get('TOOLS_NODE','/tools/.forward/node24/bin/node')
if '--run-id' in sys.argv:
    os.environ['TOOLS_LIVE_RUN_ID']=sys.argv[sys.argv.index('--run-id')+1]

def checked(cmd, *, input_text=None):
    result = subprocess.run(cmd, input=input_text, text=True, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError('Tools integration failed: ' + result.stderr[-3000:] + result.stdout[-1000:])
    return result.stdout

def cli(*args, out=None):
    command = [NODE, str(ROOT/'dist/src/cli.js'), *args, '--deployment-file', str(OUT/'deployment.local.json')]
    if out: command += ['--out', str(out)]
    return json.loads(checked(command))

def tool_tx(self, container, key, *args, gas):
    action=None; inputs={}; factory=None; deal=None
    if args[:2] == ('wasm','execute'):
        contract, message=args[2],json.loads(args[3]); name=next(iter(message)); value=message[name]
        if name=='create_offer':
            action='create-offer';factory=contract
            inputs={'epoch':str(value['target_epoch']),'price':str(Decimal(value['price_micro_usdt_per_gnk'])/Decimal(1000000)),'budget':str(Decimal(value['buyer_budget_micro_usdt'])/Decimal(1000000))}
        elif name=='send' and value.get('msg')=='eyJmdW5kIjp7fX0=': action='fund';deal=value['contract']
        else:
            action={'lock':'lock','settle_claim':'settle','withdraw_usdt':'withdraw','release_unlocked_gnk':'release','refund':'refund','cancel':'cancel','forward_excess_gnk':'forward-excess'}.get(name)
            deal=contract
            if name=='withdraw_usdt':inputs['role']=value['role']
    elif args[:2] == ('inference','set-claim-recipients'):
        entries=json.loads(args[2]);
        if len(entries)==1 and entries[0].get('recipient'):action='route';deal=entries[0]['recipient']
    elif args[:2] == ('inference','claim-rewards'):
        # Locate this host/epoch in the most recently used Factory.
        if (OUT/'deployment.local.json').exists():
            d=json.loads((OUT/'deployment.local.json').read_text());host=self.key_address(container,key)
            deal=self.smart(d['factory'],{'deal_by_host_epoch':{'host':host,'epoch':int(args[3])}})['address']
            action='claim';inputs['seed']=args[2]
    if action is None: return original(self,container,key,*args,gas=gas)
    if deal: factory=self.smart(deal,{'config':{}})['factory'];inputs['deal']=deal
    config=self.smart(factory,{'config':{}})
    info=self.query_json('wasm','contract',factory);info=info.get('contract_info',info)
    node_ip=json.loads(checked(['docker','inspect','genesis-node']))[0]['NetworkSettings']['Networks'];ip=next(iter(node_ip.values()))['IPAddress']
    # Local reverse proxy provides the same /chain-api and /chain-rpc layout as mainnet.
    proxy=OUT/'proxy.json';proxy.write_text(json.dumps({'ip':ip}))
    d=json.loads((ROOT/'deployments/mainnet-v1.json').read_text());d.update(id='local-validation',chainId=self.chain_id,nodes=['http://127.0.0.1:17843'],factory=factory,factoryCodeId=int(info['code_id']),dealCodeId=int(config['deal_code_id']),token=config['settlement_cw20'],feeRecipient=config['fee_recipient'])
    (OUT/'deployment.local.json').write_text(json.dumps(d))
    prefix=OUT/f'{time.time_ns()}-{action}';op=Path(str(prefix)+'-op.local.json');u=Path(str(prefix)+'-unsigned.local.json');s=Path(str(prefix)+'-signed.local.json');r=Path(str(prefix)+'-receipt.local.json')
    command=['deal','prepare','--action',action,'--sender',self.key_address(container,key)]
    for k,v in inputs.items():command+=['--'+k,str(v)]
    cli(*command,out=op)
    backend,password=self.keyring(container)
    public=checked(['docker','exec','-i',container,'inferenced','keys','show',key,'--pubkey','--keyring-backend',backend,'--keyring-dir','/root/.inference'],input_text=password)
    pubkey=json.loads(public)['key']
    # The pinned runtime panics only in claim simulation (empty HeaderInfo.Hash).
    # This disposable fixture explicitly budgets gas; real owners must review it.
    claim_gas=['--claim-gas','1000000'] if action=='claim' else []
    cli('tx','export','--operation',str(op),'--public-key',pubkey,*claim_gas,out=u)
    unsigned=json.loads(u.read_text());txfile=Path(str(prefix)+'-cosmos.local.json');txfile.write_text(json.dumps(unsigned['tx']))
    remote='/tmp/tools-unsigned.json';signed_remote='/tmp/tools-signed.json'
    checked(['docker','cp',str(txfile),container+':'+remote]);backend,password=self.keyring(container)
    checked(['docker','exec','-i',container,'inferenced','tx','sign',remote,'--overwrite','--from',key,'--keyring-dir','/root/.inference','--keyring-backend',backend,'--chain-id',self.chain_id,'--offline','--account-number',unsigned['accountNumber'],'--sequence',unsigned['sequence'],'--sign-mode','direct','--output-document',signed_remote],input_text=password)
    external=Path(str(prefix)+'-external.local.json');checked(['docker','cp',container+':'+signed_remote,str(external)])
    cli('tx','import','--unsigned',str(u),'--signed-tx',str(external),out=s)
    # pseudo-terminal exercises the actual owner-confirmation CLI on this isolated test chain.
    import shlex
    cmd=[NODE,str(ROOT/'dist/src/cli.js'),'tx','broadcast','--signed',str(s),'--receipt',str(r),'--confirm','--deployment-file',str(OUT/'deployment.local.json')]
    checked(['script','-q','-e','-c',shlex.join(cmd),'/dev/null'],input_text='CONFIRM\n')
    result=cli('tx','confirm','--receipt',str(r),out=Path(str(prefix)+'-result.local.json'))
    if result['status']!='INCLUDED' or result['postcondition']['status']!='RESULT_VERIFIED':raise RuntimeError('Tools local transaction not verified')
    tools_commit=checked(['git','-c','safe.directory=/tools','-C','/tools','rev-parse','HEAD']).strip()
    with (OUT/'operations.jsonl').open('a') as f:f.write(json.dumps({'runId':os.environ.get('E2E_RUN_ID',os.environ.get('TOOLS_LIVE_RUN_ID','unclassified-local-run')),'toolsCommit':tools_commit,'action':action,'txHash':result['txHash'],'height':result['height'],'postcondition':result['postcondition']['status']})+'\n')
    return self.wait_tx(result['txHash'])

m.DockerGonka.tx=tool_tx
if __name__=='__main__':raise SystemExit(m.main())
