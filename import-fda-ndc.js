import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("CRITICAL: SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function run() {
  console.log("[1/3] openFDA 수의용 약물 데이터 수집 시작...");
  const url = `https://api.fda.gov/drug/ndc.json?search=finished:true&limit=1000`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`openFDA API 응답 실패 (Status: ${response.status})`);
    }
    
    const data = await response.json();
    const results = data.results || [];
    console.log(`[+] openFDA에서 ${results.length}건 수신 완료.`);

    if (results.length === 0) {
      console.log("적재할 레코드가 없습니다.");
      return;
    }

    console.log("[2/3] 데이터 정제 및 중복 제거 중...");
    const recordMap = new Map();

    for (const item of results) {
      const rawNdc = item.package_ndc || item.product_ndc || item.ndc_code;
      if (!rawNdc) continue;

      const cleanNdc11 = rawNdc.replace(/[^0-9]/g, '');
      const propName = item.proprietary_name || item.brand_name || item.generic_name || "Veterinary Product";
      const nonPropName = item.nonproprietary_name || item.generic_name || propName;

      let ingredients = [];
      if (Array.isArray(item.active_ingredients)) {
        ingredients = item.active_ingredients.map(i => ({ name: i.name, strength: i.strength || '' }));
      } else {
        ingredients = [{ name: nonPropName, strength: '' }];
      }

      // 동일 배치 내 ndc_code 중복 충돌 방지
      recordMap.set(rawNdc, {
        ndc_code: rawNdc,
        ndc_11: cleanNdc11,
        proprietary_name: propName,
        nonproprietary_name: nonPropName,
        aliases: [propName.toLowerCase()],
        active_ingredients: ingredients,
        vet_approved: true,
        data_source: 'openfda_bulk'
      });
    }

    const payload = Array.from(recordMap.values());
    console.log(`[+] 정제 완료된 유일 NDC 항목: ${payload.length}건`);

    console.log("[3/3] Supabase fda_ndc_vet_dictionary 테이블에 배치 Upsert 적재 중...");
    
    // 100건 단위 배치 분할 적재
    const batchSize = 100;
    let totalInserted = 0;

    for (let i = 0; i < payload.length; i += batchSize) {
      const batch = payload.slice(i, i + batchSize);
      const { error } = await supabase
        .from('fda_ndc_vet_dictionary')
        .upsert(batch, { onConflict: 'ndc_code' });

      if (error) {
        console.error(`[ERROR] Batch ${Math.floor(i / batchSize) + 1} 적재 실패:`, error.message);
      } else {
        totalInserted += batch.length;
      }
    }

    console.log(`=== 완료: 총 ${totalInserted}건의 openFDA 레코드가 Supabase DB에 적재되었습니다! ===`);

  } catch (err) {
    console.error("전체 프로세스 오류:", err.message);
    process.exit(1);
  }
}

run();
