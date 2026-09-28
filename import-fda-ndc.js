#!/usr/bin/env node
'use strict';
/* ============================================================================
   SEON · scripts/import-fda-ndc.js
   fda_ndc_vet_dictionary 테이블에 실제 openFDA 데이터를 배치로 안전하게 적재해요.
   ----------------------------------------------------------------------------
   ⚠️ 먼저 읽어주세요 — openFDA에 "수의용 NDC" 데이터가 있는 위치에 대한 중요한 사실

   가장 널리 알려진 openFDA 엔드포인트인 `/drug/ndc.json`(고전적인 "NDC Directory")은
   FDA가 공식 문서에서 명시적으로 밝히듯 **동물용 의약품을 포함하지 않아요**:
     "The NDC Directory does not contain all listed drugs. It does not include animal drugs..."
     (https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory)
   그래서 `--source openfda-ndc-directory`로 이 엔드포인트를 그대로 돌리면, 수의용 필터를 아무리
   걸어도 0건만 나와요. 이 스크립트는 그 사실을 숨기지 않고, 기동 시 `count=product_type` 조회로
   실제로 동물용 타입이 하나도 없는지 직접 확인한 뒤, 없으면 명확히 설명하고 중단해요
   (`--allow-empty-veterinary-scope`로 그래도 계속 진행할 수는 있어요. 사람용 비교 데이터를
   같이 적재하고 싶을 때 등).

   실제로 동물용 제품이 존재하는 곳은 별도 엔드포인트인 `/other/nsde.json`(NSDE = NDC SPL Data
   Elements)이에요. 여기는 실제로 PRESCRIPTION ANIMAL DRUG · OTC ANIMAL DRUG 같은 product_type을
   포함해요(FDA 공식 문서의 집계 예시에서도 확인돼요: 6,234 / 4,848건 등).
   그래서 이 스크립트의 기본값은 `--source openfda-nsde`예요.

   다만 NSDE의 공식 데이터 요소는 "Item code(NDC/NHRIC/ISBT) · NDC11 · Proprietary Name ·
   Dosage Form · Marketing Category · Application Number · Product Type"뿐이고, **성분명
   (active ingredient)이나 CYP450/킬레이트 같은 대사 경로 정보는 원래 들어있지 않아요**
   (FDA가 그런 데이터를 공개 API로 내주지 않아요). 그래서 이 스크립트는 NSDE로 받은 "진짜 FDA
   제품 식별 정보(NDC·상표명·시판 상태)"를, 운영자가 --ingredients-map 로 제공하는 "성분/계열/대사
   경로 매핑"과 이어 붙이는 방식으로 동작해요. 기본 매핑 파일(scripts/vet-ingredient-allowlist.json)은
   서온 연산 엔진이 이미 인식하는 36개 성분에 대한 것이고, 그중 14개만 사업계획서 검토를 거쳤어요
   (파일 안의 reviewed 필드로 표시돼 있어요). 매핑에 없는 상표명은 기본적으로 건너뛰고
   (--include-unmapped 로 상표명만으로도 가져올 수 있어요), 그 경우 nonproprietary_name 은
   상표명으로 대체되고 notes 에 "NEEDS_INGREDIENT_REVIEW"가 남아요 — 검색엔 걸리지만, 서버의
   성분명 매칭에는 쓰이지 않는다는 뜻이에요.

   ----------------------------------------------------------------------------
   사용법
     node scripts/import-fda-ndc.js [--source openfda-nsde|openfda-ndc-directory|csv] [옵션]

   공통 옵션
     --dry-run                     DB에 쓰지 않고 무엇을 적재할지만 보여줘요 (항상 먼저 이걸로 확인해보세요)
     --limit <n>                   가져올 원본 레코드 수 상한 (테스트용)
     --batch-size <n>              업서트 배치 크기 (기본 250)
     --concurrency <n>              배치 동시 실행 수 (기본 3)
     --ingredients-map <path>       성분 매핑 JSON (기본 scripts/vet-ingredient-allowlist.json)
     --include-unmapped             매핑에 없는 상표명도 상표명 그대로 가져와요
     --api-key <key>                openFDA API 키 (있으면 요청 한도가 늘어나요)
     --timeout-ms <n>               요청당 타임아웃 (기본 20000)
     --max-retries <n>              429/5xx 재시도 횟수 (기본 5)
     --out <path>                   최종 리포트를 JSON 파일로도 저장해요

   --source openfda-nsde (기본)
     --product-types <a;b;c>        NSDE product_type 필터 (기본: 아래 8개 ANIMAL DRUG 타입 전부)
     --date-from / --date-to        marketing_start_date 범위 (YYYY-MM-DD) — 25,000건 skip 한도를
                                     넘는 대규모 적재를 날짜로 나눠 여러 번 실행할 때 써요

   --source openfda-ndc-directory
     --allow-empty-veterinary-scope 위 경고에도 불구하고 계속 진행해요(사람용 비교 데이터 등)
     --product-types                이 소스의 product_type 값(예: "HUMAN PRESCRIPTION DRUG")

   --source csv <path>
     --column-map <path>            CSV 컬럼 -> 우리 스키마 필드 매핑 JSON (예시는 아래 buildColumnMapExample 참고)
     --csv-delimiter <c>             기본 ','
     --csv-multivalue-delimiter <c>  한 셀에 여러 값이 든 컬럼(성분 등)의 구분자 — FDA 원본 파일마다
                                     다를 수 있어 확정하지 않고 옵션으로 받아요 (기본 ';')

   환경 변수 (server.js 와 동일한 것을 그대로 써요)
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — 필수 (service_role 키만 이 테이블에 쓸 수 있어요)

   실행 예시
     node scripts/import-fda-ndc.js --dry-run --limit 50
     node scripts/import-fda-ndc.js --date-from 2024-01-01 --date-to 2024-12-31
     node scripts/import-fda-ndc.js --source csv ./my-export.csv --column-map ./my-columns.json --dry-run
============================================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const OPENFDA_BASE = process.env.OPENFDA_BASE_URL || 'https://api.fda.gov'; // 테스트 시에만 재정의(운영 기본값은 그대로 api.fda.gov)
// NSDE 에 실제로 존재하는(=FDA 공식 집계 예시에 등장하는) 동물용 product_type 값들이에요.
const DEFAULT_VET_PRODUCT_TYPES = [
  'PRESCRIPTION ANIMAL DRUG', 'OTC ANIMAL DRUG', 'BULK INGREDIENT - ANIMAL DRUG', 'ANIMAL COMPOUNDED DRUG',
  'OTC TYPE A MEDICATED ARTICLE ANIMAL DRUG', 'OTC TYPE B MEDICATED FEED ANIMAL DRUG',
  'OTC TYPE C MEDICATED FEED ANIMAL DRUG', 'VFD TYPE A MEDICATED ARTICLE ANIMAL DRUG',
];
const NDC_FORMAT = /^([0-9]{4}-[0-9]{4}-[0-9]{2}|[0-9]{5}-[0-9]{3}-[0-9]{2}|[0-9]{5}-[0-9]{4}-[0-9]{1})$/;
const OUR_IMPORT_SOURCES = new Set(['openfda_nsde', 'openfda_ndc_directory', 'csv_import']); // 이 스크립트가 쓸 수 있는 source 값 (manual/demo_illustrative 행은 절대 덮어쓰지 않아요)

/* ---------------- CLI ---------------- */
function parseArgs(argv){
  const out = { _: [] };
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a === '--source'){ out.source = argv[++i]; continue; }
    if(a.startsWith('--')){
      const key = a.slice(2);
      const next = argv[i + 1];
      if(next === undefined || next.startsWith('--')){ out[key] = true; }
      else { out[key] = next; i++; }
      continue;
    }
    out._.push(a);
  }
  return out;
}
function usageAndExit(msg){
  if(msg) console.error('오류: ' + msg + '\n');
  console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 60).join('\n'));
  process.exit(msg ? 1 : 0);
}

