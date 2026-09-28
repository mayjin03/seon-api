import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("CRITICAL: SUPABASE_URL 및 SUPABASE_SERVICE_ROLE_KEY 환경 변수가 설정되지 않았습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function fetchOpenFdaVetData() {
  console.log("[1/3] openFDA NSDE / NDC 데이터 수집 시작...");
  
  // 수의용 및 동물용 약물 검색 조건
  const searchTerms = [
    'product_type:*ANIMAL*',
    'product_type:*VET*',
    'product_type:"PRESCRIPTION ANIMAL DRUG"',
    'product_type:"OTC ANIMAL DRUG"'
  ];
  
  const query = encodeURIComponent(searchTerms.join(' OR '));
  let results = [];
  let skip = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore && skip < 5000) {
    const url = `https://api.fda.gov/other/nsde.json?search=${query}&limit=${limit}&skip=${skip}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        // NSDE 엔드포인트 실패 시 일반 NDC 엔드포인트 시도
        const fallbackUrl = `https://api.fda.gov/drug/ndc.json?search=${query}&limit=${limit}&skip=${skip}`;
        const fbRes = await fetch(fallbackUrl);
        if (!fbRes.ok) break;
        const fbData = await fbRes.json();
        if (fbData.results) results.push(...fbData.results);
        if (!fbData.results || fbData.results.length < limit) hasMore = false;
      } else {
        const data = await response.json();
        if (data.results) results.push(...data.results);
        if (!data.results || data.results.length < limit) hasMore = false;
      }
    } catch (err) {
      console.warn(`[WARN] Fetch error at skip ${skip}:`, err.message);
      break;
    }
    skip += limit;
    console.log(`수신 중... 누적 ${results.length}건`);
  }

  console.log(`[+] openFDA에서 총 ${results.length}건의 레코드를 확보했습니다.`);
  return results;
}

function processAndMapRecords(records) {
  console.log("[2/3] 데이터 가공 및 NDC 구조 변환 중...");
  const mapped = [];

  for (const item of records) {
    const rawNdc = item.package_ndc || item.product_ndc || item.ndc_code;
    if (!rawNdc) continue;

    const cleanNdc11 = rawNdc.replace(/[^0-9]/g, '');
    const propName = item.proprietary_name || item.brand_name || null;
    const nonPropName = item.nonproprietary_name || item.generic_name || item.application_number || 'Veterinary Product';
    
    let activeIngredients = [];
    if (Array.isArray(item.active_ingredients)) {
      activeIngredients = item.active_ingredients;
    } else if (item.active_ingredient) {
      activeIngredients = [{ name: item.active_ingredient }];
    } else {
      activeIngredients = [{ name: nonPropName }];
    }

    mapped.push({
      ndc_code: rawNdc,
      ndc_11: cleanNdc11,
      proprietary_name: propName,
      nonproprietary_name: nonPropName,
      aliases: propName ? [propName.toLowerCase()] : [],
      active_ingredients: activeIngredients,
      vet_approved: true,
      data_source: 'openfda_bulk_import'
    });
  }

  console.log(`[+] 총 ${mapped.length}건의 NDC 데이터 변환 완료.`);
  return mapped;
}

async function uploadToSupabase(records) {
  console.log(`[3/3] Supabase fda_ndc_vet_dictionary 테이블에 ${records.length}건 Upsert 중...`);
  
  const batchSize = 100;
  let inserted = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error } = await supabase
      .from('fda_ndc_vet_dictionary')
      .upsert(batch, { onConflict: 'ndc_11' });

    if (error) {
      console.error(`[ERROR] Batch ${i / batchSize + 1} 업로드 실패:`, error.message);
    } else {
      inserted += batch.length;
    }
  }

  console.log(`=== 성공적으로 총 ${inserted}건의 FDA NDC 데이터가 Supabase DB에 적재되었습니다! ===`);
}

async function run() {
  try {
    const rawData = await fetchOpenFdaVetData();
    if (rawData.length === 0) {
      console.log("openFDA에서 가져온 데이터가 없습니다.");
      return;
    }
    const processed = processAndMapRecords(rawData);
    await uploadToSupabase(processed);
  } catch (err) {
    console.error("전체 실행 중 오류 발생:", err);
    process.exit(1);
  }
}

run();
