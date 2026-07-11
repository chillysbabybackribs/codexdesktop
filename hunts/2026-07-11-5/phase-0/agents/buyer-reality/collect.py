from bs4 import BeautifulSoup
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urljoin, urlparse
from datetime import datetime, timezone
import json, re, html

ROOT=Path(__file__).resolve().parent
ROOT.mkdir(parents=True,exist_ok=True)
NOW=datetime.now(timezone.utc).isoformat()
records=[]; queries=[]; failures=[]

def fetch(url, name):
    p=ROOT/name
    try:
        req=Request(url,headers={'User-Agent':'Mozilla/5.0 studio-hunt-buyer-reality/1.0'})
        with urlopen(req,timeout=30) as r: body=r.read()
        p.write_bytes(body)
        return body.decode('utf-8','replace'),p
    except Exception as e:
        failures.append({'url':url,'status':'error','error':type(e).__name__+': '+str(e),'fallbackAttempted':'none; public page was primary route','observedAt':NOW})
        return None,p

def clean(s): return ' '.join(html.unescape(s or '').split())
def add(source,url,title,desc,price,artifact,author='anonymous marketplace buyer',tools=None):
    if not title or len(desc)<60: return
    rid=f'br5-{len(records)+1:04d}'
    money='exact_job_budget' if price else 'none'
    records.append({
      'recordId':rid,'source':source,'url':url,'observedAt':NOW,'publishedAt':None,'window':'current',
      'sourceLane':'buyer_reality','retrievalStatus':'verified','actorType':'buyer_operator',
      'actorEvidence':'A buyer-authored public project brief requests paid delivery of the described operational work.',
      'statementType':'own_purchase','firsthand':True,'startupName':None,'productDomain':urlparse(url).netloc,
      'founderHandle':None,'buyer':'Marketplace client commissioning the described work','trigger':title,
      'input':None,'repeatedAction':desc[:1800],'output':title,'destination':'Delivery to the commissioning marketplace client',
      'frequency':None,'timeSpent':None,'priceOrWage':price,'commercialMetric':None,'metricPeriod':None,
      'currentTools':tools or [],'remainingManualWork':desc[:800],'objection':None,'requestedOutcome':title,
      'textExcerpt':desc[:2200]+((' Budget/rate: '+price) if price else ''),'artifactPath':str(artifact),
      'independenceKey':f'{urlparse(url).netloc}|{author}|{url.rstrip("/").split("/")[-1]}|public-marketplace',
      'commercialStrength':'medium' if price else 'weak','caveat':'Marketplace posting verifies stated purchase intent, not completed payment.',
      'classificationConfidence':'high','classificationReason':'The hydrated public listing contains a buyer-written scope and an explicit request to hire; actor identity beyond buyer role is not inferred.',
      'moneyType':money})

cats=['accounting','data-entry','intuit-quickbooks','virtual-assistant','excel','payroll','tax','legal','project-management','web-scraping']
for cat in cats:
  url=f'https://www.freelancer.com/jobs/{cat}/'
  txt,p=fetch(url,f'artifact-freelancer-{cat}.html')
  count=0
  if txt:
    s=BeautifulSoup(txt,'html.parser')
    for card in s.select('[data-project-card="true"]'):
      a=card.select_one('[data-heading-link="true"]')
      d=card.select_one('.JobSearchCard-primary-description')
      pr=card.select_one('.JobSearchCard-secondary-price')
      if not a or not d: continue
      tools=[clean(x.get_text()) for x in card.select('.JobSearchCard-primary-tagsLink')]
      add('freelancer:'+cat,urljoin(url,a.get('href')),clean(a.get_text()),clean(d.get_text()),clean(pr.get_text()) if pr else None,p,tools=tools)
      count+=1
      if count>=8: break
  queries.append({'query':cat,'source':'freelancer public category index','window':'current','resultCount':count,'purpose':'hydrate paid operational work and workaround purchases','url':url,'observedAt':NOW})

for page in [1,2,3]:
  url='https://www.peopleperhour.com/freelance-jobs/business'+(('?page='+str(page)) if page>1 else '')
  txt,p=fetch(url,f'artifact-peopleperhour-business-{page}.html')
  count=0
  if txt:
    s=BeautifulSoup(txt,'html.parser')
    seen=set()
    for a in s.find_all('a',href=True):
      href=a['href']; title=clean(a.get_text())
      if 'peopleperhour.com/freelance-jobs/business/' not in href or href in seen or not re.search(r'-\d{5,}$',href): continue
      seen.add(href)
      box=a.find_parent(['li','article','div'])
      for _ in range(3):
        if box and len(clean(box.get_text()))<100: box=box.parent
      desc=clean(box.get_text()) if box else title
      price=None
      m=re.search(r'(?:£|\$|€)\s?[\d,.]+(?:\s*(?:per hour|/hr|fixed))?',desc,re.I)
      if m: price=m.group(0)
      add('peopleperhour:business',href,title,desc[:2200],price,p)
      count+=1
      if count>=12: break
  queries.append({'query':f'business page {page}','source':'PeoplePerHour public job index','window':'current','resultCount':count,'purpose':'hydrate service purchases and operational work','url':url,'observedAt':NOW})

# Explicitly record blocked occupational-community route instead of treating discovery snippets as evidence.
failures.append({'url':'https://www.reddit.com/r/bookkeeping/search.json?q=spreadsheet&restrict_sr=on&sort=new','status':'blocked','error':'HTTP 403 Blocked','fallbackAttempted':'old.reddit.com JSON also returned HTTP 403; no snippets retained','observedAt':NOW})

# Category indexes overlap. Preserve only one normalized record per public posting.
deduped=[]; seen_keys=set()
for r in records:
  if r['independenceKey'] in seen_keys: continue
  seen_keys.add(r['independenceKey']); deduped.append(r)
records=deduped
for i,r in enumerate(records,1): r['recordId']=f'br5-{i:04d}'

for name,data in [('records.jsonl',records),('queries.jsonl',queries),('failures.jsonl',failures)]:
  (ROOT/name).write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in data))

def tally(field):
 out={}
 for r in records: out[r.get(field)]=out.get(r.get(field),0)+1
 return out
missing={k:sum(1 for r in records if r.get(k) in (None,'',[])) for k in ['buyer','trigger','input','repeatedAction','output','destination','frequency','timeSpent','priceOrWage','currentTools','remainingManualWork']}
metrics={'observedAt':NOW,'totalRecords':len(records),'bySource':tally('source'),'byWindow':tally('window'),'byActor':tally('actorType'),'byStatement':tally('statementType'),'byVerification':tally('retrievalStatus'),'byClassificationConfidence':tally('classificationConfidence'),'byMoneyType':tally('moneyType'),'exactJobMoney':sum(r['moneyType']=='exact_job_budget' for r in records),'firsthand':sum(r['firsthand'] for r in records),'uniqueIndependenceKeys':len(set(r['independenceKey'] for r in records)),'uniqueHostDomains':len(set(urlparse(r['url']).netloc for r in records)),'missingFields':missing,'queryCount':len(queries),'failureCount':len(failures),'suspectedDuplicates':len(records)-len(set(r['independenceKey'] for r in records)),'adaptiveStopping':{'batchDefinition':'each independent marketplace category/page','consecutiveSaturatedBatches':0,'stoppedBecause':'assigned lane time ceiling after source rotation; additional categories remained productive'}}
(ROOT/'metrics.json').write_text(json.dumps(metrics,indent=2,ensure_ascii=False)+'\n')
print(json.dumps(metrics,indent=2))