/* ---------------- 공용 유틸 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function normKey(s){ // server.js 의 normKey 와 동일한 규칙(일관된 매칭을 위해)
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function assertNdcFormat(code){ return typeof code === 'string' && NDC_FORMAT.test(code); }

/* fetch + 재시도(429/5xx는 backoff, 그 외 4xx는 즉시 실패로 취급해 원인을 그대로 올려요) */
async function fetchJsonWithRetry(url, opts){
  opts = opts || {};
  const maxRetries = opts.maxRetries ?? 5;
  const timeoutMs = opts.timeoutMs ?? 20000;
  let lastErr;
  for(let attempt = 0; attempt <= maxRetries; attempt++){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try{
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const text = await res.text();
      let body = null;
      try{ body = text ? JSON.parse(text) : null; }catch(e){ /* 아래에서 처리 */ }
      if(res.status === 200) return { status: 200, body, headers: res.headers };
      const errMsg = (body && body.error && (body.error.message || body.error.code)) || text.slice(0, 200) || `HTTP ${res.status}`;
      if(res.status === 429 || res.status >= 500){
        lastErr = new Error(`openFDA ${res.status}: ${errMsg}`);
        const wait = Math.min(30000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 300);
        if(attempt < maxRetries){ console.warn(`  [재시도 ${attempt + 1}/${maxRetries}] ${lastErr.message} — ${wait}ms 후 재시도`); await sleep(wait); continue; }
        throw lastErr;
      }
      // 404 등은 "이 페이지에 결과 없음"으로 다루고, 그 외 4xx는 즉시 예외(원인을 그대로 보여줘요 — 조용히 건너뛰지 않아요)
      const e = new Error(`openFDA ${res.status}: ${errMsg}`);
      e.status = res.status; e.body = body;
      throw e;
    }catch(e){
      clearTimeout(timer);
      if(e.name === 'AbortError'){
        lastErr = new Error(`openFDA 요청 타임아웃(${timeoutMs}ms): ${url}`);
        if(attempt < maxRetries){ console.warn(`  [재시도 ${attempt + 1}/${maxRetries}] ${lastErr.message}`); continue; }
        throw lastErr;
      }
      throw e;
    }
  }
  throw lastErr;
}

/* ---------------- openFDA: NSDE (실제 동물용 NDC의 근거 소스) ---------------- */
function buildSearchQuery(field, values){
  const clause = values.map(v => `"${v.replace(/"/g, '')}"`).join(' OR ');
  return `${field}:(${clause})`;
}
function withDateRange(query, from, to){
  if(!from && !to) return query;
  const f = (from || '1900-01-01').replace(/-/g, ''), t = (to || '2999-12-31').replace(/-/g, '');
  return `${query}+AND+marketing_start_date:[${f}+TO+${t}]`;
}
/* skip(0..25000) 로 페이지를 넘기다가, 문서화된 한도(25,000)에 닿으면 Link 헤더의 search_after 커서로
   전환해요. 커서 전환이 서버에서 거부되면(예: sort 필드 문제) 원인을 그대로 보여주고 그 시점까지
   모은 결과로 멈춰요 — 조용히 데이터를 누락시키지 않아요. */
function parseNextLink(linkHeader){
  if(!linkHeader) return null;
  const m = linkHeader.split(',').map(s => s.trim()).find(s => /rel="?next"?/.test(s));
  if(!m) return null;
  const urlMatch = m.match(/<([^>]+)>/);
  return urlMatch ? urlMatch[1] : null;
}
async function fetchAllOpenFda(endpoint, query, opts){
  const limit = 1000;
  const results = [];
  const apiKeyQs = opts.apiKey ? `&api_key=${encodeURIComponent(opts.apiKey)}` : '';
  let skip = 0, cursorUrl = null, page = 0, total = null;
  console.log(`  검색어: ${query}`);
  for(;;){
    if(opts.limit && results.length >= opts.limit) break;
    const pageLimit = opts.limit ? Math.min(limit, opts.limit - results.length) : limit;
    const url = cursorUrl || `${OPENFDA_BASE}${endpoint}?search=${encodeURIComponent(query)}&limit=${pageLimit}&skip=${skip}${apiKeyQs}`;
    let res;
    try{
      res = await fetchJsonWithRetry(url, opts);
    }catch(e){
      if(e.status === 404 && page > 0) break; // 결과 끝(openFDA 는 결과 없음을 404로 표현해요)
      if(e.status === 404 && page === 0){ console.log('  (일치하는 레코드가 없어요)'); break; }
      if(e.status === 400 && cursorUrl){
        console.warn(`  ⚠️ search_after 커서 전환이 거부됐어요(${e.message}). 지금까지 모은 ${results.length}건으로 멈춰요.`);
        console.warn('     25,000건을 넘겨 더 가져오려면 --date-from/--date-to 로 기간을 나눠 여러 번 실행해주세요.');
        break;
      }
      throw e;
    }
    page++;
    const batch = (res.body && res.body.results) || [];
    total = (res.body && res.body.meta && res.body.meta.results && res.body.meta.results.total) ?? total;
    results.push(...batch);
    process.stdout.write(`\r  페이지 ${page}: 누적 ${results.length}${total != null ? ' / ' + total : ''}건 수신`);
    if(batch.length < pageLimit) break; // 마지막 페이지
    skip += batch.length;
    if(skip > 25000){
      const next = parseNextLink(res.headers.get('link'));
      if(!next){ console.warn('\n  ⚠️ skip 한도(25,000)에 도달했고 다음 페이지 커서가 없어요. 여기서 멈춰요.'); break; }
      cursorUrl = next; skip = 0; // 커서 모드에서는 skip 을 쓰지 않아요(0 유지)
    }
  }
  if(page) process.stdout.write('\n');
  return { results, total };
}
async function fetchNsde(opts){
  const types = opts.productTypes && opts.productTypes.length ? opts.productTypes : DEFAULT_VET_PRODUCT_TYPES;
  const query = withDateRange(buildSearchQuery('product_type', types), opts.dateFrom, opts.dateTo);
  const { results } = await fetchAllOpenFda('/other/nsde.json', query, opts);
  // NSDE 공식 데이터 요소: item_code/product_ndc(2세그먼트: 라벨러-제품), package_ndc[](3세그먼트:
  // 라벨러-제품-포장), proprietary_name, dosage_form, marketing_category, application_number_or_citation,
  // product_type, marketing_start_date, marketing_end_date.
  // (성분명·강도는 NSDE에 없어요 — 아래 ingredients-map 로 별도 연결해요.)
  // 우리 스키마의 ndc_code 는 포장 단위 3세그먼트 코드예요. product_ndc(2세그먼트)는 그대로 쓸 수 없어서,
  // 제품 하나에 딸린 package_ndc 각각을 별도 행으로 펼쳐요(한 제품이 여러 포장 크기를 가질 수 있어요).
  const rows = [];
  for(const r of results){
    const packages = Array.isArray(r.package_ndc) && r.package_ndc.length ? r.package_ndc : [];
    for(const pkgNdc of packages){
      rows.push({
        ndc_code: pkgNdc,
        proprietary_name: r.proprietary_name || null,
        product_type_raw: r.product_type || null,
        dosage_form: r.dosage_form || null,
        marketing_category: r.marketing_category || null,
        application_number: r.application_number_or_citation || null,
        is_discontinued: !!r.marketing_end_date,
        source_row: r,
      });
    }
  }
  return rows.filter(r => r.ndc_code);
}

/* ---------------- openFDA: 고전적인 NDC Directory (수의용 제외 사실을 실제로 확인) ---------------- */
async function verifyNdcDirectoryHasNoAnimalTypes(opts){
  const url = `${OPENFDA_BASE}/drug/ndc.json?count=product_type.exact${opts.apiKey ? '&api_key=' + encodeURIComponent(opts.apiKey) : ''}`;
  const res = await fetchJsonWithRetry(url, opts);
  const terms = ((res.body && res.body.results) || []).map(r => r.term);
  const animalTerms = terms.filter(t => /ANIMAL/i.test(t));
  return { terms, animalTerms };
}
async function fetchNdcDirectory(opts){
  const types = opts.productTypes && opts.productTypes.length ? opts.productTypes : ['HUMAN PRESCRIPTION DRUG', 'HUMAN OTC DRUG'];
  const query = withDateRange(buildSearchQuery('product_type', types), opts.dateFrom, opts.dateTo);
  const { results } = await fetchAllOpenFda('/drug/ndc.json', query, opts);
  return results.map(r => ({
    ndc_code: r.product_ndc,
    proprietary_name: r.brand_name || null,
    nonproprietary_name_raw: r.generic_name || null,
    active_ingredients_raw: Array.isArray(r.active_ingredients) ? r.active_ingredients : [],
    product_type_raw: r.product_type || null,
    dosage_form: r.dosage_form || null,
    route: Array.isArray(r.route) ? r.route.join('/') : (r.route || null),
    marketing_category: r.marketing_category || null,
    labeler: r.labeler_name || null,
    pharm_class: Array.isArray(r.pharm_class) ? r.pharm_class.join('; ') : null,
    is_discontinued: (r.packaging || []).length > 0 && (r.packaging || []).every(p => p.marketing_end_date),
    source_row: r,
  })).filter(r => r.ndc_code);
}

/* ---------------- CSV (공식 NDC Directory 다운로드를 CSV로 변환한 것, Green Book 내보내기, 벤더 데이터 등) ---------------- */
// 표준 라이브러리 없이 RFC4180 최소 파서(따옴표 안의 콤마/줄바꿈/이스케이프된 따옴표를 처리해요).
function parseCsv(text, delimiter){
  const rows = []; let field = '', row = [], inQuotes = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){ if(text[i + 1] === '"'){ field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    }else{
      if(c === '"') inQuotes = true;
      else if(c === delimiter){ row.push(field); field = ''; }
      else if(c === '\n' || c === '\r'){
        if(c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if(row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      }else field += c;
    }
  }
  if(field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function loadCsvRows(filePath, opts){
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(text, opts.csvDelimiter || ',');
  if(!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map(cols => Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ''])));
}
function buildColumnMapExample(){
  return {
    ndc_code: 'ProductNDC', proprietary_name: 'ProprietaryName', nonproprietary_name: 'SubstanceName',
    product_type: 'ProductTypeName', dosage_form: 'DosageFormName', route: 'RouteName',
    marketing_category: 'MarketingCategoryName', labeler: 'LabelerName',
    active_ingredients: { name_column: 'SubstanceName', strength_column: 'StrengthAndUnit' },
    is_discontinued_if_present: 'EndMarketingDate',
  };
}
function applyColumnMap(rows, map, opts){
  const mv = opts.csvMultivalueDelimiter || ';';
  const splitMv = v => (v || '').split(mv).map(s => s.trim()).filter(Boolean);
  return rows.map(row => {
    const get = col => (col && row[col] !== undefined) ? row[col] : null;
    const names = map.active_ingredients ? splitMv(get(map.active_ingredients.name_column)) : [];
    const strengths = map.active_ingredients ? splitMv(get(map.active_ingredients.strength_column)) : [];
    return {
      ndc_code: get(map.ndc_code),
      proprietary_name: get(map.proprietary_name),
      nonproprietary_name_raw: get(map.nonproprietary_name),
      active_ingredients_raw: names.map((n, i) => ({ name: n, strength: strengths[i] || null })),
      product_type_raw: get(map.product_type),
      dosage_form: get(map.dosage_form),
      route: get(map.route),
      marketing_category: get(map.marketing_category),
      labeler: get(map.labeler),
      is_discontinued: map.is_discontinued_if_present ? !!get(map.is_discontinued_if_present) : false,
      source_row: row,
    };
  }).filter(r => r.ndc_code);
}

/* ---------------- 성분 매핑 ---------------- */
function loadIngredientMap(filePath){
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const byKey = new Map(); // normKey(별칭 또는 성분명) -> 항목
  for(const [name, info] of Object.entries(raw)){
    if(name.startsWith('_')) continue; // _readme 등 메타 키는 건너뜀
    const entry = { nonproprietary_name: info.nonproprietary_name || name, drug_class: info.drug_class || null, metabolic_pathways: info.metabolic_pathways || {}, aliases: info.aliases || [], reviewed: !!info.reviewed };
    [name, ...entry.aliases].forEach(alias => byKey.set(normKey(alias), entry));
  }
  return byKey;
}
/* 상표명(브랜드명) 또는 성분 원문에서 매핑을 찾아요. NSDE는 성분명이 없으므로 상표명으로,
   NDC Directory/CSV 는 보통 성분명이 있으므로 성분명으로 먼저 찾아요. */
function resolveIngredient(candidate, ingredientMap){
  for(const raw of candidate.active_ingredients_raw || []){
    const hit = ingredientMap.get(normKey(raw.name));
    if(hit) return hit;
  }
  if(candidate.nonproprietary_name_raw){
    const hit = ingredientMap.get(normKey(candidate.nonproprietary_name_raw));
    if(hit) return hit;
  }
  if(candidate.proprietary_name){
    const hit = ingredientMap.get(normKey(candidate.proprietary_name));
    if(hit) return hit;
  }
  return null;
}

/* ---------------- 후보 -> 테이블 행 ---------------- */
function toTableRow(candidate, ingredientMap, opts){
  if(!assertNdcFormat(candidate.ndc_code)) return { skip: 'invalid_ndc_format', candidate };
  const match = resolveIngredient(candidate, ingredientMap);
  if(!match && !opts.includeUnmapped) return { skip: 'unmapped_ingredient', candidate };
  const productType = /ANIMAL/i.test(candidate.product_type_raw || '') ? 'VET'
    : /^HUMAN/i.test(candidate.product_type_raw || '') ? 'HUMAN' : 'UNKNOWN';
  const activeIngredients = (candidate.active_ingredients_raw || []).length
    ? candidate.active_ingredients_raw.map(a => ({ name: a.name, strength: a.strength || null }))
    : (match ? [{ name: match.nonproprietary_name }] : []);
  const row = {
    ndc_code: candidate.ndc_code,
    proprietary_name: candidate.proprietary_name || null,
    nonproprietary_name: match ? match.nonproprietary_name : (candidate.nonproprietary_name_raw || candidate.proprietary_name || candidate.ndc_code),
    aliases: match ? match.aliases : [],
    active_ingredients: activeIngredients,
    product_type: productType,
    target_species: productType === 'VET' ? ['dog'] : [], // openFDA/NSDE는 종을 구분하지 않아요 — 강아지 대상 서비스 기준 보수적 기본값. 근거 있으면 직접 넓혀주세요.
    marketing_category: candidate.marketing_category || null,
    dosage_form: candidate.dosage_form || null,
    route: candidate.route || null,
    labeler: candidate.labeler || null,
    drug_class: match ? match.drug_class : null,
    metabolic_pathways: match ? match.metabolic_pathways : {},
    priority: 100,
    is_active: !candidate.is_discontinued,
    source: opts.sourceTag,
    verified: !!match && match.reviewed, // 사업계획서 검토를 거친 성분만 검증됨(=FHIR identifier 노출)으로 표시해요.
    notes: match ? null : 'NEEDS_INGREDIENT_REVIEW: 상표명만으로 수입되어 성분 매칭에 쓰이지 않아요. --ingredients-map 에 항목을 추가해주세요.',
  };
  return { row };
}

/* ---------------- 배치 업서트 (수동 검토 행 보호 + 재시도) ---------------- */
async function upsertBatch(supabase, rows, opts){
  const codes = rows.map(r => r.ndc_code);
  const { data: existing, error: selErr } = await supabase.from('fda_ndc_vet_dictionary').select('ndc_code, source').in('ndc_code', codes);
  if(selErr) throw new Error('기존 행 조회 실패: ' + selErr.message);
  const protectedCodes = new Set((existing || []).filter(r => !OUR_IMPORT_SOURCES.has(r.source)).map(r => r.ndc_code));
  const toWrite = rows.filter(r => !protectedCodes.has(r.ndc_code));
  if(!toWrite.length) return { written: 0, protectedCount: protectedCodes.size };
  let lastErr;
  for(let attempt = 0; attempt <= (opts.maxRetries ?? 5); attempt++){
    const { error } = await supabase.from('fda_ndc_vet_dictionary').upsert(toWrite, { onConflict: 'ndc_code' });
    if(!error) return { written: toWrite.length, protectedCount: protectedCodes.size };
    lastErr = error;
    const transient = /timeout|ECONNRESET|fetch failed|network|too many/i.test(error.message || '') || error.code === '57014';
    if(!transient || attempt === (opts.maxRetries ?? 5)) throw new Error(`배치 upsert 실패(ndc_code 예: ${toWrite[0].ndc_code}): ${error.message}`);
    const wait = Math.min(15000, 500 * Math.pow(2, attempt));
    console.warn(`  [배치 재시도 ${attempt + 1}] ${error.message} — ${wait}ms 후 재시도`);
    await sleep(wait);
  }
  throw lastErr;
}
async function runBatches(supabase, rows, opts){
  const batchSize = parseInt(opts['batch-size'], 10) || 250;
  const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 3);
  const batches = [];
  for(let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));
  let written = 0, protectedCount = 0, failedBatches = [];
  let next = 0;
  async function worker(){
    for(;;){
      const idx = next++;
      if(idx >= batches.length) return;
      try{
        const r = await upsertBatch(supabase, batches[idx], opts);
        written += r.written; protectedCount += r.protectedCount;
        process.stdout.write(`\r  배치 ${idx + 1}/${batches.length} 완료 (기록 ${written}건, 보호되어 건너뜀 ${protectedCount}건)`);
      }catch(e){
        failedBatches.push({ index: idx, size: batches[idx].length, error: e.message });
        console.error(`\n  ❌ 배치 ${idx + 1} 실패: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length || 1) }, worker));
  if(batches.length) process.stdout.write('\n');
  return { written, protectedCount, failedBatches, totalBatches: batches.length };
}

/* ---------------- 메인 ---------------- */
async function main(){
  const opts = parseArgs(process.argv.slice(2));
  if(opts.help || opts.h) usageAndExit();
  opts.source = opts.source || 'openfda-nsde';
  opts.maxRetries = parseInt(opts['max-retries'], 10) || 5;
  opts.timeoutMs = parseInt(opts['timeout-ms'], 10) || 20000;
  opts.apiKey = opts['api-key'] || process.env.OPENFDA_API_KEY || null;
  opts.limit = opts.limit ? parseInt(opts.limit, 10) : null;
  opts.dateFrom = opts['date-from'] || null;
  opts.dateTo = opts['date-to'] || null;
  opts.includeUnmapped = !!opts['include-unmapped'];
  opts.productTypes = opts['product-types'] ? String(opts['product-types']).split(';').map(s => s.trim()).filter(Boolean) : null;
  const dryRun = !!opts['dry-run'];

  const ingredientMapPath = opts['ingredients-map'] || path.join(__dirname, 'vet-ingredient-allowlist.json');
  if(!fs.existsSync(ingredientMapPath)) usageAndExit(`성분 매핑 파일을 찾을 수 없어요: ${ingredientMapPath}`);
  const ingredientMap = loadIngredientMap(ingredientMapPath);
  console.log(`성분 매핑: ${ingredientMapPath} (${new Set([...ingredientMap.values()]).size}개 성분)`);

  let candidates = [], sourceTag;
  if(opts.source === 'openfda-nsde'){
    sourceTag = 'openfda_nsde';
    console.log('\n[1/3] openFDA /other/nsde.json 조회 중 (실제 FDA 동물용 의약품 식별 정보)…');
    candidates = await fetchNsde(opts);
  }else if(opts.source === 'openfda-ndc-directory'){
    sourceTag = 'openfda_ndc_directory';
    console.log('\n[1/3] openFDA /drug/ndc.json 의 동물용 데이터 존재 여부를 먼저 확인해요…');
    const { animalTerms } = await verifyNdcDirectoryHasNoAnimalTypes(opts);
    if(!animalTerms.length){
      console.warn('⚠️  /drug/ndc.json 에는 동물용(ANIMAL) product_type 이 하나도 없어요.');
      console.warn('    FDA 공식 문서: "The NDC Directory does not contain all listed drugs. It does not include animal drugs..."');
      console.warn('    (https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory)');
      console.warn('    실제 수의용 데이터는 --source openfda-nsde 를 쓰세요.');
      if(!opts['allow-empty-veterinary-scope']){
        console.warn('    그래도 이 소스로 계속하려면 --allow-empty-veterinary-scope 를 붙여주세요(예: 사람용 비교 데이터 목적).');
        process.exit(1);
      }
      console.warn('    --allow-empty-veterinary-scope 가 지정되어 계속 진행해요(사람용 데이터로 취급).');
    }else{
      console.log(`  참고: 이 openFDA 배포본에는 동물용 타입이 있어요(${animalTerms.join(', ')}). 계속 진행해요.`);
    }
    console.log('\n[1/3] openFDA /drug/ndc.json 조회 중…');
    candidates = await fetchNdcDirectory(opts);
  }else if(opts.source === 'csv'){
    sourceTag = 'csv_import';
    const csvPath = opts._[0];
    if(!csvPath) usageAndExit('CSV 파일 경로를 지정해주세요: --source csv <path>');
    const mapPath = opts['column-map'];
    if(!mapPath){
      console.error('오류: --column-map <json> 이 필요해요. 예시:');
      console.error(JSON.stringify(buildColumnMapExample(), null, 2));
      process.exit(1);
    }
    const columnMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    console.log(`\n[1/3] CSV 읽는 중: ${csvPath}`);
    const rows = loadCsvRows(csvPath, opts);
    candidates = applyColumnMap(rows, columnMap, opts);
  }else{
    usageAndExit(`알 수 없는 --source: ${opts.source} (openfda-nsde | openfda-ndc-directory | csv)`);
  }

  if(opts.limit) candidates = candidates.slice(0, opts.limit);
  console.log(`  원본 레코드 ${candidates.length}건 확보`);

  console.log('\n[2/3] 스키마 검증 및 성분 매핑 적용 중…');
  const rows = [], skipped = { invalid_ndc_format: 0, unmapped_ingredient: 0 };
  const unmappedSamples = [];
  for(const c of candidates){
    const r = toTableRow(c, ingredientMap, { includeUnmapped: opts.includeUnmapped, sourceTag });
    if(r.skip){
      skipped[r.skip] = (skipped[r.skip] || 0) + 1;
      if(r.skip === 'unmapped_ingredient' && unmappedSamples.length < 10) unmappedSamples.push(c.proprietary_name || c.nonproprietary_name_raw || c.ndc_code);
      continue;
    }
    rows.push(r.row);
  }
  console.log(`  적재 대상 ${rows.length}건 | 형식 오류로 제외 ${skipped.invalid_ndc_format || 0}건 | 매핑 없어 제외 ${skipped.unmapped_ingredient || 0}건`);
  if(unmappedSamples.length) console.log(`  매핑 안 된 상표명 예시: ${unmappedSamples.join(', ')}${skipped.unmapped_ingredient > 10 ? ' …' : ''} (--include-unmapped 로 그래도 가져올 수 있어요)`);

  const byType = rows.reduce((a, r) => { a[r.product_type] = (a[r.product_type] || 0) + 1; return a; }, {});
  console.log(`  product_type 분포: ${JSON.stringify(byType)}`);

  if(dryRun){
    console.log('\n[3/3] --dry-run: DB에 쓰지 않아요. 아래는 실제로 적재될 행의 예시(최대 5건)예요:');
    console.log(JSON.stringify(rows.slice(0, 5), null, 2));
    writeReport(opts.out, { dryRun: true, candidateCount: candidates.length, rowCount: rows.length, skipped, byType });
    return;
  }

  if(!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY){
    console.error('\n오류: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경 변수가 필요해요(server.js 와 동일).');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  console.log(`\n[3/3] Supabase(${process.env.SUPABASE_URL})에 배치 upsert 중 (배치 ${opts['batch-size'] || 250}건 · 동시 ${opts.concurrency || 3})…`);
  const t0 = Date.now();
  const result = await runBatches(supabase, rows, opts);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n=== 완료 ===');
  console.log(`  기록됨: ${result.written}건 | 수동 검토(manual/demo) 행이라 보호되어 건너뜀: ${result.protectedCount}건 | 소요 ${elapsed}s`);
  if(result.failedBatches.length){
    console.log(`  ⚠️ 실패한 배치 ${result.failedBatches.length}/${result.totalBatches}개 (총 ${result.failedBatches.reduce((a, b) => a + b.size, 0)}행 미기록):`);
    result.failedBatches.slice(0, 5).forEach(b => console.log(`     - 배치#${b.index}: ${b.error}`));
  }
  writeReport(opts.out, { dryRun: false, candidateCount: candidates.length, rowCount: rows.length, skipped, byType, ...result, elapsedSeconds: Number(elapsed) });
  if(result.failedBatches.length) process.exit(2);
}
function writeReport(outPath, report){
  report.finishedAt = new Date().toISOString();
  if(outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}

if(require.main === module){
  main().catch(e => { console.error('\n치명적 오류:', e.message); if(process.env.DEBUG) console.error(e.stack); process.exit(1); });
}
module.exports = { parseArgs, normKey, assertNdcFormat, buildSearchQuery, withDateRange, parseNextLink, parseCsv, loadCsvRows, applyColumnMap, loadIngredientMap, resolveIngredient, toTableRow, fetchAllOpenFda, fetchNsde, fetchNdcDirectory, verifyNdcDirectoryHasNoAnimalTypes, upsertBatch, runBatches, OPENFDA_BASE, DEFAULT_VET_PRODUCT_TYPES, OUR_IMPORT_SOURCES };
